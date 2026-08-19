#!/usr/bin/env node
// scripts/test-release-volume-counts-total-bridge.js — Phase 80: Release-Bandstand-Bruecke in m.total
//
// Testet die reinen Funktionen bridgedTotalForCount(m, count) und den
// Mutations-Treiber reconcileReleaseVolumeTotals() aus src/app.js. Da
// src/app.js browserseitig ist (kein module.exports), werden die relevanten
// Funktionen 1:1 gespiegelt — analog zu scripts/test-filter-phase67.js.
// Gespiegelte Originale (siehe .pipeline/changes.md fuer Zeilenangaben):
//   - normalizeReleaseTitle / normalizeReleasePublisher / _releasePubsMatch (src/app.js:3186-3250)
//   - findReleaseVolumeCountForSeries (src/app.js:4214-4225)
//   - bridgedTotalForCount (src/app.js:4231-4238)
//   - reconcileReleaseVolumeTotals-Kernschleife (src/app.js:4245-4260), hier als
//     reine Funktion ohne DOM/canEditLocal/persist/render gespiegelt
//   - mOwned / mFirstMissingBand (src/app.js:302, :319-331)
//   - toBuyList-Kernfilter (src/app.js:1143-1155)
//   - validateReleaseVolumeCountsClient (src/app.js:4184-4194) — fuer den Confidence-/Fehlerfall
//
// Laeuft direkt mit Node, kein Test-Framework, keine neuen Dependencies.
'use strict';

const assert = require('assert');

// ─── Testrahmen (identisch mit test-filter-phase67.js) ─────────────────────

let _passed = 0;
let _failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    _failed++;
  }
}

// ─── Aus app.js gespiegelte Funktionen ──────────────────────────────────────

