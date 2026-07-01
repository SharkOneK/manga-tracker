#!/usr/bin/env node
'use strict';

/**
 * Phase 70 — Tests für den CI-Race-Fix:
 * release-cache/volume-count consistency strukturell entschärfen.
 *
 * Akzeptanzkriterien:
 * AK1 – Repro: Stale-Situation (Cache Band 5, Counts Band 4) → Validator Exit 1
 * AK2 – Fix wirkt: mergeExistingCounts auf Cache Band 5 → Counts gehoben auf 5
 * AK3 – Monotonie: Cache Band 5, Counts Band 6 (probe) → bleibt Band 6
 * AK4 – Gate akzeptiert B-PR: release-cache-with-volume-count-refresh
 */

const assert = require('assert');
const {
  validateReleaseCacheVolumeCountsConsistency,
} = require('./validate-release-cache-volume-counts-consistency');
const {
  buildBaselineFromReleaseCache,
  mergeExistingCounts,
} = require('./run-release-volume-counts');
const { evaluateAutoMergeGate } = require('./validate-release-cache-automerge-gate');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SOURCES = {
  schemaVersion: 1,
  sources: [
    {
      id: 'manga-passion',
      name: 'Manga Passion',
      publisherAliases: [],
      baseUrl: 'https://www.manga-passion.de',
      allowedUrls: ['https://www.manga-passion.de'],
      enabled: true,
    },
  ],
};

/** Minimal high-confidence past-released cache entry for Hayabusa / Band N */
function cacheEntry(volumeNumber) {
  return {
    seriesTitle: 'Hayabusa',
    normalizedSeriesTitle: 'hayabusa',
    publisher: 'Manga Passion Verlag',
    normalizedPublisher: 'manga passion verlag',
    volumeNumber,
    releaseDate: '2020-01-01', // weit in der Vergangenheit
    isbn13: null,
    coverUrl: null,
    sourceUrl: 'https://www.manga-passion.de/editions/1000',
    sourceName: 'Manga Passion',
    providerId: 'manga-passion',
    evidence: 'Test',
    confidence: 'high',
    notes: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
  };
}

function cacheDoc(entries) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    itemCount: entries.length,
    items: entries,
  };
}

function countsDoc(publishedVolumesDE) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    items: publishedVolumesDE === null ? [] : [
      {
        seriesTitle: 'Hayabusa',
        publisher: 'Manga Passion Verlag',
        publishedVolumesDE,
        source: 'manga-passion',
        sourceUrl: 'https://www.manga-passion.de/editions/1000',
        confidence: 'high',
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function volumeCountsReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'run-release-volume-counts.js',
    providerMode: 'from-cache-only',
    summary: { appliedHighConfidenceChanges: 1, blockedOrUnsafe: 0 },
    blockedCandidates: [],
    privacyGateRequired: true,
    ...overrides,
  };
}

function pipelineReport(entry) {
  return {
    schemaVersion: 1,
    source: 'run-release-cache-pipeline.js',
    summary: {
      cachePatches: 1,
      reviewQueueWrites: 0,
      invalidExistingCache: 0,
    },
    cachePatches: [
      {
        action: 'add',
        key: `${entry.normalizedSeriesTitle}|${entry.normalizedPublisher}|${entry.volumeNumber}`,
        seriesTitle: entry.seriesTitle,
        publisher: entry.publisher,
        volumeNumber: entry.volumeNumber,
        releaseDate: entry.releaseDate,
        sourceName: entry.sourceName,
        providerId: entry.providerId,
        sourceUrl: entry.sourceUrl,
        confidence: entry.confidence,
      },
    ],
    reviewQueueWrites: [],
    blockedCandidates: [],
    autoMergeEligible: true,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
  } catch (err) {
    failed += 1;
    const msg = `not ok ${passed + failed} - ${name}\n  # ${err.message}`;
    console.error(msg);
    errors.push({ name, message: err.message });
  }
}

// ---------------------------------------------------------------------------
// AK1: Repro — Stale-Situation reproduzieren
// Cache: Band 5 (high-confidence, past release)
// Counts: Band 4
// → Consistency-Validator gibt ok=false (entspricht Exit 1 als CLI)
// ---------------------------------------------------------------------------

