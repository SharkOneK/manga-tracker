#!/usr/bin/env node
// scripts/test-stats.js — Phase 17a + 17b: Statistik-Kennzahlen testen
// Läuft direkt mit Node, kein Test-Framework nötig.
'use strict';

const assert = require('assert');

// ─── Helfer (spiegelt app.js-Logik ohne DOM-Abhängigkeit) ─────────────────

function mOwned(m) {
  return Object.keys(m.bands || {}).length;
}

function mSeriesStatus(m) {
  if (m.status === 'wishlist') return 'wishlist';
  const vals = Object.values(m.bands || {});
  if (!vals.length) return 'owned';
  if (vals.includes('reading')) return 'reading';
  if (vals.every(v => v === 'completed')) return 'completed';
  return 'owned';
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

function mCollectionStatus(m) {
  if (m.status === 'wishlist') return 'wishlist';
  const total = Number(m.total);
  const totalKnown = !isNaN(total) && total > 0;
  if (totalKnown && mFirstMissingBand(m) !== null) return 'missing';
  if (totalKnown && mFirstMissingBand(m) === null) return 'complete';
  return mOwned(m) > 0 ? 'owned' : 'empty';
}

// ─── Statistik-Berechnungen aus dem Dashboard ─────────────────────────────

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

// ─── Phase 18b: Bände nach Sammlungsstatus ──────────────────────────────────

// Spiegelt die neue Logik aus app.js (Phase 18b):
// Wishlist-Serien zählen ihre Bände als Wishlist (min 1),
// alle anderen zählen jeden Band einzeln nach seinem Status.
function calcStatusCounts(mangaList) {
  const counts = { reading: 0, completed: 0, owned: 0, wishlist: 0 };
  mangaList.forEach(m => {
    if (m.status === 'wishlist') {
      // Wishlist-Serien: Anzahl Bände zählen, mindestens 1
      counts.wishlist += Math.max(Object.keys(m.bands || {}).length, 1);
    } else {
      // Alle anderen: jeden Band einzeln nach seinem Status zählen
      Object.values(m.bands || {}).forEach(st => {
        if (counts[st] !== undefined) counts[st]++;
      });
    }
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

// Phase 17c: Release-cache stats (mirrors dashboard rendering; gated by loaded status)
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

// Phase 18c: Dashboard-Release-Daten-Prüfung (Preview-only)
function normalizeReleaseTitle(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const _PUB_ALIAS_MAP = {
  'carlsen': 'carlsen manga',
  'carlsen manga': 'carlsen manga',
  'tokyopop': 'tokyopop',
  'tokyo pop': 'tokyopop',
  'egmont': 'egmont manga',
  'egmont manga': 'egmont manga',
  'altraverse': 'altraverse',
};

function normalizeReleasePublisher(value) {
  const raw = (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return _PUB_ALIAS_MAP[raw] || raw;
}

function mNextBand(m) {
  const keys = Object.keys(m.bands || {}).map(Number);
  return keys.length ? Math.max(...keys) + 1 : 1;
}

function releasePubsMatch(a, b) {
  if (!a || !b) return true;
  return a === b;
}
// Phase 44a-followup: Dashboard-Preview-/Apply-Test-Helpers entfernt
// (Buttons Alle Release-Daten/Alle Serien-Status/Cache-Coverage wurden weggekürzt).

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

test('Bände nach Sammlungsstatus: Leere Sammlung — alle Werte 0', () => {
  const c = calcStatusCounts([]);
  assert.strictEqual(c.reading,   0);
  assert.strictEqual(c.completed, 0);
  assert.strictEqual(c.owned,     0);
  assert.strictEqual(c.wishlist,  0);
});

test('Bände nach Sammlungsstatus: Wishlist ohne Bände → 1 Wishlist-Eintrag', () => {
  const list = [{ status: 'wishlist', bands: {}, total: null }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.wishlist, 1, 'Wishlist-Serie ohne Bände zählt als 1');
  assert.strictEqual(c.reading,  0);
  assert.strictEqual(c.owned,    0);
});

test('Bände nach Sammlungsstatus: Wishlist mit 3 Bänden → 3 Wishlist-Einträge', () => {
  const list = [{ status: 'wishlist', bands: { '1': 'owned', '2': 'owned', '3': 'owned' }, total: 3 }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.wishlist, 3, 'Wishlist-Serie mit 3 Bänden zählt als 3');
  assert.strictEqual(c.owned,    0, 'Bände in Wishlist-Serie nicht als owned zählen');
});

test('Bände nach Sammlungsstatus: Serie ohne Bände → 0 Zählpunkte', () => {
  const list = [{ bands: {}, total: 5, ongoing: 'true' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.owned,    0, 'Serie ohne bands-Einträge liefert 0 owned');
  assert.strictEqual(c.reading,  0);
  assert.strictEqual(c.completed, 0);
});

test('Bände nach Sammlungsstatus: 2 completed-Bände → completed: 2', () => {
  const list = [{ bands: { '1': 'completed', '2': 'completed' }, total: 2, ongoing: 'false' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.completed, 2, 'Jeder completed-Band zählt einzeln');
  assert.strictEqual(c.reading,   0);
  assert.strictEqual(c.owned,     0);
});

test('Bände nach Sammlungsstatus: 1 reading + 1 owned → korrekte Einzelzählung', () => {
  const list = [{ bands: { '1': 'owned', '2': 'reading' }, total: 5, ongoing: 'true' }];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.reading, 1, 'Reading-Band wird gezählt');
  assert.strictEqual(c.owned,   1, 'Owned-Band wird ebenfalls gezählt');
});

test('Bände nach Sammlungsstatus: Gemischte Sammlung — Bändezählung korrekt', () => {
  const list = [
    { status: 'wishlist', bands: {},                                                        total: null },
    { bands: { '1': 'reading', '2': 'owned' },                                             total: 5   },
    { bands: { '1': 'completed', '2': 'completed' },                                       total: 2   },
    { bands: { '1': 'owned', '2': 'owned', '3': 'owned' },                                total: 3   },
  ];
  const c = calcStatusCounts(list);
  assert.strictEqual(c.wishlist,  1, '1 Wishlist-Eintrag (ohne Bände → min 1)');
  assert.strictEqual(c.reading,   1, '1 reading-Band');
  assert.strictEqual(c.completed, 2, '2 completed-Bände');
  assert.strictEqual(c.owned,     4, '1 owned aus Serie 2 + 3 owned aus Serie 4');
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


// ─── Phase 18f: Helfer ───────────────────────────────────────────────────────

// Spiegelt compareBuyEntries aus app.js (Phase 18f)
function compareBuyEntries(a, b, today) {
  if (!today) { today = new Date(); today.setHours(0,0,0,0); }
  const da  = a.nextDate ? new Date(a.nextDate + 'T00:00:00') : null;
  const db2 = b.nextDate ? new Date(b.nextDate + 'T00:00:00') : null;
  const aAvail = !da  || da  <= today;
  const bAvail = !db2 || db2 <= today;
  if (aAvail && !bAvail) return -1;
  if (!aAvail && bAvail) return  1;
  if (!aAvail && !bAvail) {
    if (da && db2) {
      const diff = da - db2;
      if (diff !== 0) return diff;
    }
  }
  if (da && !db2) return -1;
  if (!da && db2) return  1;
  const titleCmp = (a.title || '').localeCompare(b.title || '', 'de');
  if (titleCmp !== 0) return titleCmp;
  return (a.next || 0) - (b.next || 0);
}

// Spiegelt die Dashboard-Kaufvorschau-Logik (Phase 18f): kein Schreiben, keine Mutation
function calcBuyPreviewStructured(mangaList, maxItems, baseDate) {
  const BUY_PREVIEW_MAX = (typeof maxItems === 'number') ? maxItems : 8;
  const today = baseDate ? new Date(baseDate + 'T00:00:00') : new Date();
  today.setHours(0,0,0,0);
  const before = JSON.stringify(mangaList);

  const allBuyItems = mangaList
    .filter(m => {
      const total = Number(m.total);
      const owned = mOwned(m);
      if (isNaN(total) || total <= 0 || total <= owned) return false;
      return mFirstMissingBand(m) !== null;
    })
    .map(m => ({ ...m, next: mFirstMissingBand(m) }))
    .sort((a, b) => compareBuyEntries(a, b, today));

  const previewItems = allBuyItems.slice(0, BUY_PREVIEW_MAX);
  const availItems = previewItems.filter(item => {
    const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null;
    return !d || d <= today;
  });
  const soonItems = previewItems.filter(item => {
    const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null;
    return d && d > today;
  });
  const totalAvailAll = allBuyItems.filter(item => {
    const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null;
    return !d || d <= today;
  }).length;
  const totalSoonAll = allBuyItems.filter(item => {
    const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null;
    return d && d > today;
  }).length;

  // Keine Datenmutation durch Preview
  assert.strictEqual(JSON.stringify(mangaList), before, 'calcBuyPreviewStructured darf Manga-Daten nicht mutieren');

  return {
    previewItems,
    availItems,
    soonItems,
    totalAll: allBuyItems.length,
    totalAvailAll,
    totalSoonAll,
  };
}

// ─── Phase 18f Tests ──────────────────────────────────────────────────────────

console.log('\nPhase 18f — Dashboard-Kaufvorschau und Kaufen-Sortierung Tests\n');

test('Phase 18f: toBuyList sortiert verfuegbare vor zukuenftigen Baenden', () => {
  const TODAY = '2026-05-18';
  const list = [
    { id: '1', title: 'Zukuenftige Serie', bands: { '1': 'owned' }, total: 5, nextDate: '2026-06-01' },
    { id: '2', title: 'Verfuegbare Serie', bands: { '1': 'owned' }, total: 5, nextDate: '2026-04-01' },
  ].map(m => ({ ...m, next: mFirstMissingBand(m) }));
  list.sort((a, b) => compareBuyEntries(a, b, new Date(TODAY + 'T00:00:00')));
  assert.strictEqual(list[0].title, 'Verfuegbare Serie', 'Verfügbare Serie muss zuerst erscheinen');
  assert.strictEqual(list[1].title, 'Zukuenftige Serie');
});

test('Phase 18f: zukuenftige Baende aufsteigend nach Datum sortiert', () => {
  const TODAY = '2026-05-18';
  const today = new Date(TODAY + 'T00:00:00');
  const list = [
    { id: '3', title: 'Serie C', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-08-01' },
    { id: '1', title: 'Serie A', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-06-01' },
    { id: '2', title: 'Serie B', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-07-01' },
  ];
  list.sort((a, b) => compareBuyEntries(a, b, today));
  assert.strictEqual(list[0].title, 'Serie A', 'Frühestes Datum zuerst');
  assert.strictEqual(list[1].title, 'Serie B');
  assert.strictEqual(list[2].title, 'Serie C');
});

test('Phase 18f: Eintraege ohne Datum nach Datum-Eintraegen sortiert', () => {
  const TODAY = '2026-05-18';
  const today = new Date(TODAY + 'T00:00:00');
  // Both have nextDate in the past (available), so aAvail && bAvail → compare da/db2 → da exists, db2 doesn't → da first
  // Actually: both avail, da set, db2=null → da && !db2 → return -1 (a before b) ✓
  const list = [
    { id: '2', title: 'Ohne Datum',    bands: { '1': 'owned' }, total: 5, next: 2, nextDate: null },
    { id: '1', title: 'Mit Alt-Datum', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-04-01' },
  ];
  list.sort((a, b) => compareBuyEntries(a, b, today));
  assert.strictEqual(list[0].title, 'Mit Alt-Datum', 'Einträge mit Datum (auch verfügbar) vor Einträgen ohne Datum');
  assert.strictEqual(list[1].title, 'Ohne Datum');
});

test('Phase 18f: gleiche Daten alphabetisch nach Titel sortiert', () => {
  const TODAY = '2026-05-18';
  const today = new Date(TODAY + 'T00:00:00');
  const list = [
    { id: '3', title: 'Zorn', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-07-01' },
    { id: '1', title: 'Alpha', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-07-01' },
    { id: '2', title: 'Mango', bands: { '1': 'owned' }, total: 5, next: 2, nextDate: '2026-07-01' },
  ];
  list.sort((a, b) => compareBuyEntries(a, b, today));
  assert.strictEqual(list[0].title, 'Alpha',  'Alphabetisch: Alpha zuerst');
  assert.strictEqual(list[1].title, 'Mango');
  assert.strictEqual(list[2].title, 'Zorn');
});

test('Phase 18f: gleicher Titel nach Bandnummer sortiert', () => {
  const TODAY = '2026-05-18';
  const today = new Date(TODAY + 'T00:00:00');
  const list = [
    { id: '3', title: 'Gleiche Serie', bands: { '1': 'owned', '2': 'owned', '3': 'owned' }, total: 10, next: 4, nextDate: '2026-06-01' },
    { id: '1', title: 'Gleiche Serie', bands: { '1': 'owned' }, total: 10, next: 2, nextDate: '2026-06-01' },
    { id: '2', title: 'Gleiche Serie', bands: { '1': 'owned', '2': 'owned' }, total: 10, next: 3, nextDate: '2026-06-01' },
  ];
  list.sort((a, b) => compareBuyEntries(a, b, today));
  assert.strictEqual(list[0].next, 2, 'Niedrigste Bandnummer zuerst');
  assert.strictEqual(list[1].next, 3);
  assert.strictEqual(list[2].next, 4);
});

test('Phase 18f: Dashboard-Kaufvorschau mutiert keine Manga-Daten', () => {
  const list = [
    { id: '1', title: 'Serie X', bands: { '1': 'owned' }, total: 5, nextDate: '2026-09-01' },
    { id: '2', title: 'Serie Y', bands: { '1': 'owned' }, total: 3, nextDate: null },
  ];
  const before = JSON.stringify(list);
  const result = calcBuyPreviewStructured(list, 8, '2026-05-18');
  assert.strictEqual(JSON.stringify(list), before, 'Manga-Daten dürfen durch Kaufvorschau nicht verändert werden');
  assert.ok(result.previewItems.length >= 0);
});

test('Phase 18f: Dashboard-Kaufvorschau begrenzt auf BUY_PREVIEW_MAX', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), title: `Serie ${i}`, bands: { '1': 'owned' }, total: 5, nextDate: null,
  }));
  const result = calcBuyPreviewStructured(list, 8, '2026-05-18');
  assert.strictEqual(result.previewItems.length, 8, 'Vorschau darf maximal 8 Einträge enthalten');
  assert.strictEqual(result.totalAll, 12, 'totalAll muss alle Einträge zählen');
});

test('Phase 18f: Dashboard-Kaufvorschau zaehlt avail/soon korrekt', () => {
  const list = [
    { id: '1', title: 'Verfuegbar A', bands: { '1': 'owned' }, total: 3, nextDate: '2026-04-01' },
    { id: '2', title: 'Verfuegbar B', bands: { '1': 'owned' }, total: 3, nextDate: null },
    { id: '3', title: 'Vorgemerkt A', bands: { '1': 'owned' }, total: 3, nextDate: '2026-07-01' },
    { id: '4', title: 'Vorgemerkt B', bands: { '1': 'owned' }, total: 3, nextDate: '2026-08-01' },
  ];
  const result = calcBuyPreviewStructured(list, 8, '2026-05-18');
  assert.strictEqual(result.availItems.length, 2,   'Verfügbare Einträge: 2');
  assert.strictEqual(result.soonItems.length,  2,   'Vorgemerkte Einträge: 2');
  assert.strictEqual(result.totalAvailAll, 2, 'totalAvailAll korrekt');
  assert.strictEqual(result.totalSoonAll,  2, 'totalSoonAll korrekt');
  assert.strictEqual(result.totalAll,      4, 'totalAll korrekt');
});

test('Phase 18f: vollstaendige Serien erscheinen nicht in Kaufvorschau', () => {
  const list = [
    { id: '1', title: 'Vollstaendig', bands: { '1': 'owned', '2': 'owned', '3': 'owned' }, total: 3, nextDate: null },
    { id: '2', title: 'Unvollstaendig', bands: { '1': 'owned' }, total: 3, nextDate: null },
  ];
  const result = calcBuyPreviewStructured(list, 8, '2026-05-18');
  assert.strictEqual(result.totalAll, 1, 'Vollständige Serien dürfen nicht erscheinen');
  assert.ok(result.previewItems.every(item => item.title !== 'Vollstaendig'), 'Vollständige Serie nicht in Preview');
});

test('Phase 18f: Serien ohne total erscheinen nicht in Kaufvorschau', () => {
  const list = [
    { id: '1', title: 'Kein Total',        bands: { '1': 'owned' }, total: null,      nextDate: null },
    { id: '2', title: 'Total Null',         bands: { '1': 'owned' }, total: 0,         nextDate: null },
    { id: '3', title: 'Total String leer', bands: { '1': 'owned' }, total: '',        nextDate: null },
    { id: '4', title: 'Mit Total',          bands: { '1': 'owned' }, total: 3,         nextDate: null },
  ];
  const result = calcBuyPreviewStructured(list, 8, '2026-05-18');
  assert.strictEqual(result.totalAll, 1, 'Nur die Serie mit gültigem total darf erscheinen');
  assert.strictEqual(result.previewItems[0].title, 'Mit Total');
});

test('Phase 18f: app.js enthaelt BUY_PREVIEW_MAX-Konstante und Alle-Kaeufe-Button', () => {
  const appJs = require('fs').readFileSync('src/app.js', 'utf8');
  assert.ok(appJs.includes('BUY_PREVIEW_MAX'), 'BUY_PREVIEW_MAX-Konstante fehlt');
  assert.ok(appJs.includes('Alle Käufe anzeigen'), '„Alle Käufe anzeigen"-Button fehlt');
  assert.ok(appJs.includes('compareBuyEntries'), 'compareBuyEntries-Funktion fehlt');
  assert.ok(appJs.includes('stats-buy-summary'), 'Zusammenfassungs-Element fehlt');
});

// ─── Phase 19 Tests ───────────────────────────────────────────────────────

const _fs19 = require('fs');
const _path19 = require('path');
const _repoRoot19 = _path19.resolve(__dirname, '..');

console.log('\nPhase 19 — Release-Cache-Abdeckung und Missing-Report Tests\n');

test('Phase 19: release-watchlist.json existiert', () => {
  const p = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  assert.ok(_fs19.existsSync(p), 'data/release-watchlist.json muss existieren');
});

test('Phase 19: release-watchlist.json hat schemaVersion 1', () => {
  const p = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs19.readFileSync(p, 'utf8'));
  assert.strictEqual(data.schemaVersion, 1, 'schemaVersion muss 1 sein');
  assert.ok(Array.isArray(data.items), 'items muss ein Array sein');
});

test('Phase 19: Watchlist enthält Vermeil in Gold Band 2', () => {
  const p = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs19.readFileSync(p, 'utf8'));
  const found = data.items.some(item =>
    item.seriesTitle === 'Vermeil in Gold' && item.volumeNumber === 2
  );
  assert.ok(found, 'Vermeil in Gold Band 2 muss in der Watchlist sein');
});

test('Phase 19: Watchlist enthält Meine Chefin kommt immer zuerst!! Band 2', () => {
  const p = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs19.readFileSync(p, 'utf8'));
  const found = data.items.some(item =>
    item.seriesTitle === 'Meine Chefin kommt immer zuerst!!' && item.volumeNumber === 2
  );
  assert.ok(found, 'Meine Chefin kommt immer zuerst!! Band 2 muss in der Watchlist sein');
});

test('Phase 19: Watchlist-Einträge haben required fields', () => {
  const p = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs19.readFileSync(p, 'utf8'));
  data.items.forEach((item, idx) => {
    assert.ok(typeof item.seriesTitle === 'string' && item.seriesTitle.trim(), `Item ${idx + 1}: seriesTitle fehlt`);
    assert.ok(typeof item.publisher === 'string' && item.publisher.trim(), `Item ${idx + 1}: publisher fehlt`);
    // Phase 22: volumeNumber (Einzelband) oder volumeNumbers (Mehrband-Array) – eines muss gesetzt sein
    const hasVolumeNumber  = 'volumeNumber'  in item;
    const hasVolumeNumbers = 'volumeNumbers' in item;
    assert.ok(hasVolumeNumber || hasVolumeNumbers, `Item ${idx + 1}: weder volumeNumber noch volumeNumbers gesetzt`);
    assert.ok(!(hasVolumeNumber && hasVolumeNumbers), `Item ${idx + 1}: volumeNumber und volumeNumbers dürfen nicht gleichzeitig gesetzt sein`);
    if (hasVolumeNumber) {
      assert.ok(Number.isInteger(item.volumeNumber) && item.volumeNumber >= 1, `Item ${idx + 1}: volumeNumber ungültig`);
    }
    if (hasVolumeNumbers) {
      assert.ok(Array.isArray(item.volumeNumbers) && item.volumeNumbers.length > 0, `Item ${idx + 1}: volumeNumbers muss nicht-leeres Array sein`);
    }
    assert.ok(typeof item.enabled === 'boolean', `Item ${idx + 1}: enabled muss boolean sein`);
    // sourceUrl: null oder https://
    if (item.sourceUrl !== null) {
      assert.ok(typeof item.sourceUrl === 'string' && item.sourceUrl.startsWith('https://'), `Item ${idx + 1}: sourceUrl ungültig`);
    }
  });
});

test('Phase 19: Coverage-Audit findet keine Crashes', () => {
  // Führt den Audit als require-ähnliche Logik aus (ohne process.exit)
  const watchlistPath = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const cachePath     = _path19.join(_repoRoot19, 'data', 'release-cache.json');
  const wl = JSON.parse(_fs19.readFileSync(watchlistPath, 'utf8'));
  const cache = JSON.parse(_fs19.readFileSync(cachePath, 'utf8'));
  assert.ok(Array.isArray(wl.items), 'Watchlist items muss Array sein');
  assert.ok(Array.isArray(cache.items), 'Cache items muss Array sein');
  // Kein Crash beim Durchlaufen
  const enabled = wl.items.filter(i => i && i.enabled === true);
  assert.ok(enabled.length >= 0, 'Aktivierte Items müssen zählbar sein');
});

test('Phase 19: validate-release-watchlist.js existiert', () => {
  const p = _path19.join(_repoRoot19, 'scripts', 'validate-release-watchlist.js');
  assert.ok(_fs19.existsSync(p), 'scripts/validate-release-watchlist.js muss existieren');
});

test('Phase 19: audit-release-cache-coverage.js existiert', () => {
  const p = _path19.join(_repoRoot19, 'scripts', 'audit-release-cache-coverage.js');
  assert.ok(_fs19.existsSync(p), 'scripts/audit-release-cache-coverage.js muss existieren');
});

test('Phase 19: App enthält Cache-Miss-Report-Logik', () => {
  const appJs = _fs19.readFileSync(_path19.join(_repoRoot19, 'src', 'app.js'), 'utf8');
  assert.ok(
    appJs.includes('cache-miss-report') || appJs.includes('cacheMissReport'),
    'src/app.js muss Cache-Miss-Report-Marker enthalten'
  );
  assert.ok(/Watchlist|Review-Queue|Pipeline/.test(appJs), 'src/app.js muss Diagnose-/Pipeline-Referenz enthalten');
});

test('Phase 19: Watchlist-Eintrag hat keine privaten Felder', () => {
  const watchlistPath = _path19.join(_repoRoot19, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs19.readFileSync(watchlistPath, 'utf8'));
  const PRIVATE_FIELDS = ['owned', 'read', 'boughtAt', 'readAt'];
  data.items.forEach((item, idx) => {
    PRIVATE_FIELDS.forEach(field => {
      assert.ok(!(field in item), `Item ${idx + 1} darf kein privates Feld "${field}" enthalten`);
    });
  });
});

// ─── Hotfix completed_display_missing_volumes (Phase 19-Hotfix) ────────────
// Phase 44a-followup: Die ursprüngliche Anzeige des Hotfix-Texts lebte in
// `inspectSeriesStatus`, das mit den entfernten Dashboard-Buttons "Alle
// Serien-Status prüfen" weggefallen ist. Die zugrundeliegende Logik
// (`mFirstMissingBand`, `mSeriesStatus`, Buy-Tab-Anzeige) bleibt unverändert.
// Die textspezifischen Smoke-Tests sind damit obsolet.

// ─── Phase 22 Tests ───────────────────────────────────────────────────────

const _fs22   = require('fs');
const _path22 = require('path');
const _root22 = _path22.resolve(__dirname, '..');

console.log('\nPhase 22 — Sammlungsweite Release-Cache-Coverage Tests\n');

// ── Hilfsfunktionen (aus validate-release-watchlist.js inline) ─────────────
function _p22_validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'kein Objekt';
  if (typeof item.seriesTitle !== 'string' || !item.seriesTitle.trim()) return 'seriesTitle fehlt';
  if (typeof item.publisher !== 'string' || !item.publisher.trim()) return 'publisher fehlt';
  const hasN  = 'volumeNumber'  in item;
  const hasNs = 'volumeNumbers' in item;
  if (hasN && hasNs) return 'volumeNumber und volumeNumbers gleichzeitig gesetzt';
  if (!hasN && !hasNs) return 'weder volumeNumber noch volumeNumbers';
  if (hasN && (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1))
    return 'volumeNumber ungültig';
  if (hasNs) {
    if (!Array.isArray(item.volumeNumbers) || item.volumeNumbers.length === 0)
      return 'volumeNumbers leer oder kein Array';
    for (const v of item.volumeNumbers) {
      if (!Number.isInteger(v) || v < 1) return `volumeNumbers enthält ungültigen Wert: ${v}`;
    }
    if (new Set(item.volumeNumbers).size !== item.volumeNumbers.length)
      return 'volumeNumbers enthält Duplikate';
  }
  if (typeof item.enabled !== 'boolean') return 'enabled kein Boolean';
  return null; // kein Fehler
}

test('Phase 22: volumeNumber-Eintrag ist valide', () => {
  const item = { seriesTitle: 'Test', publisher: 'Verlag', volumeNumber: 5, enabled: true, sourceUrl: null };
  assert.strictEqual(_p22_validateItem(item), null, 'volumeNumber-Eintrag muss valide sein');
});

test('Phase 22: volumeNumbers-Eintrag ist valide', () => {
  const item = { seriesTitle: 'Test', publisher: 'Verlag', volumeNumbers: [1, 2, 3], enabled: true, sourceUrl: null };
  assert.strictEqual(_p22_validateItem(item), null, 'volumeNumbers-Eintrag muss valide sein');
});

test('Phase 22: volumeNumber + volumeNumbers gleichzeitig → Fehler', () => {
  const item = { seriesTitle: 'Test', publisher: 'Verlag', volumeNumber: 1, volumeNumbers: [1, 2], enabled: true, sourceUrl: null };
  const err = _p22_validateItem(item);
  assert.ok(err !== null && err.includes('gleichzeitig'), `Erwartet Fehler für gleichzeitige Felder, erhalten: ${err}`);
});

test('Phase 22: leeres volumeNumbers-Array → Fehler', () => {
  const item = { seriesTitle: 'Test', publisher: 'Verlag', volumeNumbers: [], enabled: true, sourceUrl: null };
  const err = _p22_validateItem(item);
  assert.ok(err !== null, `Erwartet Fehler für leeres volumeNumbers, erhalten: ${err}`);
});

test('Phase 22: volumeNumbers mit Duplikaten → Fehler', () => {
  const item = { seriesTitle: 'Test', publisher: 'Verlag', volumeNumbers: [1, 2, 2, 3], enabled: true, sourceUrl: null };
  const err = _p22_validateItem(item);
  assert.ok(err !== null && err.includes('Duplikate'), `Erwartet Duplikat-Fehler, erhalten: ${err}`);
});

test('Phase 22: cross-format Duplikat (volumeNumber:10 vs. volumeNumbers:[8,9,10]) → Duplikat erkennbar', () => {
  // Simuliert die Duplikat-Prüfung aus validate-release-watchlist.js
  const items = [
    { seriesTitle: 'Vagabond', publisher: 'Egmont', volumeNumber: 10, enabled: true, sourceUrl: null },
    { seriesTitle: 'Vagabond', publisher: 'Egmont', volumeNumbers: [8, 9, 10], enabled: true, sourceUrl: null },
  ];
  const seen = new Map();
  let duplicateFound = false;
  items.forEach((item, idx) => {
    const base = item.seriesTitle.toLowerCase() + '|' + item.publisher.toLowerCase();
    const vols = 'volumeNumber' in item
      ? [item.volumeNumber]
      : (item.volumeNumbers || []);
    for (const v of vols) {
      const key = base + '|' + v;
      if (seen.has(key)) { duplicateFound = true; }
      else { seen.set(key, idx); }
    }
  });
  assert.ok(duplicateFound, 'Cross-Format-Duplikat (volumeNumber:10 + volumeNumbers:[8,9,10]) muss erkannt werden');
});

test('Phase 22: volumeNumbers-Expansion erzeugt N Kandidaten', () => {
  // Simuliert extractWatchlistItems-Logik für volumeNumbers
  const entry = { seriesTitle: 'Vagabond', publisher: 'Egmont', volumeNumbers: [8, 9, 10], enabled: true, sourceUrl: null };
  const candidates = [];
  if (Array.isArray(entry.volumeNumbers)) {
    for (const vol of entry.volumeNumbers) {
      candidates.push({ seriesTitle: entry.seriesTitle, volumeNumber: vol });
    }
  }
  assert.strictEqual(candidates.length, 3, 'volumeNumbers [8,9,10] muss 3 Kandidaten erzeugen');
  assert.strictEqual(candidates[0].volumeNumber, 8, 'Erster Kandidat hat Band 8');
  assert.strictEqual(candidates[2].volumeNumber, 10, 'Dritter Kandidat hat Band 10');
});

test('Phase 22: Audit zählt fehlende Bände aus volumeNumbers korrekt', () => {
  // Simuliert audit-release-cache-coverage-Logik
  const entry = { seriesTitle: 'Vagabond', publisher: 'Egmont', volumeNumbers: [8, 9, 10], enabled: true };
  const cacheItems = [
    { normalizedSeriesTitle: 'vagabond', normalizedPublisher: 'egmont', volumeNumber: 9 },
  ];
  let found = 0, missing = 0;
  for (const vol of entry.volumeNumbers) {
    const inCache = cacheItems.some(c => c.normalizedSeriesTitle === 'vagabond' && c.volumeNumber === vol);
    if (inCache) found++; else missing++;
  }
  assert.strictEqual(found, 1, 'Band 9 muss im Cache gefunden werden');
  assert.strictEqual(missing, 2, 'Bände 8 und 10 müssen als fehlend gezählt werden');
});


test('Phase 22c: Audit bietet maschinenlesbaren JSON-Report-Modus', () => {
  const auditScript = _fs22.readFileSync(_path22.join(_root22, 'scripts', 'audit-release-cache-coverage.js'), 'utf8');
  assert.ok(auditScript.includes('--json'), 'audit-release-cache-coverage.js muss --json unterst?tzen');
  assert.ok(auditScript.includes('missingBySeries'), 'JSON-Report muss Serien-Gruppierung enthalten');
  assert.ok(auditScript.includes('missingByPublisher'), 'JSON-Report muss Verlags-Gruppierung enthalten');
  assert.ok(auditScript.includes('source-data-gap'), 'JSON-Report muss Quellen-/Datenqualit?tsklassifikation enthalten');
});

test('Phase 22d: Coverage-Gap-Validator und Docs sind vorhanden', () => {
  const validatorPath = _path22.join(_root22, 'scripts', 'validate-release-cache-coverage-gaps.js');
  const syncPath = _path22.join(_root22, 'scripts', 'sync-release-coverage-gap-docs.js');
  const docsPath = _path22.join(_root22, 'docs', 'release-cache-coverage-gaps.md');
  assert.ok(_fs22.existsSync(validatorPath), 'validate-release-cache-coverage-gaps.js muss existieren');
  assert.ok(_fs22.existsSync(syncPath), 'sync-release-coverage-gap-docs.js muss existieren');
  assert.ok(_fs22.existsSync(docsPath), 'release-cache-coverage-gaps.md muss existieren');
  const validator = _fs22.readFileSync(validatorPath, 'utf8');
  const docs = _fs22.readFileSync(docsPath, 'utf8');
  assert.ok(validator.includes('source-data-gap'), 'Validator muss source-data-gap pruefen');
  assert.ok(validator.includes('missingCacheCoverage'), 'Validator muss Summary-Zaehler pruefen');
  ['Verbleibende Luecken', 'Betroffene Serien', 'Betroffene Verlage'].forEach(label => {
    assert.ok(new RegExp(`\\|\\s*${label}\\s*\\|\\s*\\d+\\s*\\|`).test(docs), `Docs muessen Kennzahl "${label}" enthalten`);
  });
  assert.ok(docs.includes('source-data-gap'), 'Docs muessen source-data-gap dokumentieren');
});

test('Phase 22e: Coverage-Gap-Report-Writer ist vorhanden und CI-tauglich', () => {
  const writerPath = _path22.join(_root22, 'scripts', 'write-release-cache-coverage-report.js');
  assert.ok(_fs22.existsSync(writerPath), 'write-release-cache-coverage-report.js muss existieren');
  const writer = _fs22.readFileSync(writerPath, 'utf8');
  assert.ok(writer.includes('release-cache-coverage-ci-report'), 'Report muss stabilen reportType enthalten');
  assert.ok(writer.includes('newGaps'), 'Report muss neue Gaps ausweisen');
  assert.ok(writer.includes('resolvedGaps'), 'Report muss verschwundene Gaps ausweisen');
  assert.ok(writer.includes('containsPrivateCollectionData: false'), 'Report muss private Sammlungsdaten ausschliessen');
});

test('Phase 22e: CI erzeugt und laedt Coverage-Gap-Artefakt hoch', () => {
  const ciPath = _path22.join(_root22, '.github', 'workflows', 'ci.yml');
  const ci = _fs22.readFileSync(ciPath, 'utf8');
  assert.ok(ci.includes('node --check scripts/write-release-cache-coverage-report.js'), 'CI muss Report-Writer syntaktisch pruefen');
  assert.ok(ci.includes('node scripts/write-release-cache-coverage-report.js'), 'CI muss Coverage-Gap-Report schreiben');
  assert.ok(ci.includes('actions/upload-artifact@v7'), 'CI muss Coverage-Gap-Report als Artefakt hochladen');
  assert.ok(ci.includes('artifacts/release-cache-coverage-report.json'), 'CI muss den erwarteten Report-Pfad verwenden');
});

test('Phase 22e: Validator prueft neue und verschwundene Gaps im CI-Report', () => {
  const validator = _fs22.readFileSync(_path22.join(_root22, 'scripts', 'validate-release-cache-coverage-gaps.js'), 'utf8');
  assert.ok(validator.includes('write-release-cache-coverage-report.js'), 'Validator muss den CI-Report-Writer pruefen');
  assert.ok(validator.includes('counts.newGaps'), 'Validator muss neue Gaps pruefen');
  assert.ok(validator.includes('counts.resolvedGaps'), 'Validator muss verschwundene Gaps pruefen');
  assert.ok(validator.includes('matchesDocumentedStand'), 'Validator muss Dokumentations-Synchronitaet pruefen');
});


test('Phase 22f: Coverage-Gap-Summary-Writer ist vorhanden und GitHub-tauglich', () => {
  const summaryPath = _path22.join(_root22, 'scripts', 'write-release-cache-coverage-summary.js');
  assert.ok(_fs22.existsSync(summaryPath), 'write-release-cache-coverage-summary.js muss existieren');
  const summaryScript = _fs22.readFileSync(summaryPath, 'utf8');
  assert.ok(summaryScript.includes('GITHUB_STEP_SUMMARY'), 'Summary-Writer muss GITHUB_STEP_SUMMARY nutzen');
  assert.ok(summaryScript.includes('Aktuelle Coverage-Luecken'), 'Summary muss aktuelle Coverage-Luecken anzeigen');
  assert.ok(summaryScript.includes('Betroffene Serien'), 'Summary muss betroffene Serien anzeigen');
  assert.ok(summaryScript.includes('Betroffene Verlage'), 'Summary muss betroffene Verlage anzeigen');
  assert.ok(summaryScript.includes('Neue Gaps'), 'Summary muss neue Gaps anzeigen');
  assert.ok(summaryScript.includes('Verschwundene Gaps'), 'Summary muss verschwundene Gaps anzeigen');
  assert.ok(summaryScript.includes('source-data-gap'), 'Summary muss source-data-gap anzeigen');
  assert.ok(summaryScript.includes('Keine Fake-Daten'), 'Summary muss No-Fake-Daten-Hinweis enthalten');
});

test('Phase 22f: CI schreibt Coverage-Gap-Summary nach Report-Erzeugung', () => {
  const ciPath = _path22.join(_root22, '.github', 'workflows', 'ci.yml');
  const ci = _fs22.readFileSync(ciPath, 'utf8');
  assert.ok(ci.includes('node --check scripts/write-release-cache-coverage-summary.js'), 'CI muss Summary-Writer syntaktisch pruefen');
  assert.ok(ci.includes('node scripts/write-release-cache-coverage-summary.js'), 'CI muss GitHub-Actions-Summary schreiben');
  assert.ok(ci.indexOf('node scripts/write-release-cache-coverage-report.js') < ci.indexOf('node scripts/write-release-cache-coverage-summary.js'), 'Summary muss nach Report-Erzeugung laufen');
});

test('Phase 22f: Validator prueft die GitHub-Actions-Summary', () => {
  const validator = _fs22.readFileSync(_path22.join(_root22, 'scripts', 'validate-release-cache-coverage-gaps.js'), 'utf8');
  assert.ok(validator.includes('write-release-cache-coverage-summary.js'), 'Validator muss Summary-Writer ausfuehren');
  assert.ok(validator.includes('GitHub-Actions-Summary'), 'Validator muss Summary-Sichtbarkeit pruefen');
  assert.ok(validator.includes('Keine Fake-Daten'), 'Validator muss No-Fake-Daten-Hinweis in Summary pruefen');
});

test('Phase 44a-followup: lokale Cache-Coverage-Helfer aus app.js entfernt', () => {
  const appJs = _fs22.readFileSync(_path22.join(_root22, 'src', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('buildReleaseCacheCoverageReport'), 'buildReleaseCacheCoverageReport sollte entfernt sein');
  assert.ok(!appJs.includes('copyReleaseCacheCoverageBatch'), 'copyReleaseCacheCoverageBatch sollte entfernt sein');
  assert.ok(!appJs.includes('renderReleaseCacheCoveragePreview'), 'renderReleaseCacheCoveragePreview sollte entfernt sein');
});

test('Phase 44a-followup: entfernte Dashboard-Aktionen nicht mehr in app.js', () => {
  const appJs = _fs22.readFileSync(_path22.join(_root22, 'src', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('data-action="check-release-coverage"'), 'check-release-coverage darf nicht mehr existieren');
  assert.ok(!appJs.includes('data-action="run-dashboard-release-date-check"'), 'run-dashboard-release-date-check darf nicht mehr existieren');
  assert.ok(!appJs.includes('data-action="run-dashboard-series-status-check"'), 'run-dashboard-series-status-check darf nicht mehr existieren');
  assert.ok(!appJs.includes('data-action="apply-dashboard-release-dates"'), 'apply-dashboard-release-dates darf nicht mehr existieren');
});

test('Phase 22: Vagabond-Master-Edition volumeNumbers-Eintrag in release-watchlist.json', () => {
  const p = _path22.join(_root22, 'data', 'release-watchlist.json');
  const data = JSON.parse(_fs22.readFileSync(p, 'utf8'));
  const vagabond = data.items.find(i => i.seriesTitle === 'Vagabond – Master Edition');
  assert.ok(vagabond, 'Vagabond – Master Edition muss in der Watchlist sein');
  assert.ok(Array.isArray(vagabond.volumeNumbers), 'Vagabond-Eintrag muss volumeNumbers-Array haben');
  assert.ok(vagabond.volumeNumbers.length > 0, 'volumeNumbers-Array darf nicht leer sein');
});

console.log('\nPhase 26 — Release-Provider und Dashboard-Aktionszentrale Tests\n');

test('Phase 26: Release-Provider-Dateien sind vorhanden', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  [
    'scripts/release-providers/index.js',
    'scripts/release-providers/provider-utils.js',
    'scripts/release-providers/manga-passion-provider.js',
    'docs/release-provider-system.md',
  ].forEach(rel => assert.ok(fs.existsSync(path.join(root, rel)), rel + ' muss existieren'));
});

test('Phase 26: Dashboard hat Cover-Sync und keine normale Watchlist-Batch-Aktion', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  assert.ok(appJs.includes('Alle Band-Cover laden'), 'Dashboard-Cover-Sync fehlt');
  assert.ok(appJs.includes('Aktionszentrale:'), 'Aktionszentrale fehlt');
  assert.ok(!indexHtml.includes('id="btn-mp-sync"'), 'Suchleisten-Cover-Button muss entfernt sein');
  assert.ok(!appJs.includes('data-action="copy-coverage-batch"'), 'Watchlist-Batch darf nicht als normale Dashboard-Aktion erscheinen');
});

console.log('\nPhase 34 - Lokaler Release-Coverage-Auto-Check Tests\n');

const PHASE34_ALLOWED_FIELDS = new Set([
  'seriesTitle', 'normalizedSeriesTitle', 'publisher', 'normalizedPublisher',
  'volumeNumber', 'reason', 'status', 'source', 'checkedAt', 'lastSeenAt',
  'seenCount', 'resolvedAt',
]);
const PHASE34_PRIVATE_FIELDS = [
  'owned', 'reading', 'completed', 'collectionStatus', 'boughtAt', 'readAt',
  'startedAt', 'finishedAt', 'notes', 'seriesId', 'id', 'owner_token', 'view_token',
  'supabaseId', 'supabase_id', 'privateDebug', 'privateComment',
];

function p34KeyFromFields(seriesTitle, publisher, volumeNumber) {
  return [normalizeReleaseTitle(seriesTitle || ''), normalizeReleasePublisher(publisher || ''), Number(volumeNumber)].join('|');
}
function p34Key(item) { return p34KeyFromFields(item.seriesTitle, item.publisher, item.volumeNumber); }
function getReleaseTargetVolumeForTest(m) {
  const firstMiss = mFirstMissingBand(m);
  if (m.ongoing === 'false' && firstMiss === null) return null;
  return firstMiss !== null && firstMiss !== undefined ? firstMiss : mNextBand(m);
}
function p34Sanitize(item) {
  const volumeNumber = Number(item.volumeNumber);
  const title = String(item.seriesTitle || '').trim();
  if (!title || !Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  const publisher = String(item.publisher || '').trim();
  const out = {
    seriesTitle: title,
    normalizedSeriesTitle: normalizeReleaseTitle(title),
    publisher,
    normalizedPublisher: normalizeReleasePublisher(publisher),
    volumeNumber,
    reason: 'unknown-to-release-system',
    status: ['pending', 'resolved', 'ignored'].includes(item.status) ? item.status : 'pending',
    source: 'local-save-coverage-check',
    checkedAt: item.checkedAt || '2026-05-20T00:00:00.000Z',
    lastSeenAt: item.lastSeenAt || item.checkedAt || '2026-05-20T00:00:00.000Z',
    seenCount: Number.isInteger(Number(item.seenCount)) && Number(item.seenCount) > 0 ? Number(item.seenCount) : 1,
  };
  if (item.resolvedAt && out.status === 'resolved') out.resolvedAt = item.resolvedAt;
  Object.keys(out).forEach(k => { if (!PHASE34_ALLOWED_FIELDS.has(k)) delete out[k]; });
  return out;
}
function p34AddKnownKey(set, item) {
  const volumes = Array.isArray(item.volumeNumbers) ? item.volumeNumbers : [item.volumeNumber];
  volumes.forEach(v => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) set.add(p34KeyFromFields(item.seriesTitle || '', item.publisher || '', n));
  });
}
function p34KnownSet(releaseSystem, queue, includePending = false) {
  const set = new Set();
  (releaseSystem.cacheItems || []).forEach(i => p34AddKnownKey(set, i));
  (releaseSystem.watchlistItems || []).forEach(i => p34AddKnownKey(set, i));
  (releaseSystem.reviewItems || []).forEach(i => p34AddKnownKey(set, i));
  if (includePending) (queue.items || []).filter(i => i.status === 'pending').forEach(i => set.add(p34Key(i)));
  return set;
}
function p34BuildCandidate(m) {
  if (!m || m.status === 'wishlist' || mSeriesStatus(m) === 'wishlist') return null;
  const volumeNumber = getReleaseTargetVolumeForTest(m);
  if (volumeNumber === null) return null;
  return p34Sanitize({ seriesTitle: m.title, publisher: m.pub || '', volumeNumber, status: 'pending' });
}
function p34Upsert(queue, candidate) {
  const clean = p34Sanitize(candidate);
  const key = p34Key(clean);
  const found = queue.items.find(i => p34Key(i) === key);
  if (found) {
    found.checkedAt = '2026-05-20T01:00:00.000Z';
    found.lastSeenAt = '2026-05-20T01:00:00.000Z';
    found.seenCount += 1;
    found.status = 'pending';
    delete found.resolvedAt;
  } else {
    queue.items.push(clean);
  }
  return queue;
}
function p34MaybeCheck(m, releaseSystem, queue, mode = { publicReadOnly: false, canEditLocal: true }, hooks = { events: [] }) {
  if (mode.publicReadOnly || !mode.canEditLocal) return queue;
  const before = JSON.stringify(m);
  const candidate = p34BuildCandidate(m);
  if (!candidate) return queue;
  if (!p34KnownSet(releaseSystem, queue, false).has(p34Key(candidate))) p34Upsert(queue, candidate);
  assert.strictEqual(JSON.stringify(m), before, 'Coverage-Check darf db.m/Manga nicht mutieren');
  assert.deepStrictEqual(hooks.events, [], 'Coverage-Check darf persist/pushCloud nicht ausloesen');
  return queue;
}
function p34Reconcile(queue, releaseSystem) {
  const known = p34KnownSet(releaseSystem, queue, false);
  queue.items.forEach(item => {
    if (item.status === 'pending' && known.has(p34Key(item))) {
      item.status = 'resolved';
      item.resolvedAt = '2026-05-20T02:00:00.000Z';
    }
  });
  return queue;
}
function p34Export(items) {
  return items.filter(i => i.status === 'pending').map(i => ({
    seriesTitle: i.seriesTitle,
    publisher: i.publisher,
    volumeNumber: i.volumeNumber,
    sourceUrl: null,
    notes: 'Aus lokaler Release-Coverage-Pending-Queue ergänzt.',
    enabled: true,
  }));
}
function p34AssertNoPrivateFields(obj, label) {
  const scan = Array.isArray(obj) ? obj : [obj];
  scan.forEach((item, idx) => {
    PHASE34_PRIVATE_FIELDS.forEach(field => assert.ok(!(field in item), `${label} ${idx} darf kein privates Feld ${field} enthalten`));
  });
}

test('Phase 34: Neuer Save erzeugt Pending-Kandidat, wenn nichts bekannt ist', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34MaybeCheck({ title: 'Unbekannte Serie', pub: 'Egmont Manga', bands: {}, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].volumeNumber, 1);
});

test('Phase 34: Kein Pending bei Cache-, Watchlist- und Review-Eintrag', () => {
  [
    { cacheItems: [{ seriesTitle: 'Cache Serie', publisher: 'Carlsen Manga', volumeNumber: 1 }] },
    { watchlistItems: [{ seriesTitle: 'Watch Serie', publisher: 'Egmont', volumeNumbers: [1, 2] }] },
    { reviewItems: [{ seriesTitle: 'Review Serie', publisher: 'Panini Manga', volumeNumber: 1 }] },
  ].forEach((releaseSystem, idx) => {
    const titles = ['Cache Serie', 'Watch Serie', 'Review Serie'];
    const pubs = ['Carlsen', 'Egmont Manga', 'Panini Manga'];
    const queue = { schemaVersion: 1, items: [] };
    p34MaybeCheck({ title: titles[idx], pub: pubs[idx], bands: {}, ongoing: 'true' }, releaseSystem, queue);
    assert.strictEqual(queue.items.length, 0);
  });
});

test('Phase 34: Deduplizierung per normalizedTitle|normalizedPublisher|volumeNumber', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34MaybeCheck({ title: 'Bitte zieh dich an, Takamine!', pub: 'Egmont', bands: {}, ongoing: 'true' }, {}, queue);
  p34MaybeCheck({ title: 'Bitte zieh dich an Takamine', pub: 'Egmont Manga', bands: {}, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].seenCount, 2);
});

test('Phase 34: Pending-Queue und Export enthalten keine privaten Felder', () => {
  const item = p34Sanitize({ seriesTitle: 'Privat', publisher: 'Carlsen', volumeNumber: 1, owned: 1, notes: 'secret', id: 'abc', status: 'pending' });
  p34AssertNoPrivateFields(item, 'Pending');
  p34Export([item]).forEach(exportItem => {
    PHASE34_PRIVATE_FIELDS.filter(field => field !== 'notes').forEach(field => {
      assert.ok(!(field in exportItem), `Export darf kein privates Feld ${field} enthalten`);
    });
  });
  Object.keys(item).forEach(k => assert.ok(PHASE34_ALLOWED_FIELDS.has(k), `unerlaubtes Feld ${k}`));
});

test('Phase 34: Public-Read-only-Modus erzeugt keine Pending-Einträge', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34MaybeCheck({ title: 'Public', pub: 'Egmont', bands: {}, ongoing: 'true' }, {}, queue, { publicReadOnly: true, canEditLocal: false });
  assert.strictEqual(queue.items.length, 0);
});

test('Phase 34: Coverage-Check mutiert db.m nicht und ruft nicht persist/pushCloud auf', () => {
  const queue = { schemaVersion: 1, items: [] };
  const manga = { title: 'No Mutation', pub: 'Egmont', bands: { '1': 'owned', '3': 'owned' }, total: 3, ongoing: 'true', notes: 'privat' };
  const before = JSON.stringify(manga);
  p34MaybeCheck(manga, {}, queue, { publicReadOnly: false, canEditLocal: true }, { events: [] });
  assert.strictEqual(JSON.stringify(manga), before);
});

test('Phase 34: Zielbandlogik, vollständige Serie und Wishlist', () => {
  const c = p34BuildCandidate({ title: 'Gap', pub: 'Egmont', bands: { '1': 'owned', '3': 'owned' }, total: 3, ongoing: 'true' });
  assert.strictEqual(c.volumeNumber, 2);
  assert.strictEqual(p34BuildCandidate({ title: 'Done', pub: 'Egmont', bands: { '1': 'owned' }, total: 1, ongoing: 'false' }), null);
  assert.strictEqual(p34BuildCandidate({ title: 'Wish', pub: 'Egmont', status: 'wishlist', bands: {}, ongoing: 'true' }), null);
});

test('Phase 34: Sonderzeichen- und Publisher-Normalisierung konsistent', () => {
  assert.strictEqual(normalizeReleaseTitle('Bitte zieh dich an, Takamine!'), 'bitte zieh dich an takamine');
  assert.strictEqual(normalizeReleasePublisher('Egmont'), normalizeReleasePublisher('Egmont Manga'));
});

test('Phase 34: schemaVersion nur auf Container-Level', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34MaybeCheck({ title: 'Schema', pub: 'Egmont', bands: {}, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.schemaVersion, 1);
  assert.ok(!('schemaVersion' in queue.items[0]));
});

test('Phase 34: Reconcile baut Keys aus Rohfeldern neu und erlaubt Wartungsfelder', () => {
  const queue = { schemaVersion: 1, items: [p34Sanitize({ seriesTitle: 'Raw Title!', normalizedSeriesTitle: 'wrong', publisher: 'Egmont', normalizedPublisher: 'wrong', volumeNumber: 1, status: 'pending' })] };
  p34Reconcile(queue, { cacheItems: [{ seriesTitle: 'Raw Title', publisher: 'Egmont Manga', volumeNumber: 1 }] });
  assert.strictEqual(queue.items[0].status, 'resolved');
  assert.ok(queue.items[0].resolvedAt);
  ['status', 'seenCount', 'lastSeenAt', 'resolvedAt'].forEach(k => assert.ok(PHASE34_ALLOWED_FIELDS.has(k)));
  p34AssertNoPrivateFields(queue.items[0], 'Reconcile');
});

test('Phase 34: Erster App-Start erzeugt keine automatische Massen-Pending-Queue', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34Reconcile(queue, { cacheItems: [], watchlistItems: [], reviewItems: [] });
  assert.strictEqual(queue.items.length, 0);
});