function normalizeReleaseTitle(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const _PUB_ALIAS_MAP = {
  'carlsen':           'carlsen manga',
  'carlsen manga':     'carlsen manga',
  'tokyopop':          'tokyopop',
  'tokyo pop':         'tokyopop',
  'kaze manga':        'kaze manga',
  'kaze':              'kaze manga',
  'crunchyroll manga': 'crunchyroll manga',
  'crunchyroll':       'crunchyroll manga',
};

const _PUB_RELATED_GROUPS = [
  new Set(['kaze manga', 'crunchyroll manga']),
];

function normalizeReleasePublisher(value) {
  const raw = (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return _PUB_ALIAS_MAP[raw] || raw;
}

function _releasePubsMatch(a, b) {
  if (!a || !b) return true; // Fehlender Verlag schliesst nicht aus
  if (a === b) return true;
  for (const group of _PUB_RELATED_GROUPS) {
    if (group.has(a) && group.has(b)) return true;
  }
  return false;
}

// Gespiegelt wie src/app.js:4214-4225, aber releaseVolumeCounts als Parameter
// statt globaler Variable — sonst identische Logik (genau 1 Treffer noetig).
function findReleaseVolumeCountForSeries(m, releaseVolumeCounts) {
  if (!releaseVolumeCounts || !Array.isArray(releaseVolumeCounts.items)) return null;
  const normT = normalizeReleaseTitle(m.title);
  const normP = normalizeReleasePublisher(m.pub || '');
  const matches = releaseVolumeCounts.items.filter(item => {
    const itemT = normalizeReleaseTitle(item.seriesTitle || '');
    const itemP = normalizeReleasePublisher(item.publisher || '');
    return normT === itemT && _releasePubsMatch(normP, itemP);
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

// 1:1 aus src/app.js:4231-4238.
function bridgedTotalForCount(m, count) {
  if (!count) return null;
  const published = Number(count.publishedVolumesDE);
  if (!Number.isInteger(published) || published <= 0) return null;
  const cur = Number(m.total);
  if (cur > 0 && published <= cur) return null; // nie senken, auch nicht bei Gleichstand
  return published;
}

// Kernschleife aus src/app.js:4245-4260, gespiegelt als reine Funktion ohne
// db/canEditLocal/persist/render (DOM-/Browser-Globals) — siehe changes.md
// "Hinweise fuer den Tester". Mutiert dbM in-place, liefert changed (boolean).
function reconcileReleaseVolumeTotalsMirror(dbM, releaseVolumeCounts) {
  if (!releaseVolumeCounts || !Array.isArray(releaseVolumeCounts.items)) return false;
  if (!Array.isArray(dbM)) return false;
  let changed = false;
  dbM.forEach(m => {
    const count = findReleaseVolumeCountForSeries(m, releaseVolumeCounts);
    const bridged = bridgedTotalForCount(m, count);
    if (bridged !== null) {
      m.total = bridged;
      changed = true;
    }
  });
  return changed;
}

// 1:1 aus src/app.js:302, :319-331.
function mOwned(m) { return Object.keys(m.bands || {}).length; }
function mFirstMissingBand(m) {
  const owned = m.bands || {};
  const total = Number(m.total);
  const hasTotalKnown = !isNaN(total) && total > 0;
  const ownedNums = new Set(Object.keys(owned).map(Number));
  const maxOwned = ownedNums.size ? Math.max(...ownedNums) : 0;
  const searchUpTo = hasTotalKnown ? total : (maxOwned + 1);
  for (let i = 1; i <= searchUpTo; i++) {
    if (!ownedNums.has(i)) return i;
  }
  return null;
}

// Kernfilter aus src/app.js:1143-1155 (ohne mediaModeItems()/Sortierung,
// die hier nicht relevant sind — reine total/owned/mFirstMissingBand-Logik).
function toBuyListMirror(list) {
  return list
    .filter(m => {
      const total = Number(m.total);
      const owned = mOwned(m);
      if (isNaN(total) || total <= 0 || total <= owned) return false;
      return mFirstMissingBand(m) !== null;
    })
    .map(m => ({ ...m, next: mFirstMissingBand(m) }));
}

// 1:1 aus src/app.js:4184-4194 — fuer den Confidence-/Schema-Fehlerfall.
function validateReleaseVolumeCountsClient(doc) {
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1 || !Array.isArray(doc.items)) return false;
  return doc.items.every(item => item && typeof item === 'object'
    && typeof item.seriesTitle === 'string' && item.seriesTitle.trim()
    && typeof item.publisher === 'string' && item.publisher.trim()
    && Number.isInteger(item.publishedVolumesDE) && item.publishedVolumesDE >= 0
    && typeof item.source === 'string' && item.source.trim()
    && typeof item.sourceUrl === 'string' && item.sourceUrl.startsWith('https://')
    && item.confidence === 'high'
    && typeof item.checkedAt === 'string');
}

// ─── Mock-Daten ──────────────────────────────────────────────────────────

function ownedBands(fromInclusive, toInclusive, status) {
  const bands = {};
  for (let i = fromInclusive; i <= toInclusive; i++) bands[i] = status || 'owned';
  return bands;
}

function kagurabachiSeries() {
  return {
    id: 'kb1',
    title: 'Kagurabachi',
    pub: 'Carlsen Manga',
    status: 'owned',
    total: 7,
    bands: ownedBands(1, 7),
  };
}

function kagurabachiCount(overrides) {
  return Object.assign({
    seriesTitle: 'Kagurabachi',
    publisher: 'Carlsen Manga',
    publishedVolumesDE: 8,
    source: 'manga-passion',
    sourceUrl: 'https://www.manga-passion.de/editions/5072',
    confidence: 'high',
    checkedAt: '2026-08-16T00:00:00.000Z',
  }, overrides || {});
}

function countsDoc(items) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-16T00:00:00.000Z',
    items: items,
  };
}

// ─── Tests: bridgedTotalForCount — Normalfaelle ────────────────────────────

console.log('\n── bridgedTotalForCount: Normalfaelle ─────────────────────');

runTest('N1: Kagurabachi-Leitfall — total 7, published 8 → Bruecke liefert 8', function() {
  const m = kagurabachiSeries();
  const result = bridgedTotalForCount(m, kagurabachiCount());
  assert.strictEqual(result, 8);
});

runTest('N2: published == total (8 == 8) → keine Aenderung (null)', function() {
  const m = kagurabachiSeries();
  m.total = 8;
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(result, null, 'Gleichstand darf keinen Bump ausloesen');
});

runTest('N3: kein Treffer in der Counts-Datei (count undefined/null) → keine Aenderung', function() {
  const m = kagurabachiSeries();
  assert.strictEqual(bridgedTotalForCount(m, null), null);
  assert.strictEqual(bridgedTotalForCount(m, undefined), null);
});

// ─── Tests: bridgedTotalForCount — Kanten ─────────────────────────────────

console.log('\n── bridgedTotalForCount: Kanten ───────────────────────────');

runTest('K1: Mehrfach-Treffer in der Counts-Datei → Match-Helfer liefert null → kein Bump', function() {
  const m = kagurabachiSeries();
  const doc = countsDoc([
    kagurabachiCount({ publisher: 'Carlsen Manga' }),
    kagurabachiCount({ publisher: 'Carlsen Manga', sourceUrl: 'https://www.manga-passion.de/editions/9999' }),
  ]);
  const count = findReleaseVolumeCountForSeries(m, doc);
  assert.strictEqual(count, null, 'Mehrdeutiger Treffer muss null liefern');
  assert.strictEqual(bridgedTotalForCount(m, count), null);
});

runTest('K2: published <= total, auch deutlich niedriger (published 8 < total 20) → nie senken', function() {
  const m = kagurabachiSeries();
  m.total = 20; // manuell hoeher gepflegt
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(result, null, 'Eine hoehere, manuell gepflegte Zahl darf nie heruntergedrueckt werden');
});

runTest('K3a: total leer (undefined) und published > 0 → Erstbelegung mit published', function() {
  const m = kagurabachiSeries();
  delete m.total;
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(result, 8);
});

runTest('K3b: total NaN und published > 0 → Erstbelegung mit published', function() {
  const m = kagurabachiSeries();
  m.total = NaN;
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(result, 8);
});

runTest('K3c: total 0 und published > 0 → Erstbelegung mit published', function() {
  const m = kagurabachiSeries();
  m.total = 0;
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(result, 8);
});

runTest('K4a: publishedVolumesDE 0 → kein Bump (defensiv)', function() {
  const m = kagurabachiSeries();
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 0 }));
  assert.strictEqual(result, null);
});