test('AK1 Repro: Stale counts (Band 4) vs. high-confidence cache (Band 5) → Validator gibt ok=false', () => {
  const cache = cacheDoc([cacheEntry(5)]);
  const counts = countsDoc(4);
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: new Date('2026-07-01'),
  });

  assert.strictEqual(result.ok, false, 'Erwartet: Validator blockiert stale Counts');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet "release-volume-counts is stale" in Fehlern; tatsächlich: ${result.errors.join('; ')}`,
  );
  assert.ok(
    result.errors.some(e => /volume 5/.test(e)),
    `Erwartet Hinweis auf "volume 5"; tatsächlich: ${result.errors.join('; ')}`,
  );
  assert.ok(
    result.errors.some(e => /counts has 4/.test(e)),
    `Erwartet "counts has 4"; tatsächlich: ${result.errors.join('; ')}`,
  );
});

test('AK1 Repro: Counts komplett fehlend → Validator gibt ok=false', () => {
  const cache = cacheDoc([cacheEntry(5)]);
  const counts = countsDoc(null); // leere items
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: new Date('2026-07-01'),
  });

  assert.strictEqual(result.ok, false, 'Erwartet: Validator blockiert fehlende Counts');
  assert.ok(
    result.errors.some(e => /missing/.test(e)),
    `Erwartet "missing" in Fehlern; tatsächlich: ${result.errors.join('; ')}`,
  );
});

test('AK1 Baseline: Counts auf Band 5 = Cache Band 5 → Validator gibt ok=true', () => {
  const cache = cacheDoc([cacheEntry(5)]);
  const counts = countsDoc(5);
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: new Date('2026-07-01'),
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true; Fehler: ${result.errors.join('; ')}`);
});

// ---------------------------------------------------------------------------
// AK2: Fix wirkt — mergeExistingCounts hebt stale Counts auf Baseline-Band
//
// run-release-volume-counts.js hat feste Pfade und kann nicht ohne Weiteres
// auf Fixture-Pfade umgelenkt werden. Stattdessen testen wir die beteiligten
// Funktionen buildBaselineFromReleaseCache + mergeExistingCounts direkt.
// Das entspricht exakt dem --from-cache-only-Zweig in main():
//   baseline = buildBaselineFromReleaseCache(...)
//   mergeExistingCounts(baseline.byKey, existingCounts, ...)
// ---------------------------------------------------------------------------

test('AK2 Fix wirkt: buildBaselineFromReleaseCache + mergeExistingCounts hebt Band 4 auf Band 5', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);
  const checkedAt = '2026-07-01T00:00:00.000Z';
  const today = new Date('2026-07-01');

  const cache = cacheDoc([cacheEntry(5)]);
  const { byKey } = buildBaselineFromReleaseCache(cache, SOURCES, aliasMap, checkedAt, today);

  // Verifiziere: Baseline-Map enthält Band 5
  const items = [...byKey.values()];
  assert.ok(items.length === 1, `Baseline sollte 1 Eintrag haben, hat ${items.length}`);
  assert.strictEqual(items[0].publishedVolumesDE, 5, `Baseline hat Band ${items[0].publishedVolumesDE}, erwartet 5`);

  // Stale existingCounts (Band 4) gegen die echte mergeExistingCounts-Funktion.
  // Erwartet: Baseline-Wert 5 bleibt erhalten (4 > 5 ist false → kein Überschreiben).
  const staleExistingCounts = countsDoc(4);
  mergeExistingCounts(byKey, staleExistingCounts, aliasMap, checkedAt);

  const afterMerge = [...byKey.values()];
  assert.ok(afterMerge.length === 1, `Nach Merge sollte 1 Eintrag vorhanden sein, hat ${afterMerge.length}`);
  assert.strictEqual(
    afterMerge[0].publishedVolumesDE, 5,
    `Nach Merge mit stale Band-4 erwartet immer noch Band 5, hat ${afterMerge[0].publishedVolumesDE}`,
  );
});

