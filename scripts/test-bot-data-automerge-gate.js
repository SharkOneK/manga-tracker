#!/usr/bin/env node
'use strict';

/**
 * Phase 83 — Tests für scripts/validate-bot-data-automerge-gate.js.
 *
 * Reine Funktionstests über den exportierten Einstieg mit injizierten
 * Dokumenten: kein Git, kein Netz, keine Dateien aus data/.
 * Aufbau wie scripts/test-automerge-gate.js.
 */

const assert = require('assert');
const { evaluateBotDataAutoMergeGate } = require('./validate-bot-data-automerge-gate');

const STATUS_FILES = [
  'data/series-publication-status.json',
  'data/series-publication-status-report.json',
];
const TMDB_FILES = ['data/tmdb-series-catalog.json'];

// ── Fixtures: Series Publication Status ──────────────────────────────────────

function statusItem(overrides = {}) {
  return {
    seriesTitle: 'Adou',
    publisher: 'altraverse',
    ongoing: 'true',
    sourceStatus: 1,
    editionId: 518,
    source: 'manga-passion',
    sourceUrl: 'https://www.manga-passion.de/editions/518',
    confidence: 'high',
    checkedAt: '2026-09-12T08:48:00.716Z',
    ...overrides,
  };
}

function statusDoc(items, overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-20T04:41:00.000Z',
    items,
    ...overrides,
  };
}

function statusReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-20T04:41:00.000Z',
    source: 'run-series-publication-status.js',
    summary: {
      seriesWithStatus: 3,
      appliedChanges: 1,
      blockedOrUnmapped: 0,
      ...overrides.summary,
    },
    ...overrides,
  };
}

const statusBaseItems = [
  statusItem(),
  statusItem({ seriesTitle: 'Blue Lock', publisher: 'Manga Cult', editionId: 601, sourceUrl: 'https://www.manga-passion.de/editions/601' }),
  statusItem({ seriesTitle: 'Chainsaw Man', publisher: 'Egmont Manga', editionId: 702, sourceUrl: 'https://www.manga-passion.de/editions/702' }),
];

function evaluateStatus(overrides = {}) {
  return evaluateBotDataAutoMergeGate({
    domain: 'series-publication-status',
    changedFiles: STATUS_FILES,
    beforeDoc: statusDoc(statusBaseItems),
    afterDoc: statusDoc([
      statusItem({ ongoing: 'false', checkedAt: '2026-09-20T04:40:00.000Z' }),
      statusBaseItems[1],
      statusBaseItems[2],
    ]),
    reportDoc: statusReport(),
    ...overrides,
  });
}

// ── Fixtures: TMDB Series Catalog ────────────────────────────────────────────

function tmdbItem(overrides = {}) {
  return {
    tmdbId: 1396,
    title: 'Breaking Bad',
    network: 'AMC',
    total: 62,
    seasonCount: 5,
    ongoing: 'false',
    cover: 'https://image.tmdb.org/t/p/w500/cover.jpg',
    genres: ['Drama'],
    overview: 'Ein krebskranker Chemielehrer.',
    seasons: { 1: 1, 2: 2 },
    streamingProviders: ['Netflix'],
    ...overrides,
  };
}

function tmdbDoc(items, overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-20T04:23:00.000Z',
    source: 'update-tmdb-catalog.js',
    items,
    ...overrides,
  };
}

function watchlistDoc(entries) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    items: entries,
  };
}

const tmdbBaseItems = [
  tmdbItem(),
  tmdbItem({ tmdbId: 1399, title: 'Game of Thrones', network: 'HBO', total: 73, seasonCount: 8 }),
  tmdbItem({ tmdbId: 1400, title: 'Serie C', network: 'ZDF', total: null, seasonCount: 1 }),
];

function evaluateTmdb(overrides = {}) {
  return evaluateBotDataAutoMergeGate({
    domain: 'tmdb-series-catalog',
    changedFiles: TMDB_FILES,
    beforeDoc: tmdbDoc(tmdbBaseItems),
    afterDoc: tmdbDoc([
      tmdbItem({ total: 64, seasonCount: 6 }),
      tmdbBaseItems[1],
      tmdbBaseItems[2],
    ]),
    watchlistDoc: watchlistDoc([
      { tmdbId: 1396, title: 'Breaking Bad', enabled: true },
      { tmdbId: 1399, title: 'Game of Thrones', enabled: true },
      { tmdbId: 1400, title: 'Serie C', enabled: true },
    ]),
    ...overrides,
  });
}