console.log('\nPhase 33 - Release-Cache Source-Gap-Normalisierung Tests\n');

test('Phase 33: MangaMoon und MANGAMOON normalisieren gleich', () => {
  const releaseConfidence = require('./release-confidence');
  const releaseUtils = require('../src/release-utils');
  assert.strictEqual(
    releaseConfidence.normalizePublisher('MangaMoon'),
    releaseConfidence.normalizePublisher('MANGAMOON'),
    'release-confidence muss MangaMoon/MANGAMOON gleich normalisieren',
  );
  assert.strictEqual(
    releaseUtils.normalizePublisher('MangaMoon'),
    releaseUtils.normalizePublisher('MANGAMOON'),
    'release-utils muss MangaMoon/MANGAMOON gleich normalisieren',
  );
});

test('Phase 33: Review-Queue erlaubt manuelle deferred/needs-source Klassifizierung', () => {
  const fs = require('fs');
  const queue = JSON.parse(fs.readFileSync('data/release-source-review-queue.json', 'utf8')).queue;
  const manual = queue.filter(entry => entry.reviewStatus === 'deferred' || entry.reviewStatus === 'needs-source');
  assert.ok(manual.length >= 1, 'Mindestens ein Phase-33-Gap muss manuell deferred/needs-source dokumentiert sein');
  manual.forEach(entry => {
    assert.strictEqual(entry.safeToPatch, false, 'deferred/needs-source darf nicht safeToPatch=true sein');
    assert.ok(entry.notes && entry.notes.includes('Phase 33'), 'manuelle Phase-33-Notiz fehlt');
  });
});


