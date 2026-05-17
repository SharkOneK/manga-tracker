#!/usr/bin/env node
// scripts/test-stats.js — Phase 17a + 17b: Statistik-Kennzahlen testen
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

// ─── Phase 17b: Sammlungsstatus-Verteilung ────────────────────────────────

// Spiegelt mSeriesStatus(m) aus app.js
function mSeriesStatus(m) {
  if (m.status === 'wishlist') return 'wishlist';
  const vals = Object.values(m.bands || {});
  if (!vals.length) return 'owned';
  if (vals.includes('reading')) return 'reading';
  if (vals.every(v => v === 'completed')) return 'completed';
  return 'owned';
}

function calcStatusCounts(mangaList) {
  const counts = { reading: 0, completed: 0, owned: 0, wishlist: 0 };
  mangaList.forEach(m => {
    const st = mSeriesStatus(m);
    if (counts[st] !== undefined) counts[st]++;
  });
  return counts;
}

// ─── Phase 17b: Kaufvorschau ──────────────────────────────────────────────

function calcBuyPreview(mangaList, maxItems = 5) {
  const today = new Date(); today.setHours(0,0,0,0);
  return mangaList
    .filter(m => {
      const total = Number(m.total);
      const owned = mOwned(m);
      if (isNaN(total) || total <= 0 || total <= owned) return false;
      return mFirstMissingBand(m) !== null;
    })
    .map(m => ({ ...m, next: mFirstMissingBand(m) }))
    .sort((a, b) => {
      const da  = a.nextDate ? new Date(a.nextDate) : null;
      const db2 = b.nextDate ? new Date(b.nextDate) : null;
      const aAvail = !da  || da  <= today;
      const bAvail = !db2 || db2 <= today;
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return  1;
      if (da && db2) return da - db2;
      if (da && !db2) return -1;
      if (!da && db2) return  1;
      return a.title.localeCompare(b.title, 'de');
    })
    .slice(0, maxItems);
}

// Phase 17c: Release-cache stats (mirrors renderStats; gated by loaded status)
function calcReleaseCacheStats(mangaList, cache, status, baseDate = '2026-05-17') {
  if (status !== 'loaded' || !cache || !Array.isArray(cache.items)) return null;
  const today = new Date(baseDate + 'T00:00:00');
  const in30Days = new Date(today);
  in30Days.setDate(in30Days.getDate() + 30);
  const upcoming30 = cache.items.filter(item => {
    if (!item || !item.releaseDate) return false;
    const d = new Date(item.releaseDate + 'T00:00:00');
    return !isNaN(d.getTime()) && d >= today && d <= in30Days;
  }).length;
  return {
    seriesWithNextDate: mangaList.filter(m => !!m.nextDate).length,
    upcoming30,
    seriesWithReleaseIds: mangaList.filter(m => !!m.isbn13 || (!!m.mpEditionId && m.mpEditionId !== 'none')).length,
    itemCount: cache.items.length,
    generatedAt: cache.generatedAt || null,
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

// ─── Phase 17b Tests ─────────────────────────────────────────────────────

console.log('\nPhase 17b — Sammlungsstatus & Kaufvorschau Tests\n');

test('Sammlungsstatus: Leere Sammlung — alle Werte 0', () => {
  const c = calcStatusCounts([]);
  assert.strictEqual(c.reading,   0);
  assert.strictEqual(c.completed, 0);
  assert.strictEqual(c.owned,     0);
  assert.strictEqual(c.wishlist,  0);
});

test('Sammlungsstatus: Wishlist via m.status === wishlist', () => {
  const list = [{ status: 'wishlist', bands: {}, total: null }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.wishlist, 1);
  assert.strictEqual(c.reading,  0);
  assert.strictEqual(c.owned,    0);
});

test('Sammlungsstatus: Serie ohne Bände → owned', () => {
  const list = [{ bands: {}, total: 5, ongoing: 'true' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.owned, 1, 'Serie ohne bands-Einträge zählt als owned');
});

test('Sammlungsstatus: Alle Bände completed → completed', () => {
  const list = [{ bands: { '1': 'completed', '2': 'completed' }, total: 2, ongoing: 'false' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.completed, 1);
  assert.strictEqual(c.reading,   0);
});

test('Sammlungsstatus: Ein Band reading → reading', () => {
  const list = [{ bands: { '1': 'owned', '2': 'reading' }, total: 5, ongoing: 'true' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.reading, 1);
  assert.strictEqual(c.owned,   0);
});

test('Sammlungsstatus: Gemischte Sammlung — alle vier Werte korrekt', () => {
  const list = [
    { status: 'wishlist', bands: {},                                total: null  },
    { bands: { '1': 'reading', '2': 'owned' },                     total: 5     },
    { bands: { '1': 'completed', '2': 'completed' },               total: 2     },
    { bands: { '1': 'owned' },                                     total: 3     },
    { bands: { '1': 'owned' },                                     total: 3     },
  ];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.wishlist,  1);
  assert.strictEqual(c.reading,   1);
  assert.strictEqual(c.completed, 1);
  assert.strictEqual(c.owned,     2);
  assert.strictEqual(c.reading + c.completed + c.owned + c.wishlist, list.length,
    'Summe muss Gesamtanzahl ergeben');
});

test('Kaufvorschau: Leere Sammlung → leeres Array, kein Fehler', () => {
  const result = calcBuyPreview([]);
  assert.strictEqual(result.length, 0);
});

test('Kaufvorschau: Vollständige Serie erscheint nicht', () => {
  const list = [{
    title: 'Vollständige Serie', pub: 'Test',
    bands: { '1': 'owned', '2': 'owned', '3': 'owned' },
    total: 3, ongoing: 'false', nextDate: null,
  }];
  const result = calcBuyPreview(list);
  assert.strictEqual(result.length, 0, 'Vollständige Serie darf nicht in der Kaufvorschau erscheinen');
});

test('Kaufvorschau: Serie mit fehlendem Band erscheint', () => {
  const list = [{
    title: 'Lückenserie', pub: 'Test',
    bands: { '1': 'owned', '2': 'owned' },
    total: 5, ongoing: 'true', nextDate: null,
  }];
  const result = calcBuyPreview(list);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].next, 3, 'Erste fehlende Bandnummer muss 3 sein');
});

test('Kaufvorschau: Serie mit Lücke nutzt erste fehlende Bandnummer', () => {
  const list = [{
    title: 'Lückenserie', pub: 'Test',
    bands: { '1': 'owned', '3': 'owned' }, // Band 2 fehlt
    total: 5, ongoing: 'true', nextDate: null,
  }];
  const result = calcBuyPreview(list);
  assert.strictEqual(result[0].next, 2, 'Erste fehlende Bandnummer muss 2 sein, nicht 4');
});

test('Kaufvorschau: Maximal 5 Einträge (maxItems-Limit)', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({
    title: `Serie ${i+1}`, pub: 'Test',
    bands: { '1': 'owned' },
    total: 5, ongoing: 'true', nextDate: null,
  }));
  const result = calcBuyPreview(list, 5);
  assert.strictEqual(result.length, 5, 'Kaufvorschau muss auf maxItems begrenzt sein');
});