test('AK2 Consistency-Check nach Fix: Band 5 in Cache und Counts → ok=true', () => {
  const cache = cacheDoc([cacheEntry(5)]);
  const counts = countsDoc(5); // nach --from-cache-only auf Band 5 gehoben
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: new Date('2026-07-01'),
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true nach Fix; Fehler: ${result.errors.join('; ')}`);
});

// ---------------------------------------------------------------------------
// AK3: Monotonie — Cache Band 5, Counts Band 6 (probe-getrieben) → bleibt 6
// Das ist das zentrale Regressions-Argument für Lösung B.
// ---------------------------------------------------------------------------

test('AK3 Monotonie: Cache Band 5, Counts=Band 6 (probe) → buildBaseline + mergeExistingCounts behält Band 6', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);
  const checkedAt = '2026-07-01T00:00:00.000Z';
  const today = new Date('2026-07-01');

  // Cache beweist Band 5
  const cache = cacheDoc([cacheEntry(5)]);
  const { byKey } = buildBaselineFromReleaseCache(cache, SOURCES, aliasMap, checkedAt, today);

  // existingCounts hat Band 6 (probe-getrieben) — direkt gegen echte mergeExistingCounts-Funktion.
  // Erwartet: Band 6 bleibt erhalten (6 > 5 ist true → byKey auf 6 gesetzt).
  const probeExistingCounts = countsDoc(6);
  mergeExistingCounts(byKey, probeExistingCounts, aliasMap, checkedAt);

  const afterMerge = [...byKey.values()];
  assert.ok(afterMerge.length === 1, `Nach Merge sollte 1 Eintrag vorhanden sein, hat ${afterMerge.length}`);
  assert.strictEqual(
    afterMerge[0].publishedVolumesDE, 6,
    `Monotonie verletzt: Nach Merge erwartet Band 6, hat ${afterMerge[0].publishedVolumesDE}`,
  );
});

test('AK3 Monotonie: Counts Band 6 + Cache Band 5 → Consistency-Check ok=true (6 >= 5)', () => {
  const cache = cacheDoc([cacheEntry(5)]);
  const counts = countsDoc(6); // probe-getriebener höherer Wert
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: new Date('2026-07-01'),
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true (6 >= 5); Fehler: ${result.errors.join('; ')}`);
});

test('AK3 Monotonie: Cache-Eintrag mit Zukunftsdatum fällt aus Baseline (kein False-Positive)', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);

  const futureEntry = { ...cacheEntry(5), releaseDate: '2099-12-31' };
  const cache = cacheDoc([futureEntry]);
  const { byKey } = buildBaselineFromReleaseCache(cache, SOURCES, aliasMap, '2026-07-01T00:00:00.000Z', new Date('2026-07-01'));

  assert.strictEqual(byKey.size, 0, 'Cache-Eintrag mit Zukunftsdatum darf nicht in Baseline landen');
});

// ---------------------------------------------------------------------------
// AK4: Gate akzeptiert B-PR
// changed-files = cache + pipeline-report + volume-counts + volume-counts-report
// → allowed: true, class: "release-cache-with-volume-count-refresh"
// ---------------------------------------------------------------------------

test('AK4 Gate akzeptiert B-PR: release-cache-with-volume-count-refresh', () => {
  const entry = cacheEntry(5);
  const afterCache = cacheDoc([entry]);
  const counts = countsDoc(5); // konsistent mit Cache Band 5
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-cache.json',
      'data/release-cache-pipeline-report.json',
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: pipelineReport(entry),
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cacheDoc([]),
    afterCache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, true, `Erwartet allowed=true; Grund: ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
  assert.strictEqual(
    result.class, 'release-cache-with-volume-count-refresh',
    `Erwartet class="release-cache-with-volume-count-refresh"; tatsächlich: "${result.class}"`,
  );
});

test('AK4 Gate blockiert B-PR wenn Counts stale (Band 4) trotz Cache Band 5', () => {
  const entry = cacheEntry(5);
  const afterCache = cacheDoc([entry]);
  const counts = countsDoc(4); // STALE!
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-cache.json',
      'data/release-cache-pipeline-report.json',
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: pipelineReport(entry),
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cacheDoc([]),
    afterCache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, false, 'Erwartet blocked wenn Counts stale');
  assert.match(result.reason, /inconsistent/, `Erwartet "inconsistent" in reason; tatsächlich: "${result.reason}"`);
});

test('AK4 Gate akzeptiert B-PR mit Counts Band 6 (probe > Cache 5) — Monotonie korrekt', () => {
  const entry = cacheEntry(5);
  const afterCache = cacheDoc([entry]);
  const counts = countsDoc(6); // probe-getrieben, höher als Cache
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-cache.json',
      'data/release-cache-pipeline-report.json',
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: pipelineReport(entry),
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cacheDoc([]),
    afterCache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, true, `Erwartet allowed=true (Counts 6 >= Cache 5); Grund: ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
  assert.strictEqual(result.class, 'release-cache-with-volume-count-refresh');
});

// ---------------------------------------------------------------------------
// Fehlerfall: Cache-Eintrag ohne high-confidence fällt aus Baseline
// ---------------------------------------------------------------------------

test('Fehlerfall: Cache-Eintrag mit confidence=medium → kein Baseline-Eintrag', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);

  const mediumEntry = { ...cacheEntry(5), confidence: 'medium' };
  const cache = cacheDoc([mediumEntry]);
  const { byKey } = buildBaselineFromReleaseCache(cache, SOURCES, aliasMap, '2026-07-01T00:00:00.000Z', new Date('2026-07-01'));

  assert.strictEqual(byKey.size, 0, 'Medium-confidence Cache-Eintrag darf nicht in Baseline landen');
});

