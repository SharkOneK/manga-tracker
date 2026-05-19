#!/usr/bin/env node
'use strict';

/**
 * run-release-cache-pipeline.js - Phase 25
 *
 * Fully automated, conservative release-cache pipeline:
 * - reads watchlist, source-review queue, app seeds, and current public cache
 * - checks allowed sources (currently the existing Manga-Passion project rule)
 * - writes only high-confidence candidates to data/release-cache.json
 * - routes medium/low/blocked candidates to data/release-source-review-queue.json
 * - writes data/release-cache-pipeline-report.json
 *
 * The script never invents dates and never writes placeholder release dates to
 * the cache. Unsafe candidates remain review-queue entries.
 */

const fs = require('fs');
const path = require('path');
const {
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
  isRealReleaseDate,
  isValidDate,
  isValidHttpUrl,
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const appFile = path.join(repoRoot, 'src', 'app.js');
const cacheFile = path.join(dataDir, 'release-cache.json');
const sourcesFile = path.join(dataDir, 'release-sources.json');
const watchlistFile = path.join(dataDir, 'release-watchlist.json');
const queueFile = path.join(dataDir, 'release-source-review-queue.json');
const reportFile = path.join(dataDir, 'release-cache-pipeline-report.json');

const MP_API = 'https://api.manga-passion.de';
const MP_SOURCE_URL = 'https://www.manga-passion.de';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const PRIORITY_ORDER = new Map([
  ['sehr hoch', 0],
  ['hoch', 1],
  ['mittel', 2],
  ['niedrig', 3],
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonStable(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function normalizeIsbn13(value) {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/[^0-9Xx]/g, '');
  if (/^(978|979)\d{10}$/.test(digits)) return digits;
  return null;
}

function cacheKeyFromParts(seriesTitle, publisher, volumeNumber, aliasMap) {
  return [
    normalizeTitle(seriesTitle),
    normalizePublisher(publisher, aliasMap),
    Number(volumeNumber),
  ].join('|');
}

function cacheKey(item, aliasMap) {
  return cacheKeyFromParts(item.seriesTitle, item.publisher, item.volumeNumber, aliasMap);
}

function queueKey(item) {
  return [
    String(item.seriesTitle || '').trim(),
    String(item.publisher || '').trim(),
    String(item.volumeNumber || '').trim(),
  ].join('|');
}

function isValidCacheItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item) &&
    typeof item.seriesTitle === 'string' && item.seriesTitle.trim() &&
    typeof item.publisher === 'string' && item.publisher.trim() &&
    Number.isInteger(item.volumeNumber) && item.volumeNumber >= 1 &&
    isRealReleaseDate(item.releaseDate) &&
    typeof item.sourceName === 'string' && item.sourceName.trim() &&
    ['high', 'medium', 'low'].includes(item.confidence) &&
    isValidIso(item.checkedAt);
}

function stripCheckedAt(item) {
  const copy = { ...item };
  delete copy.checkedAt;
  return copy;
}

function sortCacheItems(items) {
  return items.sort((a, b) =>
    String(a.normalizedSeriesTitle).localeCompare(String(b.normalizedSeriesTitle), 'de') ||
    String(a.normalizedPublisher).localeCompare(String(b.normalizedPublisher), 'de') ||
    Number(a.volumeNumber) - Number(b.volumeNumber)
  );
}

function sortQueueEntries(a, b) {
  const pa = PRIORITY_ORDER.has(a.priority) ? PRIORITY_ORDER.get(a.priority) : 99;
  const pb = PRIORITY_ORDER.has(b.priority) ? PRIORITY_ORDER.get(b.priority) : 99;
  if (pa !== pb) return pa - pb;
  return String(a.seriesTitle).localeCompare(String(b.seriesTitle), 'de', { sensitivity: 'base' }) ||
    String(a.publisher).localeCompare(String(b.publisher), 'de', { sensitivity: 'base' }) ||
    Number(a.volumeNumber) - Number(b.volumeNumber);
}

function flattenWatchlist(watchlist) {
  const out = [];
  if (!watchlist || !Array.isArray(watchlist.items)) return out;

  for (const entry of watchlist.items) {
    if (!entry || entry.enabled !== true) continue;
    if (typeof entry.seriesTitle !== 'string' || !entry.seriesTitle.trim()) continue;
    if (typeof entry.publisher !== 'string' || !entry.publisher.trim()) continue;

    const volumes = [];
    if ('volumeNumber' in entry && !('volumeNumbers' in entry)) volumes.push(entry.volumeNumber);
    else if ('volumeNumbers' in entry && !('volumeNumber' in entry) && Array.isArray(entry.volumeNumbers)) volumes.push(...entry.volumeNumbers);

    for (const volumeNumber of volumes) {
      if (!Number.isInteger(volumeNumber) || volumeNumber < 1) continue;
      out.push({
        origin: 'watchlist',
        seriesTitle: entry.seriesTitle,
        publisher: entry.publisher,
        volumeNumber,
        sourceUrl: entry.sourceUrl || null,
        notes: entry.notes || '',
        priority: 'mittel',
      });
    }
  }
  return out;
}

function parseValue(body, fieldName) {
  const re = new RegExp(`${fieldName}\\s*:\\s*(?:'((?:\\\\'|[^'])*)'|"((?:\\\\"|[^"])*)"|([^,\\n]+))`);
  const match = body.match(re);
  if (!match) return undefined;
  const raw = match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3]);
  const trimmed = String(raw).trim();
  if (trimmed === 'null') return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function extractUpsertBlocks(appSource) {
  const blocks = [];
  const re = /upsertManga\((['"])(.*?)\1\s*,\s*\{([\s\S]*?)\n\}\);/g;
  let match;
  while ((match = re.exec(appSource))) {
    blocks.push({ key: match[2], body: match[3], line: appSource.slice(0, match.index).split('\n').length });
  }
  return blocks;
}

function extractAppSeedVolume(seed) {
  const fallback = Number(seed.owned) + 1;
  const source = [seed.nextDateLine || '', seed.notes || ''].join(' ').replace(/\s+/g, ' ');
  const announced = /Band\s+(\d{1,3})/i.exec(source);
  if (announced) return Number(announced[1]);
  if (Number.isInteger(fallback) && fallback > 0) return fallback;
  return null;
}

function loadAppSeedCandidates() {
  if (!fs.existsSync(appFile)) return [];
  const appSource = fs.readFileSync(appFile, 'utf8');
  const candidates = [];

  for (const block of extractUpsertBlocks(appSource)) {
    const nextDate = parseValue(block.body, 'nextDate');
    if (!nextDate || !isValidDate(nextDate)) continue;
    const seriesTitle = parseValue(block.body, 'title');
    const publisher = parseValue(block.body, 'pub');
    if (!seriesTitle || !publisher) continue;
    const seed = {
      owned: parseValue(block.body, 'owned'),
      nextDate,
      notes: parseValue(block.body, 'notes') || '',
      nextDateLine: (block.body.match(/nextDate\s*:[^\n]*/) || [''])[0],
    };
    const volumeNumber = extractAppSeedVolume(seed);
    if (!Number.isInteger(volumeNumber) || volumeNumber < 1) continue;
    candidates.push({
      origin: 'app-seed',
      seriesTitle,
      publisher,
      volumeNumber,
      seedReleaseDate: nextDate,
      notes: `src/app.js Seed ${JSON.stringify(block.key)}`,
      priority: 'niedrig',
    });
  }
  return candidates;
}

function loadReviewQueueCandidates(queueDoc) {
  if (!queueDoc || !Array.isArray(queueDoc.queue)) return [];
  return queueDoc.queue
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      origin: 'review-queue',
      seriesTitle: entry.seriesTitle,
      publisher: entry.publisher,
      volumeNumber: entry.volumeNumber,
      releaseDate: entry.releaseDate || null,
      sourceUrl: entry.sourceUrl || null,
      sourceName: entry.sourceName || null,
      sourceEditionTitle: entry.sourceEditionTitle || null,
      sourcePublisher: entry.sourcePublisher || null,
      evidence: entry.evidence || entry.sourceAnalysisEvidence || '',
      notes: entry.notes || '',
      priority: entry.priority || 'hoch',
      existingQueueEntry: entry,
    }));
}

