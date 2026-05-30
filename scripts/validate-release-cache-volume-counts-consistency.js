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

function countKey(title, publisher, aliasMap) {
  return `${normalizeTitle(title)}|${normalizePublisher(publisher, aliasMap)}`;
}

function eligibleCacheBaselines(cacheDoc, sourcesDoc, aliasMap, today = new Date()) {
  const byKey = new Map();
  const items = Array.isArray(cacheDoc && cacheDoc.items) ? cacheDoc.items : [];

  for (const entry of items) {
    const title = String(entry && entry.seriesTitle || '').trim();
    const publisher = String(entry && entry.publisher || '').trim();
    const volumeNumber = Number(entry && entry.volumeNumber);

    if (!title || !publisher) continue;
    if (!Number.isInteger(volumeNumber) || volumeNumber < 1) continue;
    if (entry.confidence !== 'high') continue;
    if (!isAllowedSourceUrl(entry.sourceUrl, sourcesDoc)) continue;
    if (!isPastOrToday(entry.releaseDate, today)) continue;

    const key = countKey(title, publisher, aliasMap);
    const current = byKey.get(key);
    if (!current || volumeNumber > current.volumeNumber) {
      byKey.set(key, {
        key,
        seriesTitle: title,
        publisher,
        volumeNumber,
        sourceUrl: entry.sourceUrl,
      });
    }
  }

  return byKey;
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
  const baselines = eligibleCacheBaselines(cacheDoc, sourcesDoc || { sources: [] }, aliasMap, today);
  const countsByKey = mapCounts(countsDoc, aliasMap);

  for (const baseline of baselines.values()) {
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

  for (const candidate of blockedCandidates(reportDoc)) {
    const title = String(candidate && candidate.seriesTitle || '').trim();
    const publisher = String(candidate && candidate.publisher || '').trim();
    const volumeNumber = Number(candidate && candidate.volumeNumber);
    const reasonCodes = Array.isArray(candidate && candidate.reasonCodes) ? candidate.reasonCodes : [];
    if (!title || !publisher || !Number.isInteger(volumeNumber)) continue;
    if (!reasonCodes.includes('not-high-confidence')) continue;

    const baseline = baselines.get(countKey(title, publisher, aliasMap));
    if (baseline && baseline.volumeNumber >= volumeNumber) {
      errors.push(
        `${title} / ${publisher} volume ${volumeNumber}: report is stale; ` +
        '`not-high-confidence` is blocked even though release-cache contains an eligible high-confidence entry.',
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    highConfidenceBaselines: baselines.size,
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
  validateReleaseCacheVolumeCountsConsistency,
};
