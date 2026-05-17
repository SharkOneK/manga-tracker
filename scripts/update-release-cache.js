'use strict';

/**
 * update-release-cache.js — Phase 15e
 *
 * Rebuilds data/release-cache.json from safe, bounded inputs:
 * - existing valid cache entries
 * - current app seed data in src/app.js where nextDate is explicitly set
 * - optional server-side Manga-Passion checks for those seed candidates
 *
 * No external dependencies. No crawling. No browser app changes.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const cacheFile = path.join(repoRoot, 'data', 'release-cache.json');
const sourcesFile = path.join(repoRoot, 'data', 'release-sources.json');
const appFile = path.join(repoRoot, 'src', 'app.js');
const MP_API = 'https://api.manga-passion.de';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

const DEFAULT_PUBLISHER_ALIASES = new Map([
  ['carlsen', 'carlsen manga'],
  ['carlsen manga', 'carlsen manga'],
  ['carlsen manga!', 'carlsen manga'],
  ['tokyo pop', 'tokyopop'],
  ['tokyopop', 'tokyopop'],
  ['tokyo-pop', 'tokyopop'],
  ['kaze manga', 'crunchyroll manga'],
  ['kazé manga', 'crunchyroll manga'],
  ['kaze', 'crunchyroll manga'],
  ['kazé', 'crunchyroll manga'],
  ['crunchyroll', 'crunchyroll manga'],
  ['crunchyroll manga', 'crunchyroll manga'],
  ['panini', 'panini manga'],
  ['planet manga', 'panini manga'],
  ['panini manga', 'panini manga'],
]);

const stats = {
  existingInput: 0,
  existingKept: 0,
  appSeedsFound: 0,
  appSeedsAddedOrKept: 0,
  mpConfirmed: 0,
  mpUsedInOutput: 0,
  invalidExisting: [],
  uncertain: [],
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normalizeBase(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function normalizeTitle(value) {
  return normalizeBase(value)
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublisher(value, aliasMap) {
  const normalized = normalizeBase(value)
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return (aliasMap || DEFAULT_PUBLISHER_ALIASES).get(normalized) || normalized;
}

function normalizeIsbn13(value) {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/[^0-9Xx]/g, '');
  if (/^(978|979)\d{10}$/.test(digits)) return digits;
  return null;
}

function isValidHttpsUrl(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const [year, month, day] = value.split('-').map(Number);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isValidIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function buildAliasMap(sources) {
  const map = new Map(DEFAULT_PUBLISHER_ALIASES);
  if (sources && Array.isArray(sources.sources)) {
    for (const source of sources.sources) {
      const aliases = Array.isArray(source.publisherAliases) ? source.publisherAliases : [];
      const canonical = aliases[aliases.length - 1] || source.name;
      const normalizedCanonical = normalizePublisher(canonical, map) || normalizeTitle(canonical);
      for (const alias of aliases) {
        const key = normalizeBase(alias).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (key && normalizedCanonical) map.set(key, normalizedCanonical);
      }
    }
  }
  return map;
}

function cacheKey(item) {
  return [item.normalizedSeriesTitle, item.normalizedPublisher, item.volumeNumber].join('|');
}

function validCacheItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const requiredStrings = ['seriesTitle', 'normalizedSeriesTitle', 'publisher', 'normalizedPublisher', 'sourceName'];
  if (!requiredStrings.every(field => typeof item[field] === 'string' && item[field].trim())) return false;
  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) return false;
  if (!isValidDate(item.releaseDate)) return false;
  if (!VALID_CONFIDENCE.has(item.confidence)) return false;
  if (!isValidIso(item.checkedAt)) return false;
  if (item.isbn13 !== null && item.isbn13 !== undefined && !normalizeIsbn13(item.isbn13)) return false;
  if (!isValidHttpsUrl(item.coverUrl)) return false;
  if (!isValidHttpsUrl(item.sourceUrl)) return false;
  if (item.notes !== null && item.notes !== undefined && typeof item.notes !== 'string') return false;
  return true;
}

function parseValue(body, fieldName) {
  const re = new RegExp(`${fieldName}\\s*:\\s*(?:'((?:\\\\'|[^'])*)'|"((?:\\\\"|[^"])*)"|([^,\\n]+))`);
  const m = body.match(re);
  if (!m) return undefined;
  const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  if (raw === undefined) return undefined;
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

function datePatternsForSeed(seedDate) {
  if (!isValidDate(seedDate)) return [];
  const [yyyy, mm, dd] = seedDate.split('-');
  return [
    yyyy + '[-.]' + mm + '[-.]' + dd,
    dd + '[.]' + mm + '[.]' + yyyy,
    dd + '[.]' + mm + '[.]' + yyyy.slice(2),
  ];
}

function extractVolumeNumber(seed) {
  const fallback = Number(seed.owned) + 1;
  const source = [seed.nextDateLine || '', seed.notes || ''].join(' ');
  const compactSource = source.replace(/\s+/g, ' ');

  // Prefer explicit mentions where the same date and the band number appear close
  // together. This avoids using owned+1 for double-volume editions or skipped
  // already-available volumes.
  for (const datePattern of datePatternsForSeed(seed.nextDate)) {
    const bandBeforeDate = new RegExp('Band\\s+(\\d{1,3})[^.!?\\n]{0,120}' + datePattern, 'i').exec(compactSource);
    if (bandBeforeDate) return Number(bandBeforeDate[1]);
    const dateBeforeBand = new RegExp(datePattern + '[^.!?\\n]{0,120}Band\\s+(\\d{1,3})', 'i').exec(compactSource);
    if (dateBeforeBand) return Number(dateBeforeBand[1]);
  }

  // If no exact date string is present, accept conservative future-announcement
  // phrasing. Keep this intentionally narrow.
  const announced = /Band\s+(\d{1,3})\s+(?:\(DE\)\s+)?(?:erscheint|angekuendigt|angek?ndigt|angek\.|ca\.|wahrsch\.|im|fuer|f?r|~)/i.exec(compactSource);
  if (announced) return Number(announced[1]);

  if (Number.isInteger(fallback) && fallback > 0) return fallback;
  return 1;
}

function extractAppSeedItems(aliasMap, checkedAt) {
  const appSource = fs.readFileSync(appFile, 'utf8');
  const blocks = extractUpsertBlocks(appSource);
  const items = [];

  for (const block of blocks) {
    const nextDate = parseValue(block.body, 'nextDate');
    if (!nextDate || !isValidDate(nextDate)) continue;

    const title = parseValue(block.body, 'title');
    const publisher = parseValue(block.body, 'pub');
    if (!title || !publisher) {
      stats.uncertain.push(`${block.key}: nextDate vorhanden, aber title/pub fehlt`);
      continue;
    }

    const seed = {
      key: block.key,
      title,
      publisher,
      owned: parseValue(block.body, 'owned'),
      total: parseValue(block.body, 'total'),
      ongoing: parseValue(block.body, 'ongoing'),
      nextDate,
      notes: parseValue(block.body, 'notes') || null,
      nextDateLine: (block.body.match(/nextDate\s*:[^\n]*/) || [''])[0],
      line: block.line,
    };
    const volumeNumber = extractVolumeNumber(seed);
    if (!Number.isInteger(volumeNumber) || volumeNumber < 1) {
      stats.uncertain.push(`${title}: konnte volumeNumber nicht sicher bestimmen`);
      continue;
    }

    items.push({
      kind: 'app-seed',
      seed,
      item: {
        seriesTitle: title,
        normalizedSeriesTitle: normalizeTitle(title),
        publisher,
        normalizedPublisher: normalizePublisher(publisher, aliasMap),
        volumeNumber,
        releaseDate: nextDate,
        isbn13: null,
        coverUrl: null,
        sourceUrl: null,
        sourceName: 'app-seed',
        confidence: 'medium',
        notes: `Aus src/app.js Seed ${JSON.stringify(block.key)} übernommen; nicht extern bestätigt.`,
        checkedAt,
      }
    });
  }

  stats.appSeedsFound = items.length;
  return items;
}