function dedupeCandidates(candidates, aliasMap) {
  const priority = new Map([['review-queue', 0], ['watchlist', 1], ['app-seed', 2]]);
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!candidate.seriesTitle || !candidate.publisher || !Number.isInteger(candidate.volumeNumber)) continue;
    const key = cacheKey(candidate, aliasMap);
    const current = byKey.get(key);
    if (!current || (priority.get(candidate.origin) || 99) < (priority.get(current.origin) || 99)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function publisherNames(edition) {
  return Array.isArray(edition && edition.publishers)
    ? edition.publishers.map(p => p && p.name).filter(Boolean)
    : [];
}

function scoreEdition(seed, edition, aliasMap) {
  const seedTitle = normalizeTitle(seed.seriesTitle);
  const editionTitle = normalizeTitle(edition && edition.title);
  const seedPublisher = normalizePublisher(seed.publisher, aliasMap);
  const editionPublishers = publisherNames(edition).map(name => normalizePublisher(name, aliasMap));
  let score = 0;
  if (editionTitle === seedTitle) score += 60;
  else if (editionTitle.includes(seedTitle) || seedTitle.includes(editionTitle)) score += 35;
  else {
    const seedTokens = new Set(seedTitle.split(' ').filter(token => token.length > 2));
    const hitTokens = editionTitle.split(' ').filter(token => seedTokens.has(token)).length;
    score += Math.min(25, hitTokens * 8);
  }
  if (editionPublishers.includes(seedPublisher)) score += 30;
  if (edition && edition.print === true) score += 10;
  if (edition && edition.digital === true) score -= 15;
  if (/ebook|e book|light novel|novel|roman|artbook|kochbuch|wimmelbuch/i.test(String(edition && edition.title || ''))) score -= 30;
  if (Number(edition && edition.numVolumes) >= Number(seed.volumeNumber)) score += 5;
  return score;
}

function dateFromMpVolumeRaw(volume) {
  if (!volume) return null;
  if (Number.isInteger(volume.year) && Number.isInteger(volume.month) && Number.isInteger(volume.day)) {
    return `${String(volume.year).padStart(4, '0')}-${String(volume.month).padStart(2, '0')}-${String(volume.day).padStart(2, '0')}`;
  }
  if (typeof volume.date === 'string' && volume.date.length >= 10) return volume.date.slice(0, 10);
  return null;
}

async function fetchJson(url, policy) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': policy.userAgent,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tryMangaPassion(candidate, aliasMap, policy) {
  const base = {
    ...candidate,
    sourceName: 'Manga Passion',
    sourceUrl: MP_SOURCE_URL,
  };

  try {
    const searchUrl = `${MP_API}/editions?search=${encodeURIComponent(candidate.seriesTitle)}&itemsPerPage=8`;
    const hits = await fetchJson(searchUrl, policy);
    await sleep(policy.minDelayMs);
    if (!Array.isArray(hits) || hits.length === 0) {
      return { ...base, sourceResult: 'no-edition-found', sourceFetchFailed: false };
    }

    const scored = hits
      .map(edition => ({ edition, score: scoreEdition(candidate, edition, aliasMap) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 60) {
      return { ...base, sourceResult: `edition-match-too-weak:${best ? best.score : 0}` };
    }

    const expectedTitle = normalizeTitle(candidate.seriesTitle);
    const expectedPublisher = normalizePublisher(candidate.publisher, aliasMap);
    const exactEditionMatches = scored.filter(({ edition }) => {
      const titleMatches = normalizeTitle(edition && edition.title) === expectedTitle;
      const publishers = publisherNames(edition).map(name => normalizePublisher(name, aliasMap));
      return titleMatches && publishers.includes(expectedPublisher) && edition.print === true;
    });

    const volumesUrl = `${MP_API}/editions/${best.edition.id}/volumes?itemsPerPage=300`;
    const volumes = await fetchJson(volumesUrl, policy);
    await sleep(policy.minDelayMs);
    if (!Array.isArray(volumes) || volumes.length === 0) {
      return {
        ...base,
        sourceEditionId: best.edition.id,
        sourceEditionTitle: best.edition.title || null,
        sourcePublisher: publisherNames(best.edition)[0] || null,
        sourceUrl: `${MP_SOURCE_URL}/editions/${best.edition.id}`,
        sourceResult: 'no-volumes-found',
      };
    }

    const volume = volumes.find(item => Number(item.number) === Number(candidate.volumeNumber));
    if (!volume) {
      return {
        ...base,
        sourceEditionId: best.edition.id,
        sourceEditionTitle: best.edition.title || null,
        sourcePublisher: publisherNames(best.edition)[0] || null,
        sourceUrl: `${MP_SOURCE_URL}/editions/${best.edition.id}`,
        sourceResult: 'volume-not-found',
        sourceVolumeNumber: null,
      };
    }

    const releaseDate = dateFromMpVolumeRaw(volume);
    return {
      ...base,
      releaseDate,
      isbn13: normalizeIsbn13(volume.isbn13 || volume.isbn || null),
      coverUrl: isValidHttpUrl(volume.cover) ? volume.cover : (isValidHttpUrl(best.edition.cover) ? best.edition.cover : null),
      sourceUrl: `${MP_SOURCE_URL}/editions/${best.edition.id}`,
      sourceEditionId: best.edition.id,
      sourceEditionTitle: best.edition.title || null,
      sourcePublisher: publisherNames(best.edition)[0] || null,
      sourceVolumeNumber: Number(volume.number),
      sourceVolumeSpecialType: volume.specialType || null,
      sourceScore: best.score,
      ambiguousEdition: exactEditionMatches.length > 1,
      sourceResult: 'volume-found',
    };
  } catch (error) {
    return {
      ...base,
      sourceFetchFailed: true,
      sourceResult: `fetch-error:${error.message}`,
      sourceError: error.message,
    };
  }
}

function sourceConfigEnabled(sources, sourceId) {
  return Array.isArray(sources && sources.sources) && sources.sources.some(source => source.id === sourceId && source.enabled !== false);
}

async function checkCandidateSource(candidate, context) {
  const { sources, aliasMap, policy } = context;

  if (candidate.releaseDate && candidate.sourceUrl && candidate.sourceName) {
    return { ...candidate };
  }

  if (sourceConfigEnabled(sources, 'manga-passion')) {
    return tryMangaPassion(candidate, aliasMap, policy);
  }

  return {
    ...candidate,
    sourceFetchFailed: true,
    sourceResult: 'no-enabled-source',
  };
}

function candidateToCacheItem(candidate, aliasMap, checkedAt) {
  return {
    seriesTitle: candidate.seriesTitle,
    normalizedSeriesTitle: normalizeTitle(candidate.seriesTitle),
    publisher: candidate.sourcePublisher || candidate.publisher,
    normalizedPublisher: normalizePublisher(candidate.sourcePublisher || candidate.publisher, aliasMap),
    volumeNumber: Number(candidate.volumeNumber),
    releaseDate: candidate.releaseDate,
    isbn13: normalizeIsbn13(candidate.isbn13),
    coverUrl: candidate.coverUrl || null,
    sourceUrl: candidate.sourceUrl,
    sourceName: candidate.sourceName,
    confidence: 'high',
    notes: `Automatisch per Release-Cache-Pipeline bestätigt (${candidate.sourceName}${candidate.sourceEditionId ? ` Edition ${candidate.sourceEditionId}` : ''}, Band ${candidate.volumeNumber}). Ursprung: ${candidate.origin}.`,
    checkedAt,
  };
}

function sameCacheContent(a, b) {
  return JSON.stringify(stripCheckedAt(a)) === JSON.stringify(stripCheckedAt(b));
}

function makeQueueEntry(candidate, evaluation, checkedAt, existing) {
  const safeToPatch = evaluation.confidence === 'high';
  const releaseDateForQueue = isRealReleaseDate(candidate.releaseDate) ? candidate.releaseDate : null;
  const evidence = [
    `Automatische Quellenprüfung: ${candidate.sourceResult || 'Quelle geprüft'}.`,
    `Confidence: ${evaluation.confidence}.`,
    evaluation.reasonCodes.length ? `Gruende: ${evaluation.reasonCodes.join(', ')}.` : 'Alle High-Confidence-Regeln erfüllt.',
    candidate.sourceEditionId ? `Edition: ${candidate.sourceEditionId}.` : '',
    candidate.sourceScore != null ? `Score: ${candidate.sourceScore}.` : '',
  ].filter(Boolean).join(' ');

  const base = existing && typeof existing === 'object' ? { ...existing } : {
    queueKey: queueKey(candidate),
    seriesTitle: candidate.seriesTitle,
    publisher: candidate.publisher,
    volumeNumber: candidate.volumeNumber,
    classification: candidate.origin === 'review-queue' ? 'source-data-gap' : 'automated-source-check',
    suspectedCause: evaluation.reviewStatus,
    priority: candidate.priority || 'mittel',
    recommendedFix: 'manual-source-review',
    manualSourceReviewNeeded: true,
    checkedSources: [],
    sourceAnalysisEvidence: '',
    safeToPatch: false,
    reviewStatus: 'pending',
    sourceUrl: null,
    releaseDate: null,
    checkedAt: null,
    evidence: '',
    notes: '',
  };

  const next = {
    ...base,
    queueKey: base.queueKey || queueKey(candidate),
    seriesTitle: base.seriesTitle || candidate.seriesTitle,
    publisher: base.publisher || candidate.publisher,
    volumeNumber: base.volumeNumber || candidate.volumeNumber,
    suspectedCause: base.suspectedCause || evaluation.reviewStatus,
    recommendedFix: base.recommendedFix || 'manual-source-review',
    manualSourceReviewNeeded: true,
    safeToPatch,
    reviewStatus: safeToPatch ? 'patched' : evaluation.reviewStatus,
    sourceUrl: candidate.sourceUrl || null,
    releaseDate: releaseDateForQueue,
    checkedAt,
    evidence,
    notes: safeToPatch
      ? 'Automatisch in data/release-cache.json übernommen.'
      : 'Automatisch geprüft; nicht sicher genug für den öffentlichen Cache.',
    sourceConfidence: evaluation.confidence,
    sourceName: candidate.sourceName || null,
    sourceEditionId: candidate.sourceEditionId || null,
    sourceEditionTitle: candidate.sourceEditionTitle || null,
    sourcePublisher: candidate.sourcePublisher || null,
    sourceVolumeNumber: candidate.sourceVolumeNumber == null ? null : candidate.sourceVolumeNumber,
    sourceResult: candidate.sourceResult || null,
    confidenceReasons: evaluation.reasonCodes,
  };

  if (existing) {
    const currentComparable = { ...next, checkedAt: existing.checkedAt };
    const existingComparable = { ...existing, checkedAt: existing.checkedAt };
    if (JSON.stringify(currentComparable) === JSON.stringify(existingComparable)) {
      next.checkedAt = existing.checkedAt;
    }
  }

  return next;
}

function updateReviewQueue(queueDoc, queueEntries) {
  const existingQueue = queueDoc && Array.isArray(queueDoc.queue) ? queueDoc.queue : [];
  const byKey = new Map(existingQueue.map(entry => [queueKey(entry), entry]));
  for (const entry of queueEntries) byKey.set(queueKey(entry), entry);
  const queue = [...byKey.values()].sort(sortQueueEntries);
  const safeToPatch = queue.filter(entry => entry.safeToPatch === true).length;
  const pendingManualReview = queue.filter(entry => entry.manualSourceReviewNeeded === true && entry.safeToPatch !== true).length;
  const autoReviewed = queue.filter(entry => typeof entry.reviewStatus === 'string' && entry.reviewStatus.startsWith('auto-')).length;

  return {
    ...(queueDoc && typeof queueDoc === 'object' ? queueDoc : {}),
    schemaVersion: 1,
    summary: {
      ...((queueDoc && queueDoc.summary) || {}),
      totalGaps: queue.length,
      safeToPatch,
      pendingManualReview,
      autoReviewed,
      patched: queue.filter(entry => entry.reviewStatus === 'patched').length,
    },
    queue,
  };
}

function stripReportGeneratedAt(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generatedAt;
  return copy;
}

function stableReportGeneratedAt(report) {
  if (!fs.existsSync(reportFile)) return report.generatedAt;
  try {
    const existing = readJson(reportFile);
    if (JSON.stringify(stripReportGeneratedAt(existing)) === JSON.stringify(stripReportGeneratedAt(report))) {
      return existing.generatedAt;
    }
  } catch (_) {
    // ignore corrupt previous report; validator will check the newly written one
  }
  return report.generatedAt;
}

async function main() {
  const startedAt = new Date().toISOString();
  const sources = readJson(sourcesFile);
  const watchlist = readJson(watchlistFile);
  const existingCache = readJson(cacheFile);
  const existingQueue = readJson(queueFile);
  const aliasMap = buildPublisherAliasMap(sources);
  const policy = {
    minDelayMs: Number(process.env.RELEASE_PIPELINE_MIN_DELAY_MS || (sources.requestPolicy && sources.requestPolicy.minDelayMs) || 1200),
    timeoutMs: Number(process.env.RELEASE_PIPELINE_TIMEOUT_MS || (sources.requestPolicy && sources.requestPolicy.timeoutMs) || 12000),
    maxItemsPerSource: Number(process.env.MAX_ITEMS_PER_SOURCE || (sources.requestPolicy && sources.requestPolicy.maxItemsPerSource) || 200),
    userAgent: String((sources.requestPolicy && sources.requestPolicy.userAgent) || 'MangaTrackerReleaseBot/1.0'),
  };

  const cacheItems = Array.isArray(existingCache.items) ? existingCache.items : [];
  const cacheByKey = new Map();
  const invalidExistingCache = [];
  for (const item of cacheItems) {
    if (!isValidCacheItem(item)) {
      invalidExistingCache.push(item && item.seriesTitle ? item.seriesTitle : '<unbekannt>');
      continue;
    }
    cacheByKey.set(cacheKey(item, aliasMap), {
      ...item,
      normalizedSeriesTitle: normalizeTitle(item.seriesTitle),
      normalizedPublisher: normalizePublisher(item.publisher, aliasMap),
      isbn13: normalizeIsbn13(item.isbn13),
      coverUrl: item.coverUrl || null,
      sourceUrl: item.sourceUrl || null,
      notes: item.notes ?? null,
    });
  }

  const rawCandidates = dedupeCandidates([
    ...loadReviewQueueCandidates(existingQueue),
    ...flattenWatchlist(watchlist),
    ...loadAppSeedCandidates(),
  ], aliasMap);

  const skippedAlreadyCached = [];
  const candidatesToCheck = [];
  for (const candidate of rawCandidates) {
    const key = cacheKey(candidate, aliasMap);
    const existing = cacheByKey.get(key);
    if (existing && existing.confidence === 'high' && candidate.origin !== 'review-queue') {
      skippedAlreadyCached.push(key);
    } else {
      candidatesToCheck.push(candidate);
    }
  }

  const boundedCandidates = candidatesToCheck.slice(0, policy.maxItemsPerSource);
  const skippedDueToLimit = candidatesToCheck.length - boundedCandidates.length;
  const evaluations = [];
  const queuePatchByKey = new Map();
  const cachePatches = [];
  const blockedCandidates = [];
  const existingQueueByKey = new Map((existingQueue.queue || []).map(entry => [queueKey(entry), entry]));

  console.log(`Release-Cache-Pipeline: pruefe ${boundedCandidates.length} Kandidat(en), Limit ${policy.maxItemsPerSource}`);

  for (const seed of boundedCandidates) {
    const checked = await checkCandidateSource(seed, { sources, aliasMap, policy });
    const evaluation = evaluateReleaseCandidate(checked, { sources, aliasMap });
    const key = cacheKey(checked, aliasMap);
    const queueEntryKey = queueKey(checked);
    const evaluationRecord = {
      key,
      queueKey: queueEntryKey,
      origin: checked.origin,
      seriesTitle: checked.seriesTitle,
      publisher: checked.publisher,
      volumeNumber: checked.volumeNumber,
      sourceName: checked.sourceName || null,
      sourceUrl: checked.sourceUrl || null,
      releaseDate: isRealReleaseDate(checked.releaseDate) ? checked.releaseDate : null,
      confidence: evaluation.confidence,
      reviewStatus: evaluation.reviewStatus,
      reasonCodes: evaluation.reasonCodes,
      sourceResult: checked.sourceResult || null,
    };
    evaluations.push(evaluationRecord);

    if (evaluation.confidence === 'high') {
      const cacheItem = candidateToCacheItem(checked, aliasMap, startedAt);
      const existing = cacheByKey.get(key);
      if (!existing || !sameCacheContent(existing, cacheItem)) {
        if (existing && existing.confidence === 'high') {
          // A high-confidence existing cache entry wins; do not churn a curated value.
        } else {
          if (existing && sameCacheContent({ ...existing, confidence: 'high' }, cacheItem)) {
            cacheItem.checkedAt = existing.checkedAt;
          }
          cacheByKey.set(key, cacheItem);
          cachePatches.push({
            action: existing ? 'update' : 'add',
            key,
            seriesTitle: cacheItem.seriesTitle,
            publisher: cacheItem.publisher,
            volumeNumber: cacheItem.volumeNumber,
            releaseDate: cacheItem.releaseDate,
            sourceName: cacheItem.sourceName,
            sourceUrl: cacheItem.sourceUrl,
            confidence: 'high',
          });
        }
      }

      const existingQueueEntry = existingQueueByKey.get(queueEntryKey);
      if (existingQueueEntry) {
        queuePatchByKey.set(queueEntryKey, makeQueueEntry(checked, evaluation, startedAt, existingQueueEntry));
      }
    } else {
      const existingQueueEntry = existingQueueByKey.get(queueEntryKey);
      queuePatchByKey.set(queueEntryKey, makeQueueEntry(checked, evaluation, startedAt, existingQueueEntry));
      if (evaluation.confidence === 'blocked') blockedCandidates.push(evaluationRecord);
    }
  }

  const nextCacheItems = sortCacheItems([...cacheByKey.values()]);
  const nextCache = {
    schemaVersion: 1,
    generatedAt: cachePatches.length ? startedAt : existingCache.generatedAt,
    source: 'run-release-cache-pipeline.js',
    itemCount: nextCacheItems.length,
    items: nextCacheItems,
  };
  if (JSON.stringify(existingCache) !== JSON.stringify(nextCache)) writeJsonStable(cacheFile, nextCache);

  const nextQueue = updateReviewQueue(existingQueue, [...queuePatchByKey.values()]);
  if (JSON.stringify(existingQueue) !== JSON.stringify(nextQueue)) writeJsonStable(queueFile, nextQueue);

  const counts = { high: 0, medium: 0, low: 0, blocked: 0 };
  for (const evaluation of evaluations) counts[evaluation.confidence]++;

  const reviewQueueWrites = evaluations
    .filter(item => item.confidence !== 'high')
    .map(item => ({
      key: item.key,
      queueKey: item.queueKey,
      seriesTitle: item.seriesTitle,
      publisher: item.publisher,
      volumeNumber: item.volumeNumber,
      confidence: item.confidence,
      reviewStatus: item.reviewStatus,
      reasonCodes: item.reasonCodes,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      releaseDate: item.releaseDate,
      sourceResult: item.sourceResult,
    }));

  const report = {
    schemaVersion: 1,
    generatedAt: startedAt,
    source: 'run-release-cache-pipeline.js',
    inputs: {
      cacheItems: cacheItems.length,
      watchlistCandidates: flattenWatchlist(watchlist).length,
      reviewQueueCandidates: loadReviewQueueCandidates(existingQueue).length,
      appSeedCandidates: loadAppSeedCandidates().length,
    },
    policy: {
      maxItemsPerSource: policy.maxItemsPerSource,
      minDelayMs: policy.minDelayMs,
      timeoutMs: policy.timeoutMs,
      allowedSourceIds: (sources.sources || []).filter(source => source.enabled !== false).map(source => source.id),
    },
    summary: {
      candidatesDiscovered: rawCandidates.length,
      candidatesChecked: evaluations.length,
      skippedAlreadyCached: skippedAlreadyCached.length,
      skippedDueToLimit,
      highConfidence: counts.high,
      mediumConfidence: counts.medium,
      lowConfidence: counts.low,
      blocked: counts.blocked,
      cachePatches: cachePatches.length,
      reviewQueueWrites: reviewQueueWrites.length,
      invalidExistingCache: invalidExistingCache.length,
    },
    autoMergeEligible: cachePatches.length > 0 && reviewQueueWrites.length === 0 && blockedCandidates.length === 0 && cachePatches.every(patch => patch.confidence === 'high'),
    cachePatches,
    reviewQueueWrites,
    blockedCandidates,
    skippedAlreadyCached,
    invalidExistingCache,
  };
  report.generatedAt = stableReportGeneratedAt(report);
  writeJsonStable(reportFile, report);

  console.log('Release-Cache-Pipeline abgeschlossen.');
  console.log(`  Kandidaten: ${report.summary.candidatesChecked}/${report.summary.candidatesDiscovered}`);
  console.log(`  High: ${counts.high}, Medium: ${counts.medium}, Low: ${counts.low}, Blocked: ${counts.blocked}`);
  console.log(`  Cache-Patches: ${cachePatches.length}`);
  console.log(`  Review-Queue-Routen: ${reviewQueueWrites.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('run-release-cache-pipeline fehlgeschlagen:', error);
    process.exitCode = 1;
  });
}