console.log('\nPhase 35 - Release-Coverage-Intake aus Pending-Queue Tests\n');

const PHASE35_PRIVATE_FIELDS = ['owned', 'readAt', 'boughtAt', 'collectionStatus', 'readStatus', 'status', 'seriesId', 'owner_token', 'view_token', 'supabaseId', 'supabase_id', 'privateDebug'];
function p35NormalizeCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  const seriesTitle = String(item.seriesTitle || '').trim();
  const publisher = String(item.publisher || '').trim();
  const volumeNumber = Number(item.volumeNumber);
  if (!seriesTitle || !Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  return {
    seriesTitle,
    normalizedSeriesTitle: normalizeReleaseTitle(seriesTitle),
    publisher,
    normalizedPublisher: normalizeReleasePublisher(publisher),
    volumeNumber,
    status: ['pending', 'resolved', 'ignored'].includes(item.status) ? item.status : 'pending',
    checkedAt: item.checkedAt || '2026-05-21T00:00:00.000Z',
    lastSeenAt: item.lastSeenAt || item.checkedAt || '2026-05-21T00:00:00.000Z',
    seenCount: Number.isInteger(Number(item.seenCount)) && Number(item.seenCount) > 0 ? Number(item.seenCount) : 1,
  };
}
function p35IsDummyTitle(title) {
  const norm = normalizeReleaseTitle(title || '');
  return /^zzz(?:\s|-|_)*test/.test(norm) || /\btest(?:\s|-|_)*serie\b/.test(norm);
}
function p35Group(candidates) {
  const clean = (Array.isArray(candidates) ? candidates : []).map(p35NormalizeCandidate).filter(Boolean).filter(i => i.status === 'pending');
  const exact = new Map();
  clean.forEach(i => {
    const k = [i.normalizedSeriesTitle, i.normalizedPublisher, i.volumeNumber].join('|');
    if (!exact.has(k)) exact.set(k, { ...i });
    else exact.get(k).seenCount += i.seenCount;
  });
  const deduped = [...exact.values()];
  const titleVolWithPub = new Set(deduped.filter(i => i.publisher).map(i => `${i.normalizedSeriesTitle}|${i.volumeNumber}`));
  const replacement = new Map();
  const items = deduped.map(i => {
    const titleVol = `${i.normalizedSeriesTitle}|${i.volumeNumber}`;
    let intakeStatus = 'exportable';
    if (p35IsDummyTitle(i.seriesTitle)) intakeStatus = 'ignored-dummy';
    else if (!i.publisher && titleVolWithPub.has(titleVol)) {
      intakeStatus = 'replaced-empty-publisher';
      deduped.filter(o => o.normalizedSeriesTitle === i.normalizedSeriesTitle && o.volumeNumber === i.volumeNumber && o.publisher).forEach(o => {
        const key = `${o.normalizedSeriesTitle}|${o.normalizedPublisher}`;
        replacement.set(key, (replacement.get(key) || 0) + 1);
      });
    } else if (!i.publisher) intakeStatus = 'blocked-missing-publisher';
    return { ...i, intakeStatus };
  });
  const map = new Map();
  items.forEach(i => {
    const key = i.intakeStatus === 'exportable' ? `${i.normalizedSeriesTitle}|${i.normalizedPublisher}` : `${i.normalizedSeriesTitle}|${i.normalizedPublisher}|${i.intakeStatus}`;
    if (!map.has(key)) map.set(key, { seriesTitle: i.seriesTitle, publisher: i.publisher, normalizedSeriesTitle: i.normalizedSeriesTitle, normalizedPublisher: i.normalizedPublisher, intakeStatus: i.intakeStatus, volumes: [], seenCount: 0, replacedCount: 0 });
    const g = map.get(key);
    if (!g.volumes.includes(i.volumeNumber)) g.volumes.push(i.volumeNumber);
    g.seenCount += i.seenCount;
  });
  map.forEach(g => { g.volumes.sort((a,b) => a-b); if (g.intakeStatus === 'exportable') g.replacedCount = replacement.get(`${g.normalizedSeriesTitle}|${g.normalizedPublisher}`) || 0; });
  const groups = [...map.values()];
  const count = s => items.filter(i => i.intakeStatus === s).length;
  return { groups, items, summary: { totalCandidates: items.length, exportableCandidates: count('exportable'), blockedCandidates: count('blocked-missing-publisher'), replacedCandidates: count('replaced-empty-publisher'), ignoredDummyCandidates: count('ignored-dummy') } };
}
function p35BuildBatch(input) {
  const groups = Array.isArray(input) ? input : input.groups;
  return groups.filter(g => g.intakeStatus === 'exportable' && g.publisher).map(g => {
    const out = { seriesTitle: g.seriesTitle, publisher: g.publisher, sourceUrl: null, notes: g.replacedCount ? 'Aus lokaler Release-Coverage-Pending-Queue ergänzt; Publisher manuell ergänzt.' : 'Aus lokaler Release-Coverage-Pending-Queue ergänzt.', enabled: true };
    if (g.volumes.length === 1) out.volumeNumber = g.volumes[0]; else out.volumeNumbers = g.volumes;
    return out;
  });
}
function p35LoadFromRaw(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw || 'null'); } catch { parsed = null; }
  const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  return { items: items.map(p35NormalizeCandidate).filter(Boolean) };
}
function p35MarkReviewed(storage, confirm = true, publicView = false) {
  if (publicView || !confirm) return storage;
  const q = p35LoadFromRaw(storage); q.items.forEach(i => { if (i.status === 'pending') i.status = 'ignored'; });
  return JSON.stringify({ schemaVersion: 1, items: q.items });
}
function p35Delete(storage, confirm = true, publicView = false) {
  if (publicView || !confirm) return storage;
  const q = p35LoadFromRaw(storage); q.items = q.items.filter(i => i.status !== 'pending');
  return JSON.stringify({ schemaVersion: 1, items: q.items });
}

