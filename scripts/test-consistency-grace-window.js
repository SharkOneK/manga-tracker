#!/usr/bin/env node
'use strict';

/**
 * Phase 71 — Tests für das Grace-Window im Consistency-Guard:
 * Ein Cache-Band mit releaseDate == heute darf keinen Error erzeugen (nur WARNING).
 * Echte Staleness (releaseDate < heute) bleibt weiterhin Exit 1.
 *
 * Akzeptanzkriterien (Spec-Pflicht):
 * (a) Dandadan-Repro: höchster Band releaseDate == today, Counts missing → ok=true, WARNING
 * (b) Echte Staleness: releaseDate == gestern, Counts missing → ok=false, Error
 * (c) Feinheit: höchster Band heute + niedrigerer Band < heute fehlt → ok=false, Error
 * (d) Blood-Blade-artig: releaseDate == today-2, Counts missing → ok=false, Error
 * (e) WARNING-Ausgabe: warnings.length >= 1, errors.length === 0
 */

const assert = require('assert');
const {
  validateReleaseCacheVolumeCountsConsistency,
  eligibleCacheBaselines,
} = require('./validate-release-cache-volume-counts-consistency');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TODAY = '2026-07-03'; // fix für reproduzierbare Tests
const TODAY_DATE = new Date(`${TODAY}T00:00:00Z`);

const YESTERDAY = '2026-07-02';
const TWO_DAYS_AGO = '2026-07-01';

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

/** Minimal high-confidence cache entry. releaseDate parametrisierbar. */
function cacheEntry(volumeNumber, releaseDate) {
  return {
    seriesTitle: 'Dandadan',
    normalizedSeriesTitle: 'dandadan',
    publisher: 'Manga Passion Verlag',
    normalizedPublisher: 'manga passion verlag',
    volumeNumber,
    releaseDate,
    isbn13: null,
    coverUrl: null,
    sourceUrl: 'https://www.manga-passion.de/editions/2000',
    sourceName: 'Manga Passion',
    providerId: 'manga-passion',
    evidence: 'Test',
    confidence: 'high',
    notes: null,
    checkedAt: '2026-07-03T00:00:00.000Z',
  };
}

/** Separate Serien-Hilfsfunktion für die Feinheit-Tests (c). */
function cacheEntryForSeries(seriesTitle, volumeNumber, releaseDate) {
  return {
    ...cacheEntry(volumeNumber, releaseDate),
    seriesTitle,
    normalizedSeriesTitle: seriesTitle.toLowerCase(),
  };
}

function cacheDoc(entries) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-03T00:00:00.000Z',
    source: 'test',
    itemCount: entries.length,
    items: entries,
  };
}

function countsDoc(publishedVolumesDE, seriesTitle = 'Dandadan') {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-03T00:00:00.000Z',
    items: publishedVolumesDE === null ? [] : [
      {
        seriesTitle,
        publisher: 'Manga Passion Verlag',
        publishedVolumesDE,
        source: 'manga-passion',
        sourceUrl: 'https://www.manga-passion.de/editions/2000',
        confidence: 'high',
        checkedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
  };
}

function emptyReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-03T00:00:00.000Z',
    source: 'run-release-volume-counts.js',
    providerMode: 'from-cache-only',
    summary: { appliedHighConfidenceChanges: 0, blockedOrUnsafe: 0 },
    blockedCandidates: [],
    privacyGateRequired: true,
    ...overrides,
  };
}