function itemScore(item) {
  if (item.sourceName === 'Manga Passion' && item.confidence === 'high') return 90;
  if (item.sourceName === 'Manga Passion' && item.confidence === 'medium') return 70;
  if (item.confidence === 'high') return 80;
  if (item.sourceName === 'app-seed') return 40;
  if (item.confidence === 'medium') return 50;
  return 10;
}

function mergeCandidate(map, candidate, origin) {
  const key = cacheKey(candidate);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return true;
  }

  // Preserve existing curated/manual entries unless a clearly better MP confirmation
  // replaces only a lower-confidence/app-seed duplicate.
  const existingIsAppSeed = existing.sourceName === 'app-seed';
  const candidateIsMpHigh = candidate.sourceName === 'Manga Passion' && candidate.confidence === 'high';
  if (candidateIsMpHigh && (existingIsAppSeed || existing.confidence !== 'high')) {
    map.set(key, candidate);
    return true;
  }

  if (origin === 'existing') return false;
  if (itemScore(candidate) > itemScore(existing) && existing.sourceName === 'app-seed') {
    map.set(key, candidate);
    return true;
  }
  return false;
}

function publisherNames(edition) {
  return Array.isArray(edition && edition.publishers)
    ? edition.publishers.map(p => p && p.name).filter(Boolean)
    : [];
}