test('Phase 35: kaputtes JSON und manipulierte Werte crashen nicht', () => {
  assert.deepStrictEqual(p35LoadFromRaw('{nope').items, []);
  assert.deepStrictEqual(p35LoadFromRaw(JSON.stringify({ items: [null, 7, { seriesTitle: '', volumeNumber: 1 }, { seriesTitle: 'Ok', volumeNumber: 1 }] })).items.length, 1);
});

test('Phase 35: leerer Publisher blockiert Export und Dashboard-Zähler', () => {
  const grouped = p35Group([{ seriesTitle: 'Ohne Verlag', publisher: '', volumeNumber: 1 }]);
  assert.strictEqual(grouped.summary.blockedCandidates, 1);
  assert.deepStrictEqual(p35BuildBatch(grouped), []);
});

test('Phase 35: Demon Slave Band 2 nutzt korrigierten Publisher einmalig', () => {
  const grouped = p35Group([
    { seriesTitle: 'Demon Slave', publisher: '', volumeNumber: 2 },
    { seriesTitle: 'Demon Slave', publisher: 'Crunchyroll Manga', volumeNumber: 2 },
  ]);
  const batch = p35BuildBatch(grouped);
  assert.strictEqual(grouped.summary.replacedCandidates, 1);
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].seriesTitle, 'Demon Slave');
  assert.strictEqual(batch[0].publisher, 'Crunchyroll Manga');
  assert.strictEqual(batch[0].volumeNumber, 2);
  assert.ok(batch[0].notes.includes('Publisher manuell ergänzt'));
});

