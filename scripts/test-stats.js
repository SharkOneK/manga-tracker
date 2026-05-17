#!/usr/bin/env node
// scripts/test-stats.js — Phase 17a: Statistik-Kennzahlen testen
// Läuft direkt mit Node, kein Test-Framework nötig.
'use strict';

const assert = require('assert');

// ─── Helfer (spiegelt app.js-Logik ohne DOM-Abhängigkeit) ─────────────────

function mOwned(m) {
  return Object.keys(m.bands || {}).length;
}

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

// ─── Neue Statistik-Berechnungen aus renderStats() ────────────────────────

function calcStats(mangaList) {
  const totalVols = mangaList.reduce((s, m) => s + mOwned(m), 0);

  const totalKnown = mangaList.reduce((s, m) => {
    const t = Number(m.total);
    return s + (isNaN(t) || t <= 0 ? 0 : t);
  }, 0);

  const totalMissing = mangaList.reduce((s, m) => {
    const t = Number(m.total);
    if (isNaN(t) || t <= 0) return s;
    return s + Math.max(0, t - mOwned(m));
  }, 0);

  const buyProgress = totalKnown > 0
    ? Math.round((totalVols / totalKnown) * 100)
    : null;

  const completeSeries = mangaList.filter(m => {
    const t = Number(m.total);
    return !isNaN(t) && t > 0 && mFirstMissingBand(m) === null;
  }).length;

  const seriesWithMissing = mangaList.filter(m => {
    const t = Number(m.total);
    return !isNaN(t) && t > 0 && mFirstMissingBand(m) !== null;
  }).length;

  const ongoingCount  = mangaList.filter(m => m.ongoing === 'true').length;
  const finishedCount = mangaList.filter(m => m.ongoing === 'false').length;
  const unknownCount  = mangaList.filter(m => m.ongoing !== 'true' && m.ongoing !== 'false').length;

  return {
    totalVols, totalKnown, totalMissing, buyProgress,
    completeSeries, seriesWithMissing,
    ongoingCount, finishedCount, unknownCount,
  };
}

// ─── Test-Runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ─── Test-Cases ───────────────────────────────────────────────────────────

console.log('\nPhase 17a — Statistik-Kennzahlen Tests\n');

test('Leere Sammlung — alle Werte 0, buyProgress null (kein NaN)', () => {
  const s = calcStats([]);
  assert.strictEqual(s.totalVols, 0);
  assert.strictEqual(s.totalKnown, 0);
  assert.strictEqual(s.totalMissing, 0);
  assert.strictEqual(s.buyProgress, null, 'buyProgress muss null sein, kein NaN');
  assert.strictEqual(s.completeSeries, 0);
  assert.strictEqual(s.seriesWithMissing, 0);
  assert.strictEqual(s.ongoingCount, 0);
  assert.strictEqual(s.finishedCount, 0);
  assert.strictEqual(s.unknownCount, 0);
});

test('Serie ohne total — zählt nicht in totalKnown und totalMissing', () => {
  const list = [{ bands: { '1': 'owned', '2': 'owned' }, total: null, ongoing: 'true' }];
  const s = calcStats(list);
  assert.strictEqual(s.totalKnown, 0, 'total: null darf nicht in totalKnown zählen');
  assert.strictEqual(s.totalMissing, 0, 'total: null darf nicht in totalMissing zählen');
  assert.strictEqual(s.totalVols, 2, 'besessene Bände müssen trotzdem zählen');
});

test('Vollständige Serie (owned = total) — completeSeries++', () => {
  const list = [{
    bands: { '1': 'owned', '2': 'owned', '3': 'owned' },
    total: 3,
    ongoing: 'false',
  }];
  const s = calcStats(list);
  assert.strictEqual(s.completeSeries, 1);
  assert.strictEqual(s.seriesWithMissing, 0);
  assert.strictEqual(s.totalMissing, 0);
});

test('Serie mit fehlenden Bänden — totalMissing steigt, seriesWithMissing++', () => {
  const list = [{
    bands: { '1': 'owned', '3': 'owned' }, // Band 2 fehlt
    total: 5,
    ongoing: 'true',
  }];
  const s = calcStats(list);
  assert.strictEqual(s.seriesWithMissing, 1, 'seriesWithMissing muss 1 sein');
  assert.strictEqual(s.totalMissing, 3, 'total 5 - owned 2 = 3 fehlend');
  assert.strictEqual(s.completeSeries, 0);
});

test("ongoing: 'true' — ongoingCount++", () => {
  const list = [
    { bands: {}, total: null, ongoing: 'true' },
    { bands: {}, total: null, ongoing: 'true' },
  ];
  const s = calcStats(list);
  assert.strictEqual(s.ongoingCount, 2);
  assert.strictEqual(s.finishedCount, 0);
  assert.strictEqual(s.unknownCount, 0);
});

test("ongoing: 'false' — finishedCount++", () => {
  const list = [{ bands: { '1': 'owned' }, total: 1, ongoing: 'false' }];
  const s = calcStats(list);
  assert.strictEqual(s.finishedCount, 1);
  assert.strictEqual(s.ongoingCount, 0);
  assert.strictEqual(s.unknownCount, 0);
});

test("ongoing: 'unknown' — unknownCount++", () => {
  const list = [{ bands: {}, total: null, ongoing: 'unknown' }];
  const s = calcStats(list);
  assert.strictEqual(s.unknownCount, 1);
  assert.strictEqual(s.ongoingCount, 0);
  assert.strictEqual(s.finishedCount, 0);
});

test('Fehlender ongoing-Wert zählt als unknown (undefined, null, fehlendes Feld)', () => {
  const list = [
    { bands: {}, total: null, ongoing: undefined },
    { bands: {}, total: null, ongoing: null },
    { bands: {}, total: null },
  ];
  const s = calcStats(list);
  assert.strictEqual(s.unknownCount, 3, 'Alle fehlenden Werte müssen als unknown zählen');
  assert.strictEqual(s.ongoingCount, 0);
  assert.strictEqual(s.finishedCount, 0);
});

test('Gemischte Sammlung — buyProgress korrekt gerundet', () => {
  const list = [
    { bands: { '1': 'owned', '2': 'owned' }, total: 4, ongoing: 'true' },   // 2/4
    { bands: { '1': 'owned' },               total: 2, ongoing: 'false' },  // 1/2
    { bands: {},                              total: null, ongoing: 'unknown' }, // ignoriert
  ];
  const s = calcStats(list);
  // totalKnown = 6, totalVols = 3 → 3/6 = 50 %
  assert.strictEqual(s.totalKnown, 6);
  assert.strictEqual(s.totalVols, 3);
  assert.strictEqual(s.buyProgress, 50);
  assert.strictEqual(s.totalMissing, 3, '(4-2) + (2-1) = 3 fehlend');
  assert.strictEqual(s.ongoingCount, 1);
  assert.strictEqual(s.finishedCount, 1);
  assert.strictEqual(s.unknownCount, 1);
});

test('Laufende Serie vollständig gesammelt — completeSeries (nicht auf ongoing:false beschränkt)', () => {
  const list = [{
    bands: { '1': 'owned', '2': 'owned', '3': 'owned' },
    total: 3,
    ongoing: 'true', // laufend, aber bis jetzt alle Bände besessen
  }];
  const s = calcStats(list);
  assert.strictEqual(s.completeSeries, 1, 'Muss vollständig gesammelt zählen');
  assert.strictEqual(s.seriesWithMissing, 0);
});

// ─── Ergebnis ─────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} Tests — ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