runTest('K4b: publishedVolumesDE negativ → kein Bump (defensiv)', function() {
  const m = kagurabachiSeries();
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: -3 }));
  assert.strictEqual(result, null);
});

runTest('K4c: publishedVolumesDE nicht-integer (2.5) → kein Bump (defensiv)', function() {
  const m = kagurabachiSeries();
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 2.5 }));
  assert.strictEqual(result, null);
});

runTest('K4d: publishedVolumesDE fehlend/undefined → kein Bump (defensiv)', function() {
  const m = kagurabachiSeries();
  const count = kagurabachiCount();
  delete count.publishedVolumesDE;
  const result = bridgedTotalForCount(m, count);
  assert.strictEqual(result, null);
});

runTest('K4e: publishedVolumesDE nicht-numerischer String ("viele") → kein Bump (defensiv)', function() {
  const m = kagurabachiSeries();
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 'viele' }));
  assert.strictEqual(result, null);
});

runTest('K5: Besessene Baende > published (Datenanomalie, Band 9 vorhanden, published 8) — ' +
  'total wird hoechstens auf published gehoben, nie gesenkt', function() {
  // Fall a: total bereits korrekt auf 9 gesetzt (Anomalie schon reflektiert) → published(8) <= total(9) → keine Aenderung
  const mA = kagurabachiSeries();
  mA.total = 9;
  mA.bands = ownedBands(1, 9);
  const resultA = bridgedTotalForCount(mA, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(resultA, null, 'total(9) darf wegen published(8) nicht gesenkt werden');
  assert.strictEqual(Object.keys(mA.bands).length, 9, 'bands bleiben unberuehrt');

  // Fall b: total noch nicht gesetzt (NaN), aber schon 9 Baende besessen → Erstbelegung hoechstens auf published (8)
  const mB = kagurabachiSeries();
  mB.total = NaN;
  mB.bands = ownedBands(1, 9);
  const resultB = bridgedTotalForCount(mB, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(resultB, 8, 'Erstbelegung darf hoechstens auf published (8) heben, nicht mehr');
});

runTest('K6: Wishlist-Serie — Bruecke setzt nur total, Status/Sichtbarkeitsregeln unveraendert', function() {
  const m = { id: 'w1', title: 'Kagurabachi', pub: 'Carlsen Manga', status: 'wishlist', total: NaN, bands: {} };
  const result = bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 5 }));
  assert.strictEqual(result, 5);
  m.total = result;
  assert.strictEqual(m.status, 'wishlist', 'status bleibt unangetastet — Bruecke kennt kein Status-Sonderverhalten');
  assert.deepStrictEqual(m.bands, {}, 'bands bleiben unangetastet');
  // toBuyList-Sichtbarkeit haengt weiterhin ausschliesslich von total/owned/mFirstMissingBand ab,
  // nicht von status — die Bruecke fuehrt kein neues Status-Sonderverhalten ein.
  const list = toBuyListMirror([m]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].next, 1, 'ohne besessene Baende ist Band 1 der erste fehlende');
});

