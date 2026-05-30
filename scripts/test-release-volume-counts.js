#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { validateReleaseVolumeCounts } = require('./validate-release-volume-counts');
const { evaluateReleaseVolumeCountsGate } = require('./validate-release-volume-counts-automerge-gate');
const { validateReleaseCacheVolumeCountsConsistency } = require('./validate-release-cache-volume-counts-consistency');

const sources = { sources: [{ enabled: true, allowedUrls: ['https://www.manga-passion.de'] }] };
function validCounts() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-26T00:00:00.000Z',
    items: [{
      seriesTitle: 'Demon Slave',
      publisher: 'Crunchyroll Manga',
      publishedVolumesDE: 2,
      source: 'manga-passion',
      sourceUrl: 'https://www.manga-passion.de/editions/1',
      confidence: 'high',
      checkedAt: '2026-05-26T00:00:00.000Z',
    }],
  };
}

function validHighCache() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-30T00:00:00.000Z',
    items: [{
      seriesTitle: 'Fairy Tail',
      publisher: 'Carlsen Manga!',
      volumeNumber: 17,
      releaseDate: '2011-12-16',
      sourceUrl: 'https://www.manga-passion.de/editions/960',
      sourceName: 'Manga Passion',
      providerId: 'manga-passion',
      confidence: 'high',
      checkedAt: '2026-05-30T00:00:00.000Z',
    }],
  };
}
function validCountsWithFairyTail() {
  const doc = validCounts();
  doc.items.push({
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    publishedVolumesDE: 17,
    source: 'manga-passion',
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    confidence: 'high',
    checkedAt: '2026-05-30T00:00:00.000Z',
  });
  return doc;
}
function reportBlockingFairyTail() {
  const report = validReport();
  report.blockedCandidates = [{
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    reasonCodes: ['not-high-confidence'],
  }];
  return report;
}

function validReport() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-26T00:00:00.000Z',
    summary: { appliedHighConfidenceChanges: 1, blockedOrUnsafe: 0 },
    privacyGateRequired: true,
  };
}
function assertBlocked(name, result, pattern) {
  assert.strictEqual(result.allowed, false, `${name}: expected blocked`);
  if (pattern) assert.match(result.reason, pattern);
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }

test('validator accepts public high-confidence counts', () => {
  const result = validateReleaseVolumeCounts(validCounts(), { sources });
  assert.strictEqual(result.ok, true, result.errors.join('; '));
});

test('validator rejects private keys', () => {
  const doc = validCounts();
  doc.items[0].notes = 'private note';
  const result = validateReleaseVolumeCounts(doc, { sources });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(error => /notes/.test(error)));
});

test('gate allows only release volume count artifacts', () => {
  const result = evaluateReleaseVolumeCountsGate({
    changedFiles: ['data/release-volume-counts.json', 'data/release-volume-counts-report.json'],
    countsDoc: validCounts(),
    reportDoc: validReport(),
    sourcesDoc: sources,
  });
  assert.strictEqual(result.allowed, true, result.reason);
});

test('gate blocks source changes', () => {
  assertBlocked('source change', evaluateReleaseVolumeCountsGate({
    changedFiles: ['src/app.js', 'data/release-volume-counts.json'],
    countsDoc: validCounts(),
    reportDoc: validReport(),
    sourcesDoc: sources,
  }), /src\//);
});

test('gate blocks missing privacy marker', () => {
  const report = validReport();
  report.privacyGateRequired = false;
  assertBlocked('privacy marker', evaluateReleaseVolumeCountsGate({
    changedFiles: ['data/release-volume-counts.json'],
    countsDoc: validCounts(),
    reportDoc: report,
    sourcesDoc: sources,
  }), /privacyGateRequired/);
});


test('consistency guard rejects stale not-high-confidence report when cache has high-confidence entry', () => {
  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: validHighCache(),
    countsDoc: validCounts(),
    reportDoc: reportBlockingFairyTail(),
    sourcesDoc: sources,
    today: new Date('2026-05-30T00:00:00.000Z'),
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(error => /not-high-confidence/.test(error)));
  assert.ok(result.errors.some(error => /counts has/.test(error)));
});

test('consistency guard accepts counts and report that reflect high-confidence cache baseline', () => {
  const report = validReport();
  report.blockedCandidates = [];
  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: validHighCache(),
    countsDoc: validCountsWithFairyTail(),
    reportDoc: report,
    sourcesDoc: sources,
    today: new Date('2026-05-30T00:00:00.000Z'),
  });
  assert.strictEqual(result.ok, true, result.errors.join('; '));
});

console.log(`\nRelease volume counts tests passed: ${passed}/${passed}`);