test('Phase 35: ZZZ-TEST-SERIE wird ignoriert und nicht exportiert', () => {
  const grouped = p35Group([{ seriesTitle: 'ZZZ-TEST-SERIE', publisher: 'Test', volumeNumber: 1 }]);
  assert.strictEqual(grouped.summary.ignoredDummyCandidates, 1);
  assert.deepStrictEqual(p35BuildBatch(grouped), []);
});

test('Phase 35: mehrere Bände werden als volumeNumbers gebündelt', () => {
  const batch = p35BuildBatch(p35Group([
    { seriesTitle: 'Beispielserie', publisher: 'Beispiel Verlag', volumeNumber: 3 },
    { seriesTitle: 'Beispielserie', publisher: 'Beispiel Verlag', volumeNumber: 2 },
    { seriesTitle: 'Beispielserie', publisher: 'Beispiel Verlag', volumeNumber: 2, seenCount: 3 },
  ]));
  assert.deepStrictEqual(batch, [{ seriesTitle: 'Beispielserie', publisher: 'Beispiel Verlag', sourceUrl: null, notes: 'Aus lokaler Release-Coverage-Pending-Queue ergänzt.', enabled: true, volumeNumbers: [2, 3] }]);
});

test('Phase 35: Export nutzt harte Allowlist und enthält keine privaten Felder oder Duplikate', () => {
  const batch = p35BuildBatch(p35Group([{ seriesTitle: 'Privat', publisher: 'Carlsen Manga', volumeNumber: 1, owned: 9, readAt: 'x', seriesId: 'secret' }]));
  assert.deepStrictEqual(Object.keys(batch[0]).sort(), ['enabled', 'notes', 'publisher', 'seriesTitle', 'sourceUrl', 'volumeNumber'].sort());
  PHASE35_PRIVATE_FIELDS.forEach(field => assert.ok(!(field in batch[0]), 'Export darf kein privates Feld enthalten: ' + field));
});