test('Kaufvorschau: Konfigurierbares maxItems', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({
    title: `Serie ${i+1}`, pub: 'Test',
    bands: { '1': 'owned' },
    total: 3, ongoing: 'true', nextDate: null,
  }));
  assert.strictEqual(calcBuyPreview(list, 3).length, 3);
  assert.strictEqual(calcBuyPreview(list, 1).length, 1);
});

test("Kaufvorschau: Serie mit ongoing 'unknown' und fehlendem Band erscheint", () => {
  const list = [{
    title: 'Unbekannte Serie', pub: 'Test',
    bands: { '1': 'owned' },
    total: 4, ongoing: 'unknown', nextDate: null,
  }];
  const result = calcBuyPreview(list);
  assert.strictEqual(result.length, 1, "ongoing: 'unknown' darf in der Kaufvorschau erscheinen");
  assert.strictEqual(result[0].next, 2);
});

test('Kaufvorschau: Serie ohne total nicht in der Vorschau', () => {
  const list = [{
    title: 'Kein Total', pub: 'Test',
    bands: { '1': 'owned' },
    total: null, ongoing: 'true', nextDate: null,
  }];
  const result = calcBuyPreview(list);
  assert.strictEqual(result.length, 0, 'Serie ohne total darf nicht in der Kaufvorschau erscheinen');
});

// Phase 17c Tests ----------------------------------------------------------

console.log('\nPhase 17c — Release-Cache-Statistiken Tests\n');

test('Release-Cache-Stats: nicht geladener Cache rendert keine Stats', () => {
  const result = calcReleaseCacheStats([{ nextDate: '2026-06-01' }], { items: [] }, 'missing');
  assert.strictEqual(result, null);
});

test('Release-Cache-Stats: zaehlt Serien mit nextDate', () => {
  const list = [
    { title: 'A', nextDate: '2026-06-01' },
    { title: 'B', nextDate: null },
    { title: 'C', nextDate: '2026-07-01' },
  ];
  const result = calcReleaseCacheStats(list, { items: [] }, 'loaded');
  assert.strictEqual(result.seriesWithNextDate, 2);
});

test('Release-Cache-Stats: zaehlt kommende Releases in den naechsten 30 Tagen inkl. heute', () => {
  const cache = { items: [
    { releaseDate: '2026-05-17' },
    { releaseDate: '2026-06-16' },
    { releaseDate: '2026-06-17' },
    { releaseDate: '2026-05-16' },
    { releaseDate: 'ungueltig' },
  ] };
  const result = calcReleaseCacheStats([], cache, 'loaded', '2026-05-17');
  assert.strictEqual(result.upcoming30, 2);
});

test('Release-Cache-Stats: zaehlt Serien mit ISBN-13 oder Manga-Passion-ID', () => {
  const list = [
    { title: 'A', isbn13: '9783551737649' },
    { title: 'B', mpEditionId: 1234 },
    { title: 'C', mpEditionId: 'none' },
    { title: 'D' },
  ];
  const result = calcReleaseCacheStats(list, { items: [] }, 'loaded');
  assert.strictEqual(result.seriesWithReleaseIds, 2);
});
// ─── Ergebnis ─────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} Tests — ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