// ─── Tests: m.bands bleibt in ALLEN Faellen unangetastet ──────────────────

console.log('\n── m.bands unangetastet (alle Faelle) ─────────────────────');

runTest('B1: m.bands-Referenz und -Inhalt unveraendert nach bridgedTotalForCount (Bump-Fall)', function() {
  const m = kagurabachiSeries();
  const bandsRef = m.bands;
  const bandsSnapshot = JSON.parse(JSON.stringify(m.bands));
  const result = bridgedTotalForCount(m, kagurabachiCount());
  assert.strictEqual(result, 8);
  assert.strictEqual(m.bands, bandsRef, 'bands-Objektreferenz darf sich nicht aendern');
  assert.deepStrictEqual(m.bands, bandsSnapshot, 'bands-Inhalt darf sich nicht aendern');
});

runTest('B2: m.bands unveraendert, wenn bridgedTotalForCount null liefert (kein Treffer)', function() {
  const m = kagurabachiSeries();
  const bandsRef = m.bands;
  const bandsSnapshot = JSON.parse(JSON.stringify(m.bands));
  bridgedTotalForCount(m, null);
  assert.strictEqual(m.bands, bandsRef);
  assert.deepStrictEqual(m.bands, bandsSnapshot);
});

runTest('B3: m.bands unveraendert bei published <= total (keine Aenderung)', function() {
  const m = kagurabachiSeries();
  m.total = 20;
  const bandsRef = m.bands;
  bridgedTotalForCount(m, kagurabachiCount({ publishedVolumesDE: 8 }));
  assert.strictEqual(m.bands, bandsRef);
});

runTest('B4: m.bands unveraendert nach reconcileReleaseVolumeTotalsMirror-Lauf', function() {
  const m = kagurabachiSeries();
  const bandsRef = m.bands;
  const bandsSnapshot = JSON.parse(JSON.stringify(m.bands));
  const doc = countsDoc([kagurabachiCount()]);
  reconcileReleaseVolumeTotalsMirror([m], doc);
  assert.strictEqual(m.total, 8, 'total wurde gebumpt');
  assert.strictEqual(m.bands, bandsRef, 'bands-Referenz bleibt unveraendert');
  assert.deepStrictEqual(m.bands, bandsSnapshot, 'bands-Inhalt bleibt unveraendert');
});

// ─── Tests: Akzeptanz-Leitfall End-to-End (toBuyList) ─────────────────────

console.log('\n── Akzeptanz-Leitfall: Kagurabachi in toBuyList() ─────────');

runTest('E2E1: Vor der Bruecke erscheint Kagurabachi NICHT in toBuyList() (total 7, Baende 1-7 komplett)', function() {
  const m = kagurabachiSeries();
  const list = toBuyListMirror([m]);
  assert.strictEqual(list.length, 0, 'mFirstMissingBand liefert null, solange total=7 und 1-7 besessen sind');
});

runTest('E2E2: Nach reconcileReleaseVolumeTotalsMirror erscheint Kagurabachi mit next=8 in toBuyList()', function() {
  const m = kagurabachiSeries();
  const doc = countsDoc([kagurabachiCount()]);
  const changed = reconcileReleaseVolumeTotalsMirror([m], doc);
  assert.strictEqual(changed, true);
  assert.strictEqual(m.total, 8);
  const list = toBuyListMirror([m]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'kb1');
  assert.strictEqual(list[0].next, 8, 'Akzeptanzkriterium: naechster fehlender Band ist 8');
});

// ─── Tests: reconcileReleaseVolumeTotalsMirror — Treiber-Verhalten ────────

console.log('\n── reconcileReleaseVolumeTotalsMirror: Treiber-Verhalten ──');