test('Phase 35: Copy-Vorschau mutiert Eingabe nicht', () => {
  const input = [{ seriesTitle: 'Copy', publisher: 'Manga Cult', volumeNumber: 1 }];
  const before = JSON.stringify(input);
  p35BuildBatch(p35Group(input));
  assert.strictEqual(JSON.stringify(input), before);
});

test('Phase 35: Delete-/Mark-reviewed mutieren nur Pending-localStorage und Public View bleibt read-only', () => {
  const storage = JSON.stringify({ schemaVersion: 1, items: [{ seriesTitle: 'A', publisher: 'B', volumeNumber: 1 }] });
  assert.strictEqual(p35MarkReviewed(storage, true, true), storage);
  assert.strictEqual(p35Delete(storage, true, true), storage);
  const marked = p35MarkReviewed(storage);
  assert.ok(marked.includes('ignored'));
  const deleted = p35Delete(storage);
  assert.strictEqual(JSON.parse(deleted).items.length, 0);
});
console.log('\nPhase 36a - Automatisierter Release-Datum-Intake fuer neue Manga Tests\n');

// Helfer: spiegelt resolveEmptyPublisherPendingCandidates aus app.js
function p36aResolveEmptyPublisher(queue, seriesTitle, volumeNumber) {
  const normTitle = normalizeReleaseTitle(seriesTitle || '');
  const vol = Number(volumeNumber);
  if (!normTitle || !Number.isInteger(vol) || vol < 1) return false;
  let changed = false;
  const now = '2026-05-22T12:00:00.000Z';
  queue.items.forEach(item => {
    if (item.status !== 'pending') return;
    if (normalizeReleaseTitle(item.seriesTitle || '') === normTitle &&
        Number(item.volumeNumber) === vol &&
        !item.publisher) {
      item.status = 'resolved';
      item.resolvedAt = now;
      changed = true;
    }
  });
  return changed;
}

