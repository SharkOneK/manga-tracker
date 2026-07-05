#!/usr/bin/env node
'use strict';

/**
 * Guard that keeps release-cache and release-volume-count artifacts in sync.
 *
 * A high-confidence, already released cache entry must be reflected in
 * data/release-volume-counts.json and must not still appear in the report as
 * blocked by not-high-confidence. This catches stale volume-count artifacts
 * after automated release-cache PRs are merged.
 */

const fs = require('fs');
const path = require('path');
const {
  buildPublisherAliasMap,
  isAllowedSourceUrl,
  isRealReleaseDate,
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');

const repoRoot = path.resolve(__dirname, '..');
const defaultCacheFile = path.join(repoRoot, 'data', 'release-cache.json');
const defaultCountsFile = path.join(repoRoot, 'data', 'release-volume-counts.json');
const defaultReportFile = path.join(repoRoot, 'data', 'release-volume-counts-report.json');
const defaultSourcesFile = path.join(repoRoot, 'data', 'release-sources.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPastOrToday(dateValue, today = new Date()) {
  if (!isRealReleaseDate(dateValue)) return false;
  const d = new Date(`${dateValue}T00:00:00Z`);
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return d.getTime() <= t.getTime();
}

function isStrictlyPast(dateValue, today = new Date()) {
  if (!isRealReleaseDate(dateValue)) return false;
  const d = new Date(`${dateValue}T00:00:00Z`);
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return d.getTime() < t.getTime();
}

function isSameDay(dateValue, today = new Date()) {
  if (!isRealReleaseDate(dateValue)) return false;
  const d = new Date(`${dateValue}T00:00:00Z`);
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return d.getTime() === t.getTime();
}

function countKey(title, publisher, aliasMap) {
  return `${normalizeTitle(title)}|${normalizePublisher(publisher, aliasMap)}`;
}

function eligibleCacheBaselines(cacheDoc, sourcesDoc, aliasMap, today = new Date()) {
  const stale = new Map();
  const graceToday = new Map();
  const items = Array.isArray(cacheDoc && cacheDoc.items) ? cacheDoc.items : [];

  for (const entry of items) {
    const title = String(entry && entry.seriesTitle || '').trim();
    const publisher = String(entry && entry.publisher || '').trim();
    const volumeNumber = Number(entry && entry.volumeNumber);

    if (!title || !publisher) continue;
    if (!Number.isInteger(volumeNumber) || volumeNumber < 1) continue;
    if (entry.confidence !== 'high') continue;
    if (!isAllowedSourceUrl(entry.sourceUrl, sourcesDoc)) continue;

    const key = countKey(title, publisher, aliasMap);
    const entryObj = { key, seriesTitle: title, publisher, volumeNumber, sourceUrl: entry.sourceUrl };

    if (isStrictlyPast(entry.releaseDate, today)) {
      const current = stale.get(key);
      if (!current || volumeNumber > current.volumeNumber) {
        stale.set(key, entryObj);
      }
    } else if (isSameDay(entry.releaseDate, today)) {
      const current = graceToday.get(key);
      if (!current || volumeNumber > current.volumeNumber) {
        graceToday.set(key, entryObj);
      }
    }
    // releaseDate > today: ignored in both maps (no error, no warning)
  }

  return { stale, graceToday };
}

function mapCounts(countsDoc, aliasMap) {
  const byKey = new Map();
  const items = Array.isArray(countsDoc && countsDoc.items) ? countsDoc.items : [];
  for (const item of items) {
    const title = String(item && item.seriesTitle || '').trim();
    const publisher = String(item && item.publisher || '').trim();
    if (!title || !publisher) continue;
    byKey.set(countKey(title, publisher, aliasMap), item);
  }
  return byKey;
}

function blockedCandidates(reportDoc) {
  return Array.isArray(reportDoc && reportDoc.blockedCandidates) ? reportDoc.blockedCandidates : [];
}

function validateReleaseCacheVolumeCountsConsistency({
  cacheDoc,
  countsDoc,
  reportDoc,
  sourcesDoc,
  today = new Date(),
}) {
  const errors = [];
  const warnings = [];
  const aliasMap = buildPublisherAliasMap(sourcesDoc || { sources: [] });
  const { stale, graceToday } = eligibleCacheBaselines(cacheDoc, sourcesDoc || { sources: [] }, aliasMap, today);
  const countsByKey = mapCounts(countsDoc, aliasMap);

  // Error-Zweig: nur stale-Baselines (releaseDate < today) → Exit 1 wenn counts fehlen/zu niedrig
  for (const baseline of stale.values()) {
    const countItem = countsByKey.get(baseline.key);
    const countValue = Number(countItem && countItem.publishedVolumesDE);
    if (!countItem || !Number.isInteger(countValue) || countValue < baseline.volumeNumber) {
      errors.push(
        `${baseline.seriesTitle} / ${baseline.publisher}: release-volume-counts is stale; ` +
        `high-confidence cache proves volume ${baseline.volumeNumber}, ` +
        `counts has ${Number.isInteger(countValue) ? countValue : 'missing'}.`,
      );
    }
  }

  // Warning-Zweig: heute erschienene Bände (releaseDate == today) → nur WARNING, kein Error
  for (const baseline of graceToday.values()) {
    const countItem = countsByKey.get(baseline.key);
    const countValue = Number(countItem && countItem.publishedVolumesDE);
    if (!countItem || !Number.isInteger(countValue) || countValue < baseline.volumeNumber) {
      warnings.push(
        `${baseline.seriesTitle} / ${baseline.publisher} volume ${baseline.volumeNumber}: ` +
        `released today; counts not yet caught up (grace window, no error).`,
      );
    }
  }

  for (const candidate of blockedCandidates(reportDoc)) {
    const title = String(candidate && candidate.seriesTitle || '').trim();
    const publisher = String(candidate && candidate.publisher || '').trim();
    const volumeNumber = Number(candidate && candidate.volumeNumber);
    const reasonCodes = Array.isArray(candidate && candidate.reasonCodes) ? candidate.reasonCodes : [];
    if (!title || !publisher || !Number.isInteger(volumeNumber)) continue;
    if (!reasonCodes.includes('not-high-confidence')) continue;

    const key = countKey(title, publisher, aliasMap);
    const staleBaseline = stale.get(key);
    const graceTodayBaseline = graceToday.get(key);

    if (staleBaseline && staleBaseline.volumeNumber >= volumeNumber) {
      errors.push(
        `${title} / ${publisher} volume ${volumeNumber}: report is stale; ` +
        '`not-high-confidence` is blocked even though release-cache contains an eligible high-confidence entry.',
      );
    } else if (graceTodayBaseline && graceTodayBaseline.volumeNumber >= volumeNumber) {
      warnings.push(
        `${title} / ${publisher} volume ${volumeNumber}: report may be stale; ` +
        '`not-high-confidence` is blocked but release-cache entry was released today (grace window, no error).',
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    highConfidenceBaselines: stale.size + graceToday.size,
  };
}

function parseArgs(argv) {
  const args = {
    cacheFile: defaultCacheFile,
    countsFile: defaultCountsFile,
    reportFile: defaultReportFile,
    sourcesFile: defaultSourcesFile,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cache') args.cacheFile = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--counts') args.countsFile = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--report') args.reportFile = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--sources') args.sourcesFile = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    result = validateReleaseCacheVolumeCountsConsistency({
      cacheDoc: readJson(args.cacheFile),
      countsDoc: readJson(args.countsFile),
      reportDoc: readJson(args.reportFile),
      sourcesDoc: readJson(args.sourcesFile),
    });
  } catch (error) {
    result = { ok: false, errors: [error.message], warnings: [] };
  }

  if (args && args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    console.log(`✅ release-cache/release-volume-counts consistency valid (${result.highConfidenceBaselines} high-confidence baselines)`);
  } else {
    console.error('❌ release-cache/release-volume-counts consistency invalid:');
    result.errors.forEach(error => console.error(`- ${error}`));
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  eligibleCacheBaselines,
  isPastOrToday,
  isStrictlyPast,
  isSameDay,
  validateReleaseCacheVolumeCountsConsistency,
};
