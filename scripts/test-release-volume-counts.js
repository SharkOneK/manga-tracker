#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { validateReleaseVolumeCounts } = require('./validate-release-volume-counts');
const { evaluateReleaseVolumeCountsGate } = require('./validate-release-volume-counts-automerge-gate');

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

console.log(`\nRelease volume counts tests passed: ${passed}/${passed}`);
