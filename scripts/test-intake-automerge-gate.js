#!/usr/bin/env node
'use strict';

/**
 * Regressionstests für das Release-Intake Auto-Merge Gate (Phase 46g).
 *
 * Deckt die in der Phase-Notiz geforderten Fälle ab:
 *  - additive Adds (Titel+Publisher+Band)            → erlaubt
 *  - Eintrag ohne Publisher / leerer Titel           → blockiert
 *  - privates Feld (owned/total/token …)             → blockiert
 *  - Löschung eines bestehenden Eintrags             → blockiert
 *  - Feldänderung an bestehendem Eintrag             → blockiert (manuell)
 *  - PR mit docs/*-(fremd)/scripts/*-Änderung        → blockiert
 *  - Sonderedition im Titel                          → blockiert
 *  - Coverage-Docs nicht synchron zum Audit          → blockiert
 *  - kein additiver Diff (No-op)                     → blockiert
 */

const assert = require('assert');
const { evaluateIntakeAutoMergeGate } = require('./validate-release-intake-automerge-gate');

const ALLOWED_FILES = ['data/release-watchlist.json'];

function wl(items) {
  return { schemaVersion: 1, items, generatedAt: '2026-05-27T00:00:00.000Z' };
}

function queue(entries) {
  return {
    schemaVersion: 1,
    queue: entries,
    summary: { totalGaps: entries.length, knownSourceGaps: entries.length, safeToPatch: 0 },
  };
}

function entry(overrides = {}) {
  return {
    seriesTitle: 'Beispiel Serie',
    publisher: 'Egmont Manga',
    volumeNumber: 1,
    sourceUrl: null,
    notes: 'Aus Release-Intake-Staging übernommen.',
    enabled: true,
    ...overrides,
  };
}

function queueEntry(overrides = {}) {
  return {
    queueKey: 'Beispiel Serie|Egmont Manga|1',
    seriesTitle: 'Beispiel Serie',
    publisher: 'Egmont Manga',
    volumeNumber: 1,
    classification: 'source-data-gap',
    suspectedCause: 'manual-source-required',
    priority: 'mittel',
    recommendedFix: 'manual-source-review',
    manualSourceReviewNeeded: true,
    safeToPatch: false,
    reviewStatus: 'pending',
    sourceUrl: '',
    releaseDate: null,
    checkedAt: null,
    evidence: '',
    notes: 'Automatisch ergänzt.',
    ...overrides,
  };
}

const existing = entry({ seriesTitle: 'Bestehende Serie', volumeNumber: 3 });

function evaluate(overrides = {}) {
  return evaluateIntakeAutoMergeGate({
    changedFiles: ALLOWED_FILES,
    beforeWatchlist: wl([existing]),
    afterWatchlist: wl([existing, entry()]),
    beforeQueue: queue([]),
    afterQueue: queue([]),
    coverageDocsConsistent: true,
    ...overrides,
  });
}