function assertAllowed(name, result) {
  assert.strictEqual(result.allowed, true, `${name}: expected allowed, got ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
}

function assertBlocked(name, result, reasonIncludes) {
  assert.strictEqual(result.allowed, false, `${name}: expected blocked`);
  assert.strictEqual(result.class, 'manual-review-required', `${name}: unexpected class ${result.class}`);
  if (reasonIncludes) assert.match(result.reason, reasonIncludes, `${name}: unexpected reason: ${result.reason}`);
}

const tests = [
  // ── Domain-unabhängig ──────────────────────────────────────────────────────
  [
    'unknown domain blocks',
    () => assertBlocked('unknown domain', evaluateBotDataAutoMergeGate({ domain: 'release-cache', changedFiles: TMDB_FILES }), /unknown/),
  ],
  [
    'missing domain blocks',
    () => assertBlocked('missing domain', evaluateBotDataAutoMergeGate({ changedFiles: TMDB_FILES }), /unknown/),
  ],
  [
    'empty changed-file list blocks',
    () => assertBlocked('no changed files', evaluateStatus({ changedFiles: [] }), /no changed files/),
  ],

  // ── Domain: series-publication-status ──────────────────────────────────────
  [
    'status: high-confidence update is allowed',
    () => {
      const result = evaluateStatus();
      assertAllowed('status happy path', result);
      assert.strictEqual(result.class, 'series-publication-status-only');
      assert.strictEqual(result.updates, 1);
      assert.strictEqual(result.deletions, 0);
    },
  ],
  [
    'status: foreign data file blocks',
    () => assertBlocked('status foreign file', evaluateStatus({ changedFiles: [...STATUS_FILES, 'data/tmdb-series-catalog.json'] }), /tmdb-series-catalog\.json changed/),
  ],
  [
    'status: scripts path blocks',
    () => assertBlocked('status scripts path', evaluateStatus({ changedFiles: [...STATUS_FILES, 'scripts/run-series-publication-status.js'] }), /scripts\//),
  ],
  [
    'status: status file without report blocks',
    () => assertBlocked('status without report', evaluateStatus({ changedFiles: ['data/series-publication-status.json'] }), /require data\/series-publication-status-report\.json/),
  ],
  [
    'status: schema error blocks',
    () => assertBlocked(
      'status schema',
      evaluateStatus({ afterDoc: statusDoc([statusItem({ confidence: 'medium' }), statusBaseItems[1], statusBaseItems[2]]) }),
      /failed schema validation/,
    ),
  ],
  [
    'status: forbidden private key blocks',
    () => assertBlocked(
      'status forbidden key',
      evaluateStatus({ afterDoc: statusDoc([statusItem({ ownerId: 'private-user' }), statusBaseItems[1], statusBaseItems[2]]) }),
      /forbidden key/,
    ),
  ],
  [
    'status: unexpected top-level key blocks',
    () => assertBlocked(
      'status top-level key',
      evaluateStatus({ afterDoc: statusDoc(statusBaseItems, { supabaseSnapshot: {} }) }),
      /unexpected top-level key/,
    ),
  ],
  [
    'status: deletion blocks',
    () => assertBlocked(
      'status deletion',
      evaluateStatus({ afterDoc: statusDoc([statusBaseItems[0], statusBaseItems[1]]) }),
      /deletions are not auto-mergeable/,
    ),
  ],
  [
    'status: mass rewrite blocks (change budget)',
    () => {
      const additions = [1, 2, 3, 4, 5, 6].map(index => statusItem({
        seriesTitle: `Neue Serie ${index}`,
        editionId: 900 + index,
        sourceUrl: `https://www.manga-passion.de/editions/${900 + index}`,
      }));
      assertBlocked(
        'status budget',
        evaluateStatus({ afterDoc: statusDoc([...statusBaseItems, ...additions]) }),
        /exceed the change budget/,
      );
    },
  ],
  [
    // Regressionsschutz gegen den zweiten Deadlock (gemessen an PR #306): der Runner
    // schreibt checkedAt in jedes geprüfte Item — 45 von 47 Updates ohne inhaltliche
    // Änderung. Solche Frische-Updates zählen nicht gegen die Mengenbremse.
    'status: pure checkedAt refresh of every item stays allowed',
    () => {
      const refreshed = statusBaseItems.map(item => ({ ...item, checkedAt: '2026-09-20T04:40:00.000Z' }));
      const result = evaluateStatus({
        afterDoc: statusDoc(refreshed),
        reportDoc: statusReport({ summary: { seriesWithStatus: 3, appliedChanges: 0, blockedOrUnmapped: 4 } }),
      });
      assertAllowed('status checkedAt refresh', result);
      assert.strictEqual(result.updates, 3);
      assert.strictEqual(result.contentUpdates, 0);
    },
  ],
  [
    'status: mass content rewrite still blocks',
    () => {
      const base = Array.from({ length: 30 }, (_, index) => statusItem({
        seriesTitle: `Serie ${index}`,
        editionId: 100 + index,
        sourceUrl: `https://www.manga-passion.de/editions/${100 + index}`,
      }));
      const rewritten = base.map((item, index) => (index < 7 ? { ...item, ongoing: 'false' } : item));
      assertBlocked(
        'status content rewrite',
        evaluateStatus({
          beforeDoc: statusDoc(base),
          afterDoc: statusDoc(rewritten),
          reportDoc: statusReport({ summary: { seriesWithStatus: 30, appliedChanges: 7, blockedOrUnmapped: 0 } }),
        }),
        /content change\(s\) exceed the change budget/,
      );
    },
  ],
  [
    // Ein Override kann denselben Titel zweimal zählen (API-Wert kippt ihn, Override
    // kippt zurück) ohne Netto-Änderung — genau der Ist-Stand in PR #306.
    'status: override double-counting within tolerance stays allowed',
    () => assertAllowed(
      'status override tolerance',
      evaluateStatus({
        afterDoc: statusDoc(statusBaseItems.map(item => ({ ...item, checkedAt: '2026-09-20T04:40:00.000Z' }))),
        reportDoc: statusReport({ summary: { seriesWithStatus: 3, appliedChanges: 2, overridesApplied: 1, blockedOrUnmapped: 6 } }),
      }),
    ),
  ],
  [
    'status: generatedAt moving backwards blocks',
    () => assertBlocked(
      'status generatedAt',
      evaluateStatus({ afterDoc: statusDoc(statusBaseItems, { generatedAt: '2026-09-19T04:41:00.000Z' }) }),
      /generatedAt moved backwards/,
    ),
  ],
  [
    // Zwei Schichten blocken hier: der Schema-Validator (sourceUrl/sourceStatus)
    // und zusaetzlich die Additions-Regel des Gates. Der Schema-Validator laeuft
    // zuerst; die Gate-Regel bleibt als zweite Schicht bestehen, falls das Schema
    // spaeter gelockert wird.
    'status: addition without https source blocks',
    () => assertBlocked(
      'status addition source',
      evaluateStatus({
        afterDoc: statusDoc([
          ...statusBaseItems,
          statusItem({ seriesTitle: 'Dandadan', source: 'manual', sourceUrl: 'http://example.invalid/1', sourceStatus: 3, editionId: 999 }),
        ]),
      }),
      /failed schema validation|addition needs either an override/,
    ),
  ],
  [
    'status: addition from a curated override is allowed',
    () => assertAllowed(
      'status override addition',
      evaluateStatus({
        afterDoc: statusDoc([
          ...statusBaseItems,
          { seriesTitle: 'Dandadan', publisher: 'Carlsen', ongoing: 'true', confidence: 'high', source: 'override', reason: 'Verlagsankuendigung 2026', checkedAt: '2026-09-20T04:40:00.000Z' },
        ]),
      }),
    ),
  ],
  [
    'status: update of a non-updatable field blocks',
    () => assertBlocked(
      'status illegal field',
      evaluateStatus({
        afterDoc: statusDoc([
          statusItem({ confidence: 'high', unexpectedField: 'x' }),
          statusBaseItems[1],
          statusBaseItems[2],
        ]),
      }),
      /not auto-mergeable: update changes fields/,
    ),
  ],
  [
    'status: blockedOrUnmapped > 0 stays allowed',
    () => assertAllowed(
      'status blockedOrUnmapped',
      evaluateStatus({ reportDoc: statusReport({ summary: { seriesWithStatus: 3, appliedChanges: 1, blockedOrUnmapped: 7 } }) }),
    ),
  ],
  [
    'status: report claiming more changes than the diff blocks',
    () => assertBlocked(
      'status report drift',
      evaluateStatus({ reportDoc: statusReport({ summary: { seriesWithStatus: 3, appliedChanges: 9, blockedOrUnmapped: 0 } }) }),
      /applied changes but only/,
    ),
  ],
  [
    'status: unreadable base document blocks',
    () => assertBlocked('status base missing', evaluateStatus({ beforeDoc: null }), /base version of .* could not be read/),
  ],

  // ── Domain: tmdb-series-catalog ────────────────────────────────────────────
  [
    'tmdb: monotone update is allowed',
    () => {
      const result = evaluateTmdb();
      assertAllowed('tmdb happy path', result);
      assert.strictEqual(result.class, 'tmdb-series-catalog-only');
      assert.strictEqual(result.updates, 1);
    },
  ],
  [
    'tmdb: foreign data file blocks',
    () => assertBlocked('tmdb foreign file', evaluateTmdb({ changedFiles: [...TMDB_FILES, 'data/series-publication-status.json'] }), /series-publication-status\.json changed/),
  ],
  [
    'tmdb: scripts path blocks',
    () => assertBlocked('tmdb scripts path', evaluateTmdb({ changedFiles: [...TMDB_FILES, 'scripts/update-tmdb-catalog.js'] }), /scripts\//),
  ],
  [
    'tmdb: watchlist change blocks',
    () => assertBlocked('tmdb watchlist file', evaluateTmdb({ changedFiles: [...TMDB_FILES, 'data/tmdb-watchlist.json'] }), /tmdb-watchlist\.json changed/),
  ],
  [
    'tmdb: schema error blocks',
    () => assertBlocked(
      'tmdb schema',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbItem({ seasonCount: -1 }), tmdbBaseItems[1], tmdbBaseItems[2]]) }),
      /failed schema validation/,
    ),
  ],
  [
    // Der Katalog-Schema-Validator deckt Key-Allowlist und Forbidden-Key-Walk
    // bereits ab; beide Schichten blocken, die Reihenfolge ist Schema zuerst.
    'tmdb: forbidden private key blocks',
    () => assertBlocked(
      'tmdb forbidden key',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbItem({ ownerToken: 'private' }), tmdbBaseItems[1], tmdbBaseItems[2]]) }),
      /failed schema validation|forbidden key/,
    ),
  ],
  [
    'tmdb: deletion blocks',
    () => assertBlocked(
      'tmdb deletion',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbBaseItems[0], tmdbBaseItems[1]]) }),
      /deletions are not auto-mergeable/,
    ),
  ],
  [
    'tmdb: mass rewrite blocks (change budget)',
    () => {
      const additions = [2001, 2002, 2003, 2004, 2005, 2006].map(id => tmdbItem({ tmdbId: id, title: `Serie ${id}` }));
      assertBlocked(
        'tmdb budget',
        evaluateTmdb({ afterDoc: tmdbDoc([...tmdbBaseItems, ...additions]) }),
        /exceed the change budget/,
      );
    },
  ],
  [
    'tmdb: generatedAt moving backwards blocks',
    () => assertBlocked(
      'tmdb generatedAt',
      evaluateTmdb({ afterDoc: tmdbDoc(tmdbBaseItems, { generatedAt: '2026-09-19T04:23:00.000Z' }) }),
      /generatedAt moved backwards/,
    ),
  ],
  [
    'tmdb: new tmdbId without watchlist entry blocks',
    () => assertBlocked(
      'tmdb provenance',
      evaluateTmdb({ afterDoc: tmdbDoc([...tmdbBaseItems, tmdbItem({ tmdbId: 4242, title: 'Fremde Serie' })]) }),
      /no enabled entry in data\/tmdb-watchlist\.json/,
    ),
  ],
  [
    'tmdb: new tmdbId disabled in the watchlist blocks',
    () => assertBlocked(
      'tmdb disabled watchlist entry',
      evaluateTmdb({
        afterDoc: tmdbDoc([...tmdbBaseItems, tmdbItem({ tmdbId: 4242, title: 'Fremde Serie' })]),
        watchlistDoc: watchlistDoc([{ tmdbId: 4242, title: 'Fremde Serie', enabled: false }]),
      }),
      /no enabled entry in data\/tmdb-watchlist\.json/,
    ),
  ],
  [
    'tmdb: title change blocks',
    () => assertBlocked(
      'tmdb title change',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbItem({ title: 'Breaking Bad (US)' }), tmdbBaseItems[1], tmdbBaseItems[2]]) }),
      /title changed/,
    ),
  ],
  [
    'tmdb: decreasing seasonCount blocks',
    () => assertBlocked(
      'tmdb seasonCount',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbItem({ seasonCount: 4 }), tmdbBaseItems[1], tmdbBaseItems[2]]) }),
      /seasonCount must not decrease/,
    ),
  ],
  [
    'tmdb: total falling back to null blocks',
    () => assertBlocked(
      'tmdb total null',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbItem({ total: null }), tmdbBaseItems[1], tmdbBaseItems[2]]) }),
      /total must not decrease/,
    ),
  ],
  [
    'tmdb: total rising from null is allowed',
    () => assertAllowed(
      'tmdb total from null',
      evaluateTmdb({ afterDoc: tmdbDoc([tmdbBaseItems[0], tmdbBaseItems[1], tmdbItem({ tmdbId: 1400, title: 'Serie C', network: 'ZDF', total: 12, seasonCount: 1 })]) }),
    ),
  ],
  [
    'tmdb: unreadable base document blocks',
    () => assertBlocked('tmdb base missing', evaluateTmdb({ beforeDoc: null }), /base version of .* could not be read/),
  ],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

console.log(`\nBot-data auto-merge gate tests passed: ${passed}/${tests.length}`);