function scoreEdition(seed, edition, aliasMap) {
  const seedTitle = normalizeTitle(seed.title);
  const editionTitle = normalizeTitle(edition && edition.title);
  const seedPublisher = normalizePublisher(seed.publisher, aliasMap);
  const editionPublishers = publisherNames(edition).map(p => normalizePublisher(p, aliasMap));

  let score = 0;
  if (editionTitle === seedTitle) score += 60;
  else if (editionTitle.includes(seedTitle) || seedTitle.includes(editionTitle)) score += 40;
  else {
    const seedTokens = new Set(seedTitle.split(' ').filter(t => t.length > 2));
    const hitTokens = editionTitle.split(' ').filter(t => seedTokens.has(t)).length;
    score += Math.min(25, hitTokens * 8);
  }

  if (editionPublishers.includes(seedPublisher)) score += 30;
  if (edition && edition.print === true) score += 10;
  if (edition && edition.digital === true) score -= 15;
  if (/ebook|e book|light novel|novel|roman|artbook|kochbuch|wimmelbuch/i.test(String(edition && edition.title || ''))) score -= 30;
  if (Number(edition && edition.numVolumes) >= Number(seed.item.volumeNumber)) score += 5;
  return score;
}

function dateFromMpVolume(volume) {
  if (!volume) return null;
  if (Number.isInteger(volume.year) && Number.isInteger(volume.month) && Number.isInteger(volume.day)) {
    const yyyy = String(volume.year).padStart(4, '0');
    const mm = String(volume.month).padStart(2, '0');
    const dd = String(volume.day).padStart(2, '0');
    const value = `${yyyy}-${mm}-${dd}`;
    if (isValidDate(value) && value !== '2999-12-31') return value;
  }
  if (typeof volume.date === 'string') {
    const value = volume.date.slice(0, 10);
    if (isValidDate(value) && value !== '2999-12-31') return value;
  }
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

async function tryMangaPassion(seedCandidate, aliasMap, policy, checkedAt) {
  const seed = seedCandidate.seed;
  const item = seedCandidate.item;
  try {
    const searchUrl = `${MP_API}/editions?search=${encodeURIComponent(seed.title)}&itemsPerPage=8`;
    const hits = await fetchJson(searchUrl, policy);
    await sleep(policy.minDelayMs);
    if (!Array.isArray(hits) || hits.length === 0) {
      stats.uncertain.push(`${seed.title}: Manga Passion keine Edition gefunden`);
      return null;
    }

    const scored = hits
      .map(ed => ({ ed, score: scoreEdition({ ...seed, item }, ed, aliasMap) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 70) {
      stats.uncertain.push(`${seed.title}: Manga Passion Edition unsicher (Score ${best ? best.score : 0})`);
      return null;
    }

    const volumesUrl = `${MP_API}/editions/${best.ed.id}/volumes?itemsPerPage=300`;
    const volumes = await fetchJson(volumesUrl, policy);
    await sleep(policy.minDelayMs);
    if (!Array.isArray(volumes) || volumes.length === 0) {
      stats.uncertain.push(`${seed.title}: Manga Passion keine Volumes für Edition ${best.ed.id}`);
      return null;
    }

    const vol = volumes.find(v => Number(v.number) === Number(item.volumeNumber) && !v.specialType);
    if (!vol) {
      stats.uncertain.push(`${seed.title}: Manga Passion kein Band ${item.volumeNumber} in Edition ${best.ed.id}`);
      return null;
    }
    const mpDate = dateFromMpVolume(vol);
    if (!mpDate) {
      stats.uncertain.push(`${seed.title}: Manga Passion Band ${item.volumeNumber} ohne valides Datum`);
      return null;
    }

    const coverUrl = isValidHttpsUrl(vol.cover) ? vol.cover : (isValidHttpsUrl(best.ed.cover) ? best.ed.cover : null);
    const publisher = publisherNames(best.ed)[0] || item.publisher;
    const publisherMatches = normalizePublisher(publisher, aliasMap) === item.normalizedPublisher;
    const dateMatchesSeed = mpDate === item.releaseDate;
    const confidence = best.score >= 90 && publisherMatches && dateMatchesSeed ? 'high' : 'medium';

    stats.mpConfirmed++;
    return {
      ...item,
      publisher,
      normalizedPublisher: normalizePublisher(publisher, aliasMap),
      releaseDate: mpDate,
      coverUrl,
      sourceUrl: 'https://www.manga-passion.de',
      sourceName: 'Manga Passion',
      confidence,
      notes: `Serverseitig via Manga-Passion-API bestätigt (Edition ${best.ed.id}, Band ${item.volumeNumber}, Score ${best.score}). Ursprung: app-seed.`,
      checkedAt,
    };
  } catch (error) {
    stats.uncertain.push(`${seed.title}: Manga Passion Fehler: ${error.message}`);
    return null;
  }
}

function sortItems(items) {
  return items.sort((a, b) =>
    a.normalizedSeriesTitle.localeCompare(b.normalizedSeriesTitle, 'de') ||
    a.normalizedPublisher.localeCompare(b.normalizedPublisher, 'de') ||
    a.volumeNumber - b.volumeNumber
  );
}

async function main() {
  const startedAt = new Date().toISOString();
  const sources = readJson(sourcesFile);
  const existingCache = readJson(cacheFile);
  const aliasMap = buildAliasMap(sources);
  const policy = {
    minDelayMs: Number(sources.requestPolicy && sources.requestPolicy.minDelayMs) || 1200,
    timeoutMs: Number(sources.requestPolicy && sources.requestPolicy.timeoutMs) || 12000,
    maxItemsPerSource: Number(process.env.MAX_ITEMS_PER_SOURCE || (sources.requestPolicy && sources.requestPolicy.maxItemsPerSource) || 200),
    userAgent: String((sources.requestPolicy && sources.requestPolicy.userAgent) || 'MangaTrackerReleaseBot/1.0'),
  };

  const map = new Map();
  const existingItems = Array.isArray(existingCache.items) ? existingCache.items : [];
  stats.existingInput = existingItems.length;
  for (const item of existingItems) {
    if (!validCacheItem(item)) {
      stats.invalidExisting.push(item && item.seriesTitle ? item.seriesTitle : '<unbekannt>');
      continue;
    }
    const normalized = {
      ...item,
      normalizedSeriesTitle: normalizeTitle(item.seriesTitle),
      normalizedPublisher: normalizePublisher(item.publisher, aliasMap),
      isbn13: normalizeIsbn13(item.isbn13),
      coverUrl: item.coverUrl || null,
      sourceUrl: item.sourceUrl || null,
      notes: item.notes ?? null,
    };
    if (mergeCandidate(map, normalized, 'existing')) stats.existingKept++;
  }

  const appSeeds = extractAppSeedItems(aliasMap, startedAt);
  for (const seed of appSeeds) {
    if (validCacheItem(seed.item) && mergeCandidate(map, seed.item, 'app-seed')) stats.appSeedsAddedOrKept++;
  }

  const mpSource = Array.isArray(sources.sources) ? sources.sources.find(s => s.id === 'manga-passion' && s.enabled !== false) : null;
  if (mpSource) {
    const bounded = appSeeds.slice(0, policy.maxItemsPerSource);
    console.log(`Manga Passion: prüfe ${bounded.length} app-seed Kandidat(en), Delay ${policy.minDelayMs}ms, Timeout ${policy.timeoutMs}ms`);
    for (const seed of bounded) {
      const mpItem = await tryMangaPassion(seed, aliasMap, policy, startedAt);
      if (mpItem && validCacheItem(mpItem)) {
        const before = map.get(cacheKey(mpItem));
        mergeCandidate(map, mpItem, 'manga-passion');
        const after = map.get(cacheKey(mpItem));
        if (after && after.sourceName === 'Manga Passion' && before !== after) stats.mpUsedInOutput++;
      }
    }
  }

  const items = sortItems([...map.values()]);
  const output = {
    schemaVersion: 1,
    generatedAt: startedAt,
    source: 'update-release-cache.js',
    itemCount: items.length,
    items,
  };
  writeJson(cacheFile, output);

  console.log('\nRelease-Cache aktualisiert.');
  console.log(`  Vorherige Items: ${stats.existingInput}`);
  console.log(`  Vorhandene valide übernommen: ${stats.existingKept}`);
  console.log(`  App-Seeds mit nextDate gefunden: ${stats.appSeedsFound}`);
  console.log(`  App-Seeds neu/als Fallback übernommen: ${stats.appSeedsAddedOrKept}`);
  console.log(`  Manga-Passion bestätigt: ${stats.mpConfirmed}`);
  console.log(`  Manga-Passion im Output genutzt: ${stats.mpUsedInOutput}`);
  console.log(`  Neue Items gesamt: ${items.length}`);
  if (stats.invalidExisting.length) console.warn('  Invalid existing skipped:', stats.invalidExisting.join('; '));
  if (stats.uncertain.length) {
    console.warn('\nUnsicher/fehlgeschlagen:');
    for (const entry of stats.uncertain) console.warn(`  - ${entry}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('update-release-cache fehlgeschlagen:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeTitle,
  normalizePublisher,
  normalizeIsbn13,
  isValidHttpsUrl,
  sleep,
};