runTest('R1: No-op (false), wenn releaseVolumeCounts nicht geladen ist (null)', function() {
  const m = kagurabachiSeries();
  const changed = reconcileReleaseVolumeTotalsMirror([m], null);
  assert.strictEqual(changed, false);
  assert.strictEqual(m.total, 7, 'total unveraendert, solange Counts fehlen');
});

runTest('R2: No-op (false), wenn releaseVolumeCounts.items kein Array ist', function() {
  const m = kagurabachiSeries();
  const changed = reconcileReleaseVolumeTotalsMirror([m], { schemaVersion: 1 });
  assert.strictEqual(changed, false);
});

runTest('R3: No-op (false), wenn db.m kein Array ist', function() {
  const doc = countsDoc([kagurabachiCount()]);
  const changed = reconcileReleaseVolumeTotalsMirror(null, doc);
  assert.strictEqual(changed, false);
});

runTest('R4: Idempotenz — zweiter Lauf ohne neue Daten liefert changed=false, total bleibt stabil', function() {
  const m = kagurabachiSeries();
  const doc = countsDoc([kagurabachiCount()]);
  const firstRun = reconcileReleaseVolumeTotalsMirror([m], doc);
  assert.strictEqual(firstRun, true);
  assert.strictEqual(m.total, 8);
  const secondRun = reconcileReleaseVolumeTotalsMirror([m], doc);
  assert.strictEqual(secondRun, false, 'zweiter Lauf darf nichts mehr aendern');
  assert.strictEqual(m.total, 8, 'total bleibt stabil');
});

runTest('R5: Mehrere Serien — nur die bumpbare Serie aendert sich, andere bleiben unberuehrt', function() {
  const kb = kagurabachiSeries();
  const unrelated = { id: 'u1', title: 'One Piece', pub: 'Carlsen Manga', total: 105, bands: ownedBands(1, 105) };
  const doc = countsDoc([kagurabachiCount()]); // enthaelt nur Kagurabachi
  const changed = reconcileReleaseVolumeTotalsMirror([kb, unrelated], doc);
  assert.strictEqual(changed, true);
  assert.strictEqual(kb.total, 8);
  assert.strictEqual(unrelated.total, 105, 'Serie ohne Treffer bleibt unangetastet');
});

// ─── Tests: Fehlerfall — ungueltiges Dokument wird beim Laden abgelehnt ───

console.log('\n── Fehlerfall: validateReleaseVolumeCountsClient ──────────');

runTest('F1: Dokument mit confidence != "high" wird von der Schema-Validierung insgesamt verworfen', function() {
  // Der Client-Loader (validateReleaseVolumeCountsClient, src/app.js:4184-4194) erzwingt
  // confidence==='high' pro Item; ist auch nur ein Item ungueltig, wird das GESAMTE
  // Dokument verworfen (releaseVolumeCounts bleibt null/nicht geladen) — die Bruecke
  // sieht solche Daten also strukturell nie. Das ist die im Coder-changes.md referenzierte
  // "Match-Helfer filtert das" — praeziser: der Loader filtert es vor dem Match.
  const doc = countsDoc([kagurabachiCount({ confidence: 'medium' })]);
  const isValid = validateReleaseVolumeCountsClient(doc);
  assert.strictEqual(isValid, false, 'Dokument mit nicht-high-confidence-Item darf nicht geladen werden');
});

runTest('F2: Fehlerfall — kaputtes/fremdes Schema (kein items-Array) wird abgelehnt, kein Crash', function() {
  assert.strictEqual(validateReleaseVolumeCountsClient(null), false);
  assert.strictEqual(validateReleaseVolumeCountsClient({}), false);
  assert.strictEqual(validateReleaseVolumeCountsClient({ schemaVersion: 1, items: 'kaputt' }), false);
  assert.strictEqual(validateReleaseVolumeCountsClient({ schemaVersion: 2, items: [] }), false);
});

runTest('F3: reconcileReleaseVolumeTotalsMirror crasht nicht bei leerem db.m-Array', function() {
  const doc = countsDoc([kagurabachiCount()]);
  let changed;
  assert.doesNotThrow(() => { changed = reconcileReleaseVolumeTotalsMirror([], doc); });
  assert.strictEqual(changed, false);
});

// ─── Abschlussbericht ───────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
if (_failed > 0) {
  process.exit(1);
}