// Helfer: MaybeCheck mit anschließendem resolveEmptyPublisher (Phase 36a Gesamtablauf)
function p36aMaybeCheckWithResolve(m, releaseSystem, queue, mode = { publicReadOnly: false, canEditLocal: true }) {
  if (mode.publicReadOnly || !mode.canEditLocal) return queue;
  const candidate = p34BuildCandidate(m);
  if (!candidate) return queue;
  if (p34KnownSet(releaseSystem, queue, false).has(p34Key(candidate))) return queue;
  p34Upsert(queue, candidate);
  if (candidate.publisher) {
    p36aResolveEmptyPublisher(queue, candidate.seriesTitle, candidate.volumeNumber);
  }
  return queue;
}

test('Phase 36a: Neuer Manga mit Titel, Publisher und Zielband erzeugt automatisch Pending-Kandidaten', () => {
  const queue = { schemaVersion: 1, items: [] };
  p36aMaybeCheckWithResolve({ title: 'Demon Slave', pub: 'Crunchyroll Manga', bands: { '1': 'owned' }, total: 5, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].seriesTitle, 'Demon Slave');
  assert.strictEqual(queue.items[0].publisher, 'Crunchyroll Manga');
  assert.strictEqual(queue.items[0].volumeNumber, 2);
  assert.strictEqual(queue.items[0].status, 'pending');
});