function assertAllowed(name, result) {
  assert.strictEqual(result.allowed, true, `${name}: erwartet allowed, war: ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
}

function assertBlocked(name, result, reasonIncludes) {
  assert.strictEqual(result.allowed, false, `${name}: erwartet blockiert`);
  if (reasonIncludes) {
    assert.match(result.reason, reasonIncludes, `${name}: unerwarteter Grund: ${result.reason}`);
  }
}

const tests = [
  [
    'additive add (Titel+Publisher+Band) ist erlaubt',
    () => {
      const result = evaluate();
      assertAllowed('additive add', result);
      assert.strictEqual(result.class, 'intake-watchlist-additive-only');
      assert.strictEqual(result.addedWatchlistEntries, 1);
    },
  ],
  [
    'additiver Add mit volumeNumbers-Array ist erlaubt',
    () => {
      const multi = entry({ seriesTitle: 'Multi Serie', volumeNumber: undefined, volumeNumbers: [4, 5, 6] });
      delete multi.volumeNumber;
      const result = evaluate({ afterWatchlist: wl([existing, multi]) });
      assertAllowed('volumeNumbers add', result);
    },
  ],
  [
    'mehrere Daten/Doc-Dateien gemeinsam (generated bundle) sind erlaubt',
    () => {
      const result = evaluate({
        changedFiles: [
          'data/release-watchlist.json',
          'data/release-source-review-queue.json',
          'docs/release-cache-coverage-gaps.md',
          'docs/release-cache-source-gap-analysis.md',
        ],
        beforeQueue: queue([]),
        afterQueue: queue([queueEntry()]),
      });
      assertAllowed('generated bundle', result);
      assert.strictEqual(result.addedQueueEntries, 1);
    },
  ],
  [
    'Eintrag ohne Publisher blockiert',
    () => {
      const bad = entry({ seriesTitle: 'Ohne Verlag', publisher: '' });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      assertBlocked('empty publisher', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /publisher/.test(e)));
    },
  ],
  [
    'Eintrag mit leerem Titel blockiert',
    () => {
      const bad = entry({ seriesTitle: '   ' });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      assertBlocked('empty title', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /seriesTitle/.test(e)));
    },
  ],
  [
    'privates Feld (owned) blockiert',
    () => {
      const bad = entry({ owned: true });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      // Der globale Privacy-Regression-Check greift hier zuerst.
      assertBlocked('private field owned', result, /private Felder/);
      assert.match(result.reason, /owned/);
    },
  ],
  [
    'privates Feld (token) blockiert',
    () => {
      const bad = entry({ token: 'secret-123' });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      assertBlocked('private field token', result, /private Felder/);
      assert.match(result.reason, /token/);
    },
  ],
  [
    'unbekanntes Feld blockiert',
    () => {
      const bad = entry({ randomField: 'x' });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      assertBlocked('unknown field', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /randomField/.test(e)));
    },
  ],
  [
    'Löschung eines bestehenden Eintrags blockiert',
    () => {
      const result = evaluate({ afterWatchlist: wl([entry()]) }); // existing entfernt
      assertBlocked('deletion', result, /gelöscht oder verändert/);
    },
  ],
  [
    'Feldänderung an bestehendem Eintrag blockiert (manuell)',
    () => {
      const edited = entry({ seriesTitle: 'Bestehende Serie', volumeNumber: 3, notes: 'manuell geändert' });
      const result = evaluate({ afterWatchlist: wl([edited]) });
      assertBlocked('field edit', result, /gelöscht oder verändert/);
    },
  ],
  [
    'Sonderedition im Titel blockiert',
    () => {
      const bad = entry({ seriesTitle: 'Berserk Master Edition' });
      const result = evaluate({ afterWatchlist: wl([existing, bad]) });
      assertBlocked('special edition', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /Sonderausgabe|Sammelband|Neuauflage/.test(e)));
    },
  ],
  [
    'docs/*-Fremddatei blockiert',
    () => assertBlocked('foreign docs', evaluate({ changedFiles: ['data/release-watchlist.json', 'docs/security.md'] }), /kein erlaubtes generiertes Coverage-Doc/),
  ],
  [
    'scripts/*-Änderung blockiert',
    () => assertBlocked('scripts', evaluate({ changedFiles: ['data/release-watchlist.json', 'scripts/foo.js'] }), /scripts\//),
  ],
  [
    'src/*-Änderung blockiert',
    () => assertBlocked('src', evaluate({ changedFiles: ['data/release-watchlist.json', 'src/app.js'] }), /src\//),
  ],
  [
    'workflow-Änderung blockiert',
    () => assertBlocked('workflow', evaluate({ changedFiles: ['data/release-watchlist.json', '.github/workflows/release-intake.yml'] }), /\.github\//),
  ],
  [
    'supabase-Änderung blockiert',
    () => assertBlocked('supabase', evaluate({ changedFiles: ['data/release-watchlist.json', 'supabase/migrations/x.sql'] }), /supabase\//),
  ],
  [
    'release-cache.json blockiert',
    () => assertBlocked('release-cache', evaluate({ changedFiles: ['data/release-cache.json'] }), /release-cache\.json/),
  ],
  [
    'release-sources.json blockiert',
    () => assertBlocked('release-sources', evaluate({ changedFiles: ['data/release-sources.json'] }), /release-sources\.json/),
  ],
  [
    'fremde Datei (nicht in Allowlist) blockiert',
    () => assertBlocked('foreign file', evaluate({ changedFiles: ['data/release-watchlist.json', 'README.md'] }), /nicht in der Phase-46g-Allowlist/),
  ],
  [
    'Coverage-Docs nicht synchron zum Audit blockiert',
    () => assertBlocked('docs drift', evaluate({ coverageDocsConsistent: false }), /nicht synchron zum Live-Audit/),
  ],
  [
    'No-op (keine additive Änderung) blockiert',
    () => assertBlocked('no-op', evaluate({ afterWatchlist: wl([existing]) }), /keine additive/),
  ],
  [
    'neuer Queue-Eintrag mit safeToPatch=true blockiert',
    () => {
      const bad = queueEntry({ safeToPatch: true, reviewStatus: 'ready-to-patch' });
      const result = evaluate({
        changedFiles: ['data/release-watchlist.json', 'data/release-source-review-queue.json'],
        beforeQueue: queue([]),
        afterQueue: queue([bad]),
      });
      assertBlocked('queue safeToPatch', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /safeToPatch/.test(e)));
    },
  ],
  [
    'neuer Queue-Eintrag mit releaseDate blockiert',
    () => {
      const bad = queueEntry({ releaseDate: '2026-06-01' });
      const result = evaluate({
        changedFiles: ['data/release-watchlist.json', 'data/release-source-review-queue.json'],
        beforeQueue: queue([]),
        afterQueue: queue([bad]),
      });
      assertBlocked('queue releaseDate', result, /Datengate fehlgeschlagen/);
      assert.ok(result.errors.some(e => /releaseDate/.test(e)));
    },
  ],
  [
    'Löschung eines bestehenden Queue-Eintrags blockiert',
    () => {
      const result = evaluate({
        changedFiles: ['data/release-watchlist.json', 'data/release-source-review-queue.json'],
        beforeQueue: queue([queueEntry()]),
        afterQueue: queue([]),
      });
      assertBlocked('queue deletion', result, /Review-Queue-Einträge wurden gelöscht/);
    },
  ],
  [
    'keine geänderten Dateien blockiert',
    () => assertBlocked('no files', evaluate({ changedFiles: [] }), /keine geänderten Dateien/),
  ],
  [
    'JSON-Ausgabeform ist parsebar',
    () => {
      const parsed = JSON.parse(JSON.stringify(evaluate()));
      assert.strictEqual(typeof parsed.allowed, 'boolean');
      assert.ok(Array.isArray(parsed.changedFiles));
    },
  ],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

console.log(`\nIntake auto-merge gate tests passed: ${passed}/${tests.length}`);