test('Fehlerfall: Cache-Eintrag mit nicht-erlaubter sourceUrl → kein Baseline-Eintrag', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);

  const badUrlEntry = { ...cacheEntry(5), sourceUrl: 'https://evil.example.com/editions/1000' };
  const cache = cacheDoc([badUrlEntry]);
  const { byKey } = buildBaselineFromReleaseCache(cache, SOURCES, aliasMap, '2026-07-01T00:00:00.000Z', new Date('2026-07-01'));

  assert.strictEqual(byKey.size, 0, 'Cache-Eintrag mit unerlaubter URL darf nicht in Baseline landen');
});

// ---------------------------------------------------------------------------
// F2: Volume-count-refresh-only gate
// Ein PR der NUR data/release-volume-counts.json (+ -report.json) ändert,
// ohne data/release-cache.json, soll allowed=true mit class=volume-count-refresh-only
// erhalten — sofern Konsistenz- und Privacy-Gate grün sind.
// ---------------------------------------------------------------------------

test('F2 Gate: reiner Counts-Refresh-PR → allowed=true, class=volume-count-refresh-only', () => {
  const entry = cacheEntry(5);
  const cache = cacheDoc([entry]);
  const counts = countsDoc(5); // konsistent mit Cache Band 5
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: { schemaVersion: 1, source: 'test', summary: { cachePatches: 0 }, cachePatches: [], reviewQueueWrites: [], blockedCandidates: [], autoMergeEligible: true },
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cache,
    afterCache: cache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, true, `Erwartet allowed=true; Grund: ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
  assert.strictEqual(result.class, 'volume-count-refresh-only', `Erwartet class="volume-count-refresh-only"; tatsächlich: "${result.class}"`);
});

test('F2 Gate: reiner Counts-Refresh mit stalen Counts → blocked (Konsistenz-Gate greift)', () => {
  const entry = cacheEntry(5);
  const cache = cacheDoc([entry]);
  const counts = countsDoc(4); // STALE vs. Cache Band 5
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: { schemaVersion: 1, source: 'test', summary: { cachePatches: 0 }, cachePatches: [], reviewQueueWrites: [], blockedCandidates: [], autoMergeEligible: true },
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cache,
    afterCache: cache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, false, 'Erwartet blocked wenn Counts stale');
  assert.match(result.reason, /inconsistent/, `Erwartet "inconsistent" in reason; tatsächlich: "${result.reason}"`);
});

test('F2 Gate: unerwartete Datei in Counts-only-PR → blocked (fail-closed)', () => {
  const entry = cacheEntry(5);
  const cache = cacheDoc([entry]);
  const counts = countsDoc(5);
  const report = volumeCountsReport({ blockedCandidates: [] });

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
      'data/release-watchlist.json', // unerwartete Datei
    ],
    pipelineReport: { schemaVersion: 1, source: 'test', summary: { cachePatches: 0 }, cachePatches: [], reviewQueueWrites: [], blockedCandidates: [], autoMergeEligible: true },
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cache,
    afterCache: cache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, false, 'Erwartet blocked wenn unerlaubte Datei im Diff');
});

test('F2 Gate: Counts-Refresh mit privacyGateRequired=false → blocked (Privacy-Gate greift)', () => {
  const entry = cacheEntry(5);
  const cache = cacheDoc([entry]);
  const counts = countsDoc(5);
  const report = volumeCountsReport({ privacyGateRequired: false }); // verletzt Privacy-Gate

  const result = evaluateAutoMergeGate({
    changedFiles: [
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: { schemaVersion: 1, source: 'test', summary: { cachePatches: 0 }, cachePatches: [], reviewQueueWrites: [], blockedCandidates: [], autoMergeEligible: true },
    beforeQueue: [],
    afterQueue: [],
    beforeCache: cache,
    afterCache: cache,
    sources: SOURCES,
    countsDoc: counts,
    reportDoc: report,
  });

  assert.strictEqual(result.allowed, false, 'Erwartet blocked wenn privacyGateRequired=false');
  assert.match(result.reason, /privacyGateRequired/, `Erwartet Hinweis auf privacyGateRequired; tatsächlich: "${result.reason}"`);
});

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

const total = passed + failed;
if (failed === 0) {
  console.log(`\nPhase 70 CI-Race-Fix tests passed: ${passed}/${total}`);
} else {
  console.error(`\nPhase 70 CI-Race-Fix tests: ${passed}/${total} passed, ${failed} FAILED`);
  for (const err of errors) {
    console.error(`  FAIL: ${err.name}`);
    console.error(`        ${err.message}`);
  }
  process.exitCode = 1;
}
