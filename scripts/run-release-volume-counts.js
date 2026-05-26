#!/usr/bin/env node
'use strict';

/**
 * Phase 43: public DE volume-count pipeline.
 *
 * Writes only public metadata:
 * - data/release-volume-counts.json
 * - data/release-volume-counts-report.json
 *
 * It derives a safe baseline from high-confidence release-cache entries whose
 * releaseDate is already in the past, then optionally probes the next volume
 * through the existing allowed provider chain. Ambiguous/future/unsafe cases are
 * reported, not written to the public counts file.
 */

const fs = require('fs');
const path = require('path');
const {
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
  isAllowedSourceUrl,
  isRealReleaseDate,
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');
const { checkCandidateSource, getEnabledReleaseProviders } = require('./release-providers');
const { validateReleaseVolumeCounts } = require('./validate-release-volume-counts');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const cacheFile = path.join(dataDir, 'release-cache.json');
const countsFile = path.join(dataDir, 'release-volume-counts.json');
const reportFile = path.join(dataDir, 'release-volume-counts-report.json');
const sourcesFile = path.join(dataDir, 'release-sources.json');
const watchlistFile = path.join(dataDir, 'release-watchlist.json');

const MAX_PLAUSIBLE_JUMP = 3;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonStable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isPastOrToday(dateValue, today = new Date()) {
  if (!isRealReleaseDate(dateValue)) return false;
  const d = new Date(`${dateValue}T00:00:00Z`);
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return d.getTime() <= t.getTime();
}

function sourceSlug(item) {
  return String(item.providerId || item.sourceName || item.source || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function countKey(title, publisher, aliasMap) {
  return `${normalizeTitle(title)}|${normalizePublisher(publisher, aliasMap)}`;
}

function sortItems(items) {
  return items.sort((a, b) =>
    normalizeTitle(a.seriesTitle).localeCompare(normalizeTitle(b.seriesTitle), 'de') ||
    normalizePublisher(a.publisher).localeCompare(normalizePublisher(b.publisher), 'de')
  );
}

function itemFromCacheEntry(entry, aliasMap, checkedAt) {
  return {
    seriesTitle: String(entry.seriesTitle).trim(),
    publisher: String(entry.publisher).trim(),
    publishedVolumesDE: Number(entry.volumeNumber),
    source: sourceSlug(entry),
    sourceUrl: entry.sourceUrl,
    confidence: 'high',
    checkedAt: entry.checkedAt || checkedAt,
  };
}

function buildBaselineFromReleaseCache(cache, sources, aliasMap, checkedAt, today) {
  const byKey = new Map();
  const blocked = [];
  const items = Array.isArray(cache && cache.items) ? cache.items : [];

  for (const entry of items) {
    const title = String(entry && entry.seriesTitle || '').trim();
    const publisher = String(entry && entry.publisher || '').trim();
    const volume = Number(entry && entry.volumeNumber);
    const key = countKey(title, publisher, aliasMap);
    const reasonCodes = [];

    if (!title) reasonCodes.push('missing-title');
    if (!publisher) reasonCodes.push('missing-publisher');
    if (!Number.isInteger(volume) || volume < 1) reasonCodes.push('invalid-volume-number');
    if (entry.confidence !== 'high') reasonCodes.push('not-high-confidence');
    if (!isAllowedSourceUrl(entry.sourceUrl, sources)) reasonCodes.push('source-url-not-allowed');
    if (!isPastOrToday(entry.releaseDate, today)) reasonCodes.push('not-yet-released-or-invalid-date');

    if (reasonCodes.length) {
      if (title && publisher && Number.isInteger(volume)) {
        blocked.push({ seriesTitle: title, publisher, volumeNumber: volume, reasonCodes });
      }
      continue;
    }

    const next = itemFromCacheEntry(entry, aliasMap, checkedAt);
    const current = byKey.get(key);
    if (!current || next.publishedVolumesDE > current.publishedVolumesDE) {
      byKey.set(key, next);
    }
  }

  return { byKey, blocked };
}

function mergeExistingCounts(byKey, existingCounts, aliasMap, checkedAt) {
  const unchangedExisting = [];
  for (const item of Array.isArray(existingCounts && existingCounts.items) ? existingCounts.items : []) {
    const key = countKey(item.seriesTitle, item.publisher, aliasMap);
    const current = byKey.get(key);
    if (!current || Number(item.publishedVolumesDE) > Number(current.publishedVolumesDE)) {
      byKey.set(key, { ...item, checkedAt: item.checkedAt || checkedAt });
      unchangedExisting.push(key);
    }
  }
  return unchangedExisting;
}

function watchlistProbeCandidates(watchlist, currentByKey, aliasMap) {
  const out = [];
  const items = Array.isArray(watchlist && watchlist.items) ? watchlist.items : [];
  for (const entry of items) {
    if (!entry || entry.enabled !== true) continue;
    const title = String(entry.seriesTitle || '').trim();
    const publisher = String(entry.publisher || '').trim();
    if (!title || !publisher) continue;
    const volumes = Array.isArray(entry.volumeNumbers) ? entry.volumeNumbers : [entry.volumeNumber];
    for (const rawVolume of volumes) {
      const volumeNumber = Number(rawVolume);
      if (!Number.isInteger(volumeNumber) || volumeNumber < 1) continue;
      const current = currentByKey.get(countKey(title, publisher, aliasMap));
      const currentCount = current ? Number(current.publishedVolumesDE) : 0;
      if (volumeNumber <= currentCount) continue;
      if (volumeNumber - currentCount > MAX_PLAUSIBLE_JUMP) continue;
      out.push({ origin: 'watchlist', seriesTitle: title, publisher, volumeNumber });
    }
  }
  return out;
}

function nextVolumeProbeCandidates(currentByKey) {
  return [...currentByKey.values()]
    .filter(item => Number.isInteger(item.publishedVolumesDE) && item.publishedVolumesDE >= 0)
    .map(item => ({
      origin: 'release-volume-counts-next',
      seriesTitle: item.seriesTitle,
      publisher: item.publisher,
      volumeNumber: item.publishedVolumesDE + 1,
    }));
}

function dedupeCandidates(candidates, aliasMap) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${countKey(candidate.seriesTitle, candidate.publisher, aliasMap)}|${candidate.volumeNumber}`;
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

function buildChanges(beforeItems, afterItems, aliasMap) {
  const before = new Map((beforeItems || []).map(item => [countKey(item.seriesTitle, item.publisher, aliasMap), item]));
  return (afterItems || [])
    .map(item => {
      const old = before.get(countKey(item.seriesTitle, item.publisher, aliasMap));
      const oldValue = old ? Number(old.publishedVolumesDE) : 0;
      if (Number(item.publishedVolumesDE) <= oldValue) return null;
      return {
        seriesTitle: item.seriesTitle,
        publisher: item.publisher,
        oldPublishedVolumesDE: oldValue,
        newPublishedVolumesDE: Number(item.publishedVolumesDE),
        source: item.source,
        sourceUrl: item.sourceUrl,
        confidence: item.confidence,
      };
    })
    .filter(Boolean);
}

function stripGeneratedAt(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.generatedAt;
  return copy;
}

function stableGeneratedAt(file, doc) {
  if (!fs.existsSync(file)) return doc.generatedAt;
  try {
    const existing = readJson(file);
    if (JSON.stringify(stripGeneratedAt(existing)) === JSON.stringify(stripGeneratedAt(doc))) return existing.generatedAt;
  } catch (_) {}
  return doc.generatedAt;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const providerEnabled = !args.has('--from-cache-only') && process.env.RELEASE_VOLUME_COUNTS_SKIP_PROVIDER !== '1';
  const startedAt = new Date().toISOString();
  const today = new Date(startedAt);
  const sources = readJson(sourcesFile);
  const releaseCache = readJson(cacheFile);
  const existingCounts = fs.existsSync(countsFile) ? readJson(countsFile) : { schemaVersion: 1, generatedAt: startedAt, items: [] };
  const watchlist = fs.existsSync(watchlistFile) ? readJson(watchlistFile) : { items: [] };
  const aliasMap = buildPublisherAliasMap(sources);

  const baseline = buildBaselineFromReleaseCache(releaseCache, sources, aliasMap, startedAt, today);
  mergeExistingCounts(baseline.byKey, existingCounts, aliasMap, startedAt);

  const policy = {
    minDelayMs: Number(process.env.RELEASE_PIPELINE_MIN_DELAY_MS || (sources.requestPolicy && sources.requestPolicy.minDelayMs) || 1200),
    timeoutMs: Number(process.env.RELEASE_PIPELINE_TIMEOUT_MS || (sources.requestPolicy && sources.requestPolicy.timeoutMs) || 12000),
    maxItemsPerSource: Number(process.env.MAX_ITEMS_PER_SOURCE || (sources.requestPolicy && sources.requestPolicy.maxItemsPerSource) || 200),
    userAgent: String((sources.requestPolicy && sources.requestPolicy.userAgent) || 'MangaTrackerReleaseBot/1.0'),
  };

  const probeCandidates = dedupeCandidates([
    ...watchlistProbeCandidates(watchlist, baseline.byKey, aliasMap),
    ...nextVolumeProbeCandidates(baseline.byKey),
  ], aliasMap).slice(0, policy.maxItemsPerSource);

  const applied = [];
  const blocked = [...baseline.blocked];
  const checked = [];

  if (providerEnabled) {
    for (const candidate of probeCandidates) {
      const current = baseline.byKey.get(countKey(candidate.seriesTitle, candidate.publisher, aliasMap));
      const oldCount = current ? Number(current.publishedVolumesDE) : 0;
      const result = await checkCandidateSource(candidate, { sources, aliasMap, policy, checkedAt: startedAt });
      const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
      const released = isPastOrToday(result.releaseDate, today);
      const plausible = Number(result.sourceVolumeNumber || candidate.volumeNumber) - oldCount <= MAX_PLAUSIBLE_JUMP;
      const record = {
        seriesTitle: candidate.seriesTitle,
        publisher: candidate.publisher,
        volumeNumber: candidate.volumeNumber,
        source: sourceSlug(result),
        sourceUrl: result.sourceUrl || null,
        confidence: evaluation.confidence,
        released,
        reasonCodes: evaluation.reasonCodes,
      };
      checked.push(record);

      if (evaluation.confidence === 'high' && released && plausible && candidate.volumeNumber > oldCount) {
        const next = {
          seriesTitle: candidate.seriesTitle,
          publisher: result.sourcePublisher || candidate.publisher,
          publishedVolumesDE: candidate.volumeNumber,
          source: sourceSlug(result),
          sourceUrl: result.sourceUrl,
          confidence: 'high',
          checkedAt: startedAt,
        };
        baseline.byKey.set(countKey(next.seriesTitle, next.publisher, aliasMap), next);
        applied.push({
          seriesTitle: next.seriesTitle,
          publisher: next.publisher,
          oldPublishedVolumesDE: oldCount,
          newPublishedVolumesDE: next.publishedVolumesDE,
          source: next.source,
          sourceUrl: next.sourceUrl,
          confidence: 'high',
        });
      } else if (evaluation.confidence !== 'high' || !released || !plausible) {
        blocked.push({
          seriesTitle: candidate.seriesTitle,
          publisher: candidate.publisher,
          volumeNumber: candidate.volumeNumber,
          reasonCodes: [
            ...evaluation.reasonCodes,
            released ? null : 'not-yet-released',
            plausible ? null : 'implausible-volume-jump',
          ].filter(Boolean),
        });
      }
    }
  }

  const nextItems = sortItems([...baseline.byKey.values()]);
  const nextCounts = {
    schemaVersion: 1,
    generatedAt: startedAt,
    items: nextItems,
  };
  nextCounts.generatedAt = stableGeneratedAt(countsFile, nextCounts);

  const validation = validateReleaseVolumeCounts(nextCounts, { sources });
  if (!validation.ok) {
    throw new Error(`release-volume-counts validation failed: ${validation.errors.join('; ')}`);
  }

  if (JSON.stringify(existingCounts) !== JSON.stringify(nextCounts)) writeJsonStable(countsFile, nextCounts);

  const changes = applied.length ? applied : buildChanges(existingCounts.items || [], nextItems, aliasMap);
  const report = {
    schemaVersion: 1,
    generatedAt: startedAt,
    source: 'run-release-volume-counts.js',
    providerMode: providerEnabled ? 'enabled' : 'from-cache-only',
    policy: {
      maxItemsPerSource: policy.maxItemsPerSource,
      minDelayMs: policy.minDelayMs,
      timeoutMs: policy.timeoutMs,
      activeProviderIds: providerEnabled ? getEnabledReleaseProviders(sources).map(provider => provider.id) : [],
    },
    summary: {
      seriesInVolumeCounts: nextItems.length,
      probeCandidates: providerEnabled ? probeCandidates.length : 0,
      checkedCandidates: checked.length,
      detectedChanges: changes.length,
      appliedHighConfidenceChanges: changes.length,
      blockedOrUnsafe: blocked.length,
    },
    changes,
    blockedCandidates: blocked,
    checkedCandidates: checked,
    changedFilesAllowlist: [
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    privacyGateRequired: true,
  };
  report.generatedAt = stableGeneratedAt(reportFile, report);
  writeJsonStable(reportFile, report);

  console.log('Release-volume-counts pipeline abgeschlossen.');
  console.log(`  Serien: ${nextItems.length}`);
  console.log(`  Geaenderte Bandstaende: ${changes.length}`);
  console.log(`  Blockiert/unsicher: ${blocked.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('run-release-volume-counts fehlgeschlagen:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildBaselineFromReleaseCache,
  buildChanges,
  isPastOrToday,
};