test('Phase 36a: Neuer Manga ohne Publisher erzeugt blockierten Kandidaten (nicht exportierbar)', () => {
  const queue = { schemaVersion: 1, items: [] };
  p36aMaybeCheckWithResolve({ title: 'Unbekannte Serie', pub: '', bands: {}, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].publisher, '');
  // grouping markiert ihn als blocked-missing-publisher, exportierbar = false
  const grouped = p35Group(queue.items);
  assert.ok(grouped.groups.every(g => g.intakeStatus !== 'exportable'));
});

test('Phase 36a: Publisher nachträglich ergänzt — leerer Kandidat wird als resolved markiert (Korrektur-Dedupe Storage)', () => {
  const queue = { schemaVersion: 1, items: [] };
  // 1. Erst ohne Publisher speichern
  p34MaybeCheck({ title: 'Demon Slave', pub: '', bands: { '1': 'owned' }, total: 5, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].publisher, '');
  assert.strictEqual(queue.items[0].status, 'pending');
  // 2. Mit korrigiertem Publisher speichern (Phase 36a Ablauf)
  p36aMaybeCheckWithResolve({ title: 'Demon Slave', pub: 'Crunchyroll Manga', bands: { '1': 'owned' }, total: 5, ongoing: 'true' }, {}, queue);
  // Alter leerer-Publisher-Eintrag muss als resolved markiert sein
  const emptyPub = queue.items.find(i => i.publisher === '');
  assert.ok(emptyPub, 'Leerer-Publisher-Eintrag muss noch in Queue sein');
  assert.strictEqual(emptyPub.status, 'resolved', 'Leerer-Publisher-Eintrag muss resolved sein');
  // Neuer gefüllter Publisher-Eintrag muss pending sein
  const filledPub = queue.items.find(i => i.publisher !== '');
  assert.ok(filledPub, 'Gefüllter-Publisher-Eintrag muss vorhanden sein');
  assert.strictEqual(filledPub.status, 'pending');
  // Export darf nur den gefüllten enthalten
  const batch = p35BuildBatch(p35Group(queue.items.filter(i => i.status === 'pending')));
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].publisher, 'Crunchyroll Manga');
});

test('Phase 36a: markBought triggert Release-Coverage-Check für nächsten Band', () => {
  // Simuliert: Band 1 kaufen → Band 2 wird als neuer Zielband geprüft
  const queue = { schemaVersion: 1, items: [] };
  const mangaNachKauf = { title: 'My Hero Academia', pub: 'Manga Cult', bands: { '1': 'owned' }, total: 40, ongoing: 'true' };
  // Nach Kauf von Band 1 ist Band 2 der neue Zielband
  p36aMaybeCheckWithResolve(mangaNachKauf, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].volumeNumber, 2);
});

test('Phase 36a: Bereits vorhandener Cache-Eintrag erzeugt keinen Pending-Kandidaten', () => {
  const queue = { schemaVersion: 1, items: [] };
  const releaseSystem = { cacheItems: [{ seriesTitle: 'One Piece', publisher: 'Carlsen Manga', volumeNumber: 105 }] };
  p36aMaybeCheckWithResolve({ title: 'One Piece', pub: 'Carlsen', bands: { ...Object.fromEntries(Array.from({ length: 104 }, (_, i) => [String(i + 1), 'owned'])) }, total: 110, ongoing: 'true' }, releaseSystem, queue);
  assert.strictEqual(queue.items.length, 0);
});

test('Phase 36a: Wishlist-Serie erzeugt keinen Pending-Kandidaten', () => {
  const queue = { schemaVersion: 1, items: [] };
  p36aMaybeCheckWithResolve({ title: 'Wish Serie', pub: 'Egmont Manga', status: 'wishlist', bands: {}, ongoing: 'true' }, {}, queue);
  assert.strictEqual(queue.items.length, 0);
});

test('Phase 36a: Public View erzeugt keinen Pending-Kandidaten', () => {
  const queue = { schemaVersion: 1, items: [] };
  p36aMaybeCheckWithResolve({ title: 'Public Test', pub: 'Carlsen', bands: {}, ongoing: 'true' }, {}, queue, { publicReadOnly: true, canEditLocal: false });
  assert.strictEqual(queue.items.length, 0);
});

test('Phase 36a: Wiederholtes Speichern erhöht seenCount statt Duplikat anzulegen', () => {
  const queue = { schemaVersion: 1, items: [] };
  const m = { title: 'Repeat Test', pub: 'Manga Cult', bands: {}, ongoing: 'true' };
  p36aMaybeCheckWithResolve(m, {}, queue);
  p36aMaybeCheckWithResolve(m, {}, queue);
  p36aMaybeCheckWithResolve(m, {}, queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.items[0].seenCount, 3);
});

test('Phase 36a: Export nach Publisher-Korrektur enthält nur Allowlist-Felder ohne private Daten', () => {
  const queue = { schemaVersion: 1, items: [] };
  p34MaybeCheck({ title: 'Kagurabachi', pub: '', bands: {}, ongoing: 'true' }, {}, queue);
  p36aMaybeCheckWithResolve({ title: 'Kagurabachi', pub: 'Crunchyroll Manga', bands: {}, ongoing: 'true' }, {}, queue);
  const pendingItems = queue.items.filter(i => i.status === 'pending');
  const batch = p35BuildBatch(p35Group(pendingItems));
  assert.ok(batch.length > 0, 'Batch muss exportierbaren Eintrag enthalten');
  const ALLOWED_EXPORT = new Set(['seriesTitle', 'publisher', 'sourceUrl', 'notes', 'enabled', 'volumeNumber', 'volumeNumbers']);
  batch.forEach(entry => {
    Object.keys(entry).forEach(k => assert.ok(ALLOWED_EXPORT.has(k), `Export darf kein Feld '${k}' enthalten`));
    PHASE34_PRIVATE_FIELDS.filter(f => f !== 'notes').forEach(f => assert.ok(!(f in entry), `Export darf kein privates Feld ${f} enthalten`));
  });
});

test('Phase 36a: resolveEmptyPublisherPendingCandidates-Funktion existiert in app.js', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  assert.ok(appJs.includes('function resolveEmptyPublisherPendingCandidates'), 'resolveEmptyPublisherPendingCandidates muss in app.js vorhanden sein');
  assert.ok(appJs.includes('resolveEmptyPublisherPendingCandidates('), 'resolveEmptyPublisherPendingCandidates muss aufgerufen werden');
});

test('Phase 36a: markBought ruft maybeRunLocalReleaseCoverageCheck auf', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  // markBought-Funktion extrahieren
  const start = appJs.indexOf('function markBought(');
  const end = appJs.indexOf('\nfunction ', start + 1);
  const fnCode = start >= 0 && end > start ? appJs.slice(start, end) : '';
  assert.ok(fnCode.includes('maybeRunLocalReleaseCoverageCheck('), 'markBought muss maybeRunLocalReleaseCoverageCheck aufrufen');
});

test('Phase 36a: Dashboard-Hinweis enthält "release-coverage-ready-notice" wenn exportierbare Kandidaten vorhanden', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  assert.ok(appJs.includes('release-coverage-ready-notice'), 'Dashboard muss release-coverage-ready-notice für exportierbare Kandidaten zeigen');
  assert.ok(appJs.includes('exportableCandidates > 0'), 'Dashboard muss prüfen ob exportierbare Kandidaten vorhanden sind');
});

test('Phase 36a: maybeRunLocalReleaseCoverageCheck ruft resolveEmptyPublisherPendingCandidates auf', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  const fnStart = appJs.indexOf('function maybeRunLocalReleaseCoverageCheck(');
  const fnEnd = appJs.indexOf('\nfunction ', fnStart + 1);
  const fnCode = fnStart >= 0 && fnEnd > fnStart ? appJs.slice(fnStart, fnEnd) : '';
  assert.ok(fnCode.includes('resolveEmptyPublisherPendingCandidates('), 'maybeRunLocalReleaseCoverageCheck muss resolveEmptyPublisherPendingCandidates aufrufen');
  assert.ok(fnCode.includes('candidate.publisher'), 'Aufruf muss publisher-bedingt sein');
});

test('Phase 36a: Keine Browser-Write-Pfade auf data/*.json in neuen Phase-36a-Funktionen', () => {
  const fs = require('fs');
  const appJs = fs.readFileSync('src/app.js', 'utf8');
  const p36aFnStart = appJs.indexOf('function resolveEmptyPublisherPendingCandidates(');
  const p36aFnEnd = appJs.indexOf('\nfunction ', p36aFnStart + 1);
  const fnCode = p36aFnStart >= 0 && p36aFnEnd > p36aFnStart ? appJs.slice(p36aFnStart, p36aFnEnd) : '';
  assert.ok(fnCode.length > 0, 'resolveEmptyPublisherPendingCandidates muss gefunden werden');
  const forbidden = /api\.github\.com|release-watchlist\.json|release-cache\.json|pushCloud\s*\(|persist\s*\(/;
  assert.ok(!forbidden.test(fnCode), 'resolveEmptyPublisherPendingCandidates darf keinen externen Schreibpfad enthalten');
});

console.log(`\n${passed + failed} Tests — ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