function reportWithBlocked(candidate) {
  return emptyReport({ blockedCandidates: [candidate] });
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
// (a) Dandadan-Repro: höchster Band releaseDate == today, Counts missing
//     → ok=true, kein Error, genau ein passendes WARNING
// ---------------------------------------------------------------------------

test('(a) Repro: Band heute + Counts missing → ok=true, WARNING, kein Error', () => {
  const cache = cacheDoc([cacheEntry(5, TODAY)]);
  const counts = countsDoc(null); // missing
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true; Fehler: ${result.errors.join('; ')}`);
  assert.strictEqual(result.errors.length, 0, `Erwartet 0 Errors; got: ${result.errors.join('; ')}`);
  assert.ok(
    result.warnings.length >= 1,
    `Erwartet mindestens 1 WARNING; got ${result.warnings.length}`,
  );
  assert.ok(
    result.warnings.some(w => /released today/.test(w) && /grace window/.test(w)),
    `Erwartet WARNING mit "released today" und "grace window"; got: ${result.warnings.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// (b) Echte Staleness: releaseDate == gestern, Counts missing → ok=false, Error
// ---------------------------------------------------------------------------

test('(b) Staleness gestern: Band gestern + Counts missing → ok=false, Error', () => {
  const cache = cacheDoc([cacheEntry(5, YESTERDAY)]);
  const counts = countsDoc(null);
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Erwartet ok=false für gestrigen Band ohne Counts');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet "release-volume-counts is stale"; got: ${result.errors.join('; ')}`,
  );
  assert.ok(
    result.errors.some(e => /missing/.test(e)),
    `Erwartet "missing" in Error; got: ${result.errors.join('; ')}`,
  );
});

test('(b) Staleness gestern: Band gestern + Counts zu niedrig → ok=false, Error', () => {
  const cache = cacheDoc([cacheEntry(5, YESTERDAY)]);
  const counts = countsDoc(4); // zu niedrig
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Erwartet ok=false für stale Counts');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet "release-volume-counts is stale"; got: ${result.errors.join('; ')}`,
  );
  assert.ok(
    result.errors.some(e => /counts has 4/.test(e)),
    `Erwartet "counts has 4"; got: ${result.errors.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// (c) Feinheit: höchster Band heute + niedrigerer Band < heute fehlt in Counts
//     → ok=false (Error nennt den fehlenden vergangenen Band)
// ---------------------------------------------------------------------------

test('(c) Feinheit: Band-7 heute + Band-5 gestern, Counts missing → ok=false, Error für Band-5', () => {
  // Band 7 erscheint heute (grace), Band 5 erschien gestern (stale)
  // Counts fehlen komplett → Band 5 muss Error erzeugen
  const cache = cacheDoc([
    cacheEntryForSeries('Dandadan', 7, TODAY),
    cacheEntryForSeries('Dandadan', 5, YESTERDAY),
  ]);
  const counts = countsDoc(null); // missing
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Erwartet ok=false: Band-5 gestern fehlt in Counts');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet Error für stale Band; got: ${result.errors.join('; ')}`,
  );
  // Der stale-byKey-Eintrag für Dandadan ist Band 5 (höchster < heute)
  assert.ok(
    result.errors.some(e => /volume 5/.test(e)),
    `Erwartet Hinweis auf volume 5; got: ${result.errors.join('; ')}`,
  );
  // Kein Error für Band 7 (heute)
  assert.ok(
    !result.errors.some(e => /volume 7/.test(e)),
    `Kein Error für volume 7 (heute) erwartet; got: ${result.errors.join('; ')}`,
  );
  // Aber WARNING für Band 7 (heute, Counts missing/zu niedrig)
  assert.ok(
    result.warnings.some(w => /volume 7/.test(w) && /grace window/.test(w)),
    `Erwartet WARNING für Band 7 (heute); got: ${result.warnings.join('; ')}`,
  );
});

test('(c) Feinheit: Band-7 heute + Band-5 gestern, Counts=5 → ok=true (Band 5 gedeckt, Band 7 nur Grace-Warning)', () => {
  // Band 5 ist stale-Baseline; Counts=5 deckt Band 5 ab (kein stale Error)
  // Band 7 ist graceToday → nur WARNING wenn Counts < 7
  const cache = cacheDoc([
    cacheEntryForSeries('Dandadan', 7, TODAY),
    cacheEntryForSeries('Dandadan', 5, YESTERDAY),
  ]);
  const counts = countsDoc(5); // deckt Band 5 ab, nicht Band 7
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  // Kein stale Error (Band 5 ist gedeckt durch Counts=5)
  assert.strictEqual(result.ok, true, `Erwartet ok=true (stale Band 5 gedeckt); Fehler: ${result.errors.join('; ')}`);
  assert.strictEqual(result.errors.length, 0, `Erwartet 0 Errors; got: ${result.errors.join('; ')}`);
  // WARNING für Band 7 (heute, Counts 5 < 7)
  assert.ok(
    result.warnings.some(w => /grace window/.test(w)),
    `Erwartet WARNING für Band 7; got: ${result.warnings.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// (d) Blood-Blade-artig: releaseDate == today-2 (TWO_DAYS_AGO), Counts missing
//     → ok=false, Error bleibt
// ---------------------------------------------------------------------------

test('(d) Blood-Blade-artig: Band vor 2 Tagen + Counts missing → ok=false, Error', () => {
  const cache = cacheDoc([cacheEntry(3, TWO_DAYS_AGO)]);
  const counts = countsDoc(null);
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Erwartet ok=false für mehrtägigen Rückstand');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet stale-Error; got: ${result.errors.join('; ')}`,
  );
  assert.strictEqual(result.warnings.length, 0, `Erwartet 0 Warnings für rein stale Band; got: ${result.warnings.join('; ')}`);
});

// ---------------------------------------------------------------------------
// (e) WARNING-Ausgabe: heute-Band ohne Error → warnings.length >= 1, errors.length === 0
// ---------------------------------------------------------------------------

test('(e) WARNING-Ausgabe: heute-Band, Counts korrekt → weder Error noch WARNING', () => {
  const cache = cacheDoc([cacheEntry(5, TODAY)]);
  const counts = countsDoc(5); // bereits korrekt
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true; Fehler: ${result.errors.join('; ')}`);
  assert.strictEqual(result.errors.length, 0, `Kein Error erwartet; got: ${result.errors.join('; ')}`);
  assert.strictEqual(result.warnings.length, 0, `Kein WARNING erwartet wenn Counts korrekt; got: ${result.warnings.join('; ')}`);
});

test('(e) WARNING-Ausgabe: heute-Band missing → errors=0, warnings>=1', () => {
  // Identisch zu (a), aber explizit als (e)-Test benannt laut Spec
  const cache = cacheDoc([cacheEntry(7, TODAY)]);
  const counts = countsDoc(null);
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.errors.length, 0, `Erwartet errors.length===0; got: ${result.errors.join('; ')}`);
  assert.ok(result.warnings.length >= 1, `Erwartet warnings.length>=1; got ${result.warnings.length}`);
});

// ---------------------------------------------------------------------------
// blockedCandidates-Zweig: stale Band → Error; heute-Band → WARNING, kein Error
// ---------------------------------------------------------------------------

test('blockedCandidates: stale Band mit not-high-confidence → Error bleibt', () => {
  const cache = cacheDoc([cacheEntry(5, YESTERDAY)]);
  const counts = countsDoc(5);
  const report = reportWithBlocked({
    seriesTitle: 'Dandadan',
    publisher: 'Manga Passion Verlag',
    volumeNumber: 5,
    reasonCodes: ['not-high-confidence'],
  });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Erwartet ok=false: stale Band im blockedCandidates blockiert');
  assert.ok(
    result.errors.some(e => /not-high-confidence/.test(e) || /report is stale/.test(e)),
    `Erwartet Error für stale blockedCandidate; got: ${result.errors.join('; ')}`,
  );
});

test('blockedCandidates: heute-Band mit not-high-confidence → höchstens WARNING, kein Error', () => {
  const cache = cacheDoc([cacheEntry(5, TODAY)]);
  const counts = countsDoc(5);
  const report = reportWithBlocked({
    seriesTitle: 'Dandadan',
    publisher: 'Manga Passion Verlag',
    volumeNumber: 5,
    reasonCodes: ['not-high-confidence'],
  });

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true (heute-Band, Grace); Fehler: ${result.errors.join('; ')}`);
  assert.strictEqual(result.errors.length, 0, `Erwartet 0 Errors; got: ${result.errors.join('; ')}`);
  assert.ok(
    result.warnings.some(w => /grace window/.test(w)),
    `Erwartet WARNING mit "grace window"; got: ${result.warnings.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// Zukunftsdatum: kein Error, kein WARNING (unveränderter Behaviour)
// ---------------------------------------------------------------------------

test('Zukunftsdatum: releaseDate > today → kein Error, kein WARNING', () => {
  const cache = cacheDoc([cacheEntry(5, '2099-12-31')]);
  const counts = countsDoc(null);
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, true, `Erwartet ok=true für Zukunftsdatum; Fehler: ${result.errors.join('; ')}`);
  assert.strictEqual(result.errors.length, 0, 'Kein Error für Zukunftsdatum erwartet');
  assert.strictEqual(result.warnings.length, 0, 'Kein WARNING für Zukunftsdatum erwartet');
  assert.strictEqual(result.highConfidenceBaselines, 0, 'Kein Baseline-Eintrag für Zukunftsdatum erwartet');
});

// ---------------------------------------------------------------------------
// highConfidenceBaselines: stale.size + graceToday.size
// ---------------------------------------------------------------------------

test('highConfidenceBaselines = stale.size + graceToday.size korrekt gezählt', () => {
  // 1 stale Band + 1 heute-Band → highConfidenceBaselines === 2
  const cache = cacheDoc([
    cacheEntry(3, YESTERDAY),       // stale
    cacheEntry(5, TODAY),           // graceToday
  ]);
  const counts = countsDoc(5); // deckt beide ab (3 und 5)
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  // byKey: für Dandadan / Manga Passion Verlag gibt es pro Map nur 1 Eintrag
  // stale: Band 3 (höchster < heute) → 1
  // graceToday: Band 5 (höchster == heute) → 1
  assert.strictEqual(result.highConfidenceBaselines, 2, `Erwartet highConfidenceBaselines=2; got ${result.highConfidenceBaselines}`);
});

// ---------------------------------------------------------------------------
// eligibleCacheBaselines direkt: Rückgabe { stale, graceToday }
// ---------------------------------------------------------------------------

test('eligibleCacheBaselines: gibt { stale, graceToday } zurück (byKey-Feinheit)', () => {
  const { buildPublisherAliasMap } = require('./release-confidence');
  const aliasMap = buildPublisherAliasMap(SOURCES);

  const cache = cacheDoc([
    cacheEntry(3, YESTERDAY),
    cacheEntry(5, TODAY),
    cacheEntry(2, TWO_DAYS_AGO),
  ]);

  const { stale, graceToday } = eligibleCacheBaselines(cache, SOURCES, aliasMap, TODAY_DATE);

  // stale-Map: Band 3 (höchster < heute, da 3 > 2)
  assert.strictEqual(stale.size, 1, `Erwartet 1 stale-Eintrag; got ${stale.size}`);
  const staleValues = [...stale.values()];
  assert.strictEqual(staleValues[0].volumeNumber, 3, `Stale-byKey sollte Band 3 (höchster < heute) enthalten; got ${staleValues[0].volumeNumber}`);

  // graceToday-Map: Band 5
  assert.strictEqual(graceToday.size, 1, `Erwartet 1 graceToday-Eintrag; got ${graceToday.size}`);
  const graceTodayValues = [...graceToday.values()];
  assert.strictEqual(graceTodayValues[0].volumeNumber, 5, `GraceToday-byKey sollte Band 5 enthalten; got ${graceTodayValues[0].volumeNumber}`);
});

// ---------------------------------------------------------------------------
// Regression: Vergangenheits-Datumsfälle (wie in test-ci-race-volume-count-fix.js)
// ---------------------------------------------------------------------------

test('Regression: Band 5 releaseDate=2020-01-01, Counts=4 → ok=false (stale Error bleibt)', () => {
  const entry = {
    ...cacheEntry(5, '2020-01-01'),
    seriesTitle: 'Hayabusa',
    normalizedSeriesTitle: 'hayabusa',
    sourceUrl: 'https://www.manga-passion.de/editions/1000',
  };
  const cache = {
    schemaVersion: 1,
    generatedAt: '2026-07-03T00:00:00.000Z',
    source: 'test',
    itemCount: 1,
    items: [entry],
  };
  const counts = {
    schemaVersion: 1,
    generatedAt: '2026-07-03T00:00:00.000Z',
    items: [{
      seriesTitle: 'Hayabusa',
      publisher: 'Manga Passion Verlag',
      publishedVolumesDE: 4,
      source: 'manga-passion',
      sourceUrl: 'https://www.manga-passion.de/editions/1000',
      confidence: 'high',
      checkedAt: '2026-07-03T00:00:00.000Z',
    }],
  };
  const report = emptyReport();

  const result = validateReleaseCacheVolumeCountsConsistency({
    cacheDoc: cache,
    countsDoc: counts,
    reportDoc: report,
    sourcesDoc: SOURCES,
    today: TODAY_DATE,
  });

  assert.strictEqual(result.ok, false, 'Regression: Vergangenheits-Staleness muss weiter Error liefern');
  assert.ok(
    result.errors.some(e => /release-volume-counts is stale/.test(e)),
    `Erwartet stale-Error; got: ${result.errors.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

const total = passed + failed;
if (failed === 0) {
  console.log(`\nPhase 71 Consistency grace-window tests passed: ${passed}/${total}`);
} else {
  console.error(`\nPhase 71 Consistency grace-window tests: ${passed}/${total} passed, ${failed} FAILED`);
  for (const err of errors) {
    console.error(`  FAIL: ${err.name}`);
    console.error(`        ${err.message}`);
  }
  process.exitCode = 1;
}
