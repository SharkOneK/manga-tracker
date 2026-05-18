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

function findReleaseMatchesForSeriesForTest(m, cache) {
  if (!cache || !Array.isArray(cache.items)) return [];
  const normT = normalizeReleaseTitle(m.title);
  const normP = normalizeReleasePublisher(m.pub || '');
  const firstMiss = mFirstMissingBand(m);
  if (firstMiss === null && m.ongoing === 'false') return [];
  const nextVol = firstMiss ?? mNextBand(m);

  return cache.items.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const cacheT = item.normalizedSeriesTitle || normalizeReleaseTitle(item.seriesTitle || '');
    const titleMatch = normT === cacheT
      || (cacheT.length >= 3 && normT.includes(cacheT))
      || (normT.length >= 3 && cacheT.includes(normT));
    if (!titleMatch) return false;
    const rawCacheP = item.normalizedPublisher || normalizeReleasePublisher(item.publisher || '');
    const cacheP = _PUB_ALIAS_MAP[rawCacheP] || rawCacheP;
    if (!releasePubsMatch(normP, cacheP)) return false;
    return item.volumeNumber === nextVol;
  });
}

function buildDashboardReleaseCheckPreviewForTest(mangaList, cache, status) {
  const before = JSON.stringify(mangaList);
  const cacheLoaded = status === 'loaded' && cache && Array.isArray(cache.items);
  const checkedSeries = Array.isArray(mangaList) ? mangaList.length : 0;
  const candidates = [];
  if (cacheLoaded) {
    mangaList.forEach(m => {
      const targetVolume = mFirstMissingBand(m) ?? mNextBand(m);
      const matches = findReleaseMatchesForSeriesForTest(m, cache)
        .filter(item => item && item.releaseDate && item.releaseDate !== m.nextDate);
      if (!matches.length) return;
      const best = matches[0];
      candidates.push({
        seriesId: m.id,
        id: `${m.id}:${best.volumeNumber || targetVolume}:${best.releaseDate}`,
        title: m.title || '',
        targetVolume,
        volumeNumber: best.volumeNumber || targetVolume,
        currentDate: m.nextDate || '',
        releaseDate: best.releaseDate,
      });
    });
  }
  assert.strictEqual(JSON.stringify(mangaList), before, 'Preview darf Manga-Daten nicht mutieren');
  return {
    cacheLoaded,
    checkedSeries,
    checkedVolumes: checkedSeries,
    releaseDateHits: candidates.length,
    noHits: Math.max(0, checkedSeries - candidates.length),
    candidates,
  };
}

// Phase 18e: Dashboard-Serienstatus-Prüfung (Preview-only)
function inspectSeriesStatusForTest(m) {
  const total = Number(m.total);
  const totalKnown = !isNaN(total) && total > 0;
  const owned = mOwned(m);
  const firstMissing = mFirstMissingBand(m);
  const missingCount = totalKnown ? Math.max(0, total - owned) : 0;
  const collectionStatus = mCollectionStatus(m);
  const seriesStatus = mSeriesStatus(m);
  const bandValues = Object.values(m.bands || {});
  const allKnownVolumesCollected = totalKnown && firstMissing === null;
  const allKnownVolumesRead = allKnownVolumesCollected && bandValues.length >= total && bandValues.every(v => v === 'completed');
  const reasons = [];

  if (m.ongoing === 'false' && firstMissing !== null) {
    reasons.push({ code: 'finished_missing_volumes', text: `abgeschlossen mit ${missingCount} fehlenden Baenden` });
  }
  if (m.ongoing === 'false' && m.nextDate) {
    reasons.push({ code: 'finished_has_next_date', text: 'abgeschlossen mit nextDate' });
  }
  if (m.ongoing === 'true' && allKnownVolumesRead && !m.nextDate) {
    reasons.push({ code: 'ongoing_complete_read_no_next_date', text: 'laufend, vollstaendig gelesen, ohne nextDate' });
  } else if (m.ongoing === 'true' && allKnownVolumesCollected && !m.nextDate) {
    reasons.push({ code: 'ongoing_complete_no_next_date', text: 'laufend, vollstaendig gesammelt, ohne nextDate' });
  }
  if (seriesStatus === 'completed' && firstMissing !== null) {
    reasons.push({ code: 'completed_display_missing_volumes', text: 'completed Anzeige mit fehlenden Baenden' });
  }

  return {
    title: m.title || '',
    status: m.ongoing === 'true' || m.ongoing === 'false' ? m.ongoing : 'unknown',
    collectionStatus,
    seriesStatus,
    owned,
    total: totalKnown ? total : null,
    firstMissing,
    nextDate: m.nextDate || '',
    reasons,
  };
}

function buildDashboardSeriesStatusPreviewForTest(mangaList, hooks = {}) {
  const before = JSON.stringify(mangaList);
  const checked = (Array.isArray(mangaList) ? mangaList : []).map(inspectSeriesStatusForTest);
  const flagged = checked.filter(item => item.reasons.length > 0);
  assert.strictEqual(JSON.stringify(mangaList), before, 'Serienstatus-Preview darf Manga-Daten nicht mutieren');
  assert.deepStrictEqual(hooks.events || [], [], 'Serienstatus-Preview darf kein persist/localStorage ausloesen');
  return {
    checkedSeries: checked.length,
    okSeries: checked.length - flagged.length,
    flaggedSeries: flagged.length,
    checked,
    flagged,
  };
}
// ─── Test-Runner ──────────────────────────────────────────────────────────

function renderDashboardReleaseCheckPreviewForTest(result) {
  if (!result) return 'Noch keine Pruefung ausgefuehrt';
  return (result.candidates || []).map((item, idx) =>
    `<label class="dashboard-release-candidate"><input type="checkbox" class="dashboard-release-apply-check" data-candidate-idx="${idx}">` +
    `<strong>${item.title}</strong><span>Band ${item.volumeNumber}</span><span>${item.currentDate || 'leer'} -> ${item.releaseDate}</span></label>`
  ).join('') +
    ((result.candidates || []).length
      ? '<button type="button" onclick="applySelectedDashboardReleaseDates()">Ausgewaehlte Release-Daten uebernehmen</button>'
      : '');
}

function applySelectedDashboardReleaseDatesForTest(mangaList, preview, selectedIndexes, options = {}) {
  const events = [];
  const selected = selectedIndexes.map(idx => preview.candidates[idx]).filter(Boolean);
  if (!selected.length) return { changed: 0, backupCreated: false, events };

  const valid = selected.filter(item => {
    const m = mangaList.find(x => x.id === item.seriesId);
    if (!m) return false;
    const currentTargetVolume = mFirstMissingBand(m) ?? mNextBand(m);
    return currentTargetVolume === item.targetVolume
      && item.volumeNumber === item.targetVolume
      && item.releaseDate
      && item.releaseDate !== m.nextDate;
  });
  if (!valid.length) return { changed: 0, backupCreated: false, events };

  events.push('confirm');
  if (options.confirm === false) return { changed: 0, backupCreated: false, events };

  events.push('backup');
  if (options.backupFails) return { changed: 0, backupCreated: false, events };

  let changed = 0;
  valid.forEach(item => {
    const m = mangaList.find(x => x.id === item.seriesId);
    if (!m) return;
    const protectedBefore = {
      owned: m.owned,
      read: m.read,
      boughtAt: m.boughtAt,
      readAt: m.readAt,
      coverUrl: m.coverUrl,
      isbn13: m.isbn13,
      collectionStatus: m.collectionStatus,
      ongoing: m.ongoing,
    };
    m.nextDate = item.releaseDate;
    changed++;
    assert.deepStrictEqual({
      owned: m.owned,
      read: m.read,
      boughtAt: m.boughtAt,
      readAt: m.readAt,
      coverUrl: m.coverUrl,
      isbn13: m.isbn13,
      collectionStatus: m.collectionStatus,
      ongoing: m.ongoing,
    }, protectedBefore, 'Nur nextDate darf geaendert werden');
  });
  events.push('persist');
  return { changed, backupCreated: true, events };
}

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

// Phase 18c Tests ----------------------------------------------------------

console.log('\nPhase 18c — Dashboard Release-Daten-Prüfung Tests\n');

test('Dashboard-Action: Button und Preview-Container sind in app.js vorhanden', () => {
  const appJs = require('fs').readFileSync('src/app.js', 'utf8');
  assert.ok(appJs.includes('Prüfen &amp; Korrigieren'), 'Dashboard-Bereich fehlt');
  assert.ok(appJs.includes('Alle Release-Daten prüfen'), 'Button fehlt');
  assert.ok(appJs.includes('dashboard-release-check-result'), 'Preview-Container fehlt');
});

test('Dashboard-Release-Check: robuster Preview bei leerem/nicht geladenem Cache', () => {
  const list = [{ title: 'Solo Leveling', pub: 'Altraverse', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const result = buildDashboardReleaseCheckPreviewForTest(list, null, 'missing');
  assert.strictEqual(result.cacheLoaded, false);
  assert.strictEqual(result.checkedSeries, 1);
  assert.strictEqual(result.releaseDateHits, 0);
  assert.strictEqual(result.noHits, 1);
  assert.deepStrictEqual(result.candidates, []);
});

test('Dashboard-Release-Check: findet Release-Datum-Treffer aus geladenem Cache', () => {
  const list = [{ title: 'Solo Leveling', pub: 'Altraverse', bands: { '1': 'owned' }, total: 3, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Solo Leveling', publisher: 'Altraverse', volumeNumber: 2, releaseDate: '2026-06-01' }] };
  const result = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  assert.strictEqual(result.cacheLoaded, true);
  assert.strictEqual(result.releaseDateHits, 1);
  assert.strictEqual(result.noHits, 0);
  assert.strictEqual(result.candidates[0].releaseDate, '2026-06-01');
  assert.strictEqual(result.candidates[0].volumeNumber, 2);
});

test('Dashboard-Release-Check: ignoriert Cache-Treffer ohne neues/abweichendes Datum', () => {
  const list = [{ title: 'Manga A', pub: 'Egmont Manga', bands: { '1': 'owned' }, total: 2, nextDate: '2026-07-01' }];
  const cache = { items: [{ seriesTitle: 'Manga A', publisher: 'Egmont', volumeNumber: 2, releaseDate: '2026-07-01' }] };
  const result = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  assert.strictEqual(result.releaseDateHits, 0);
  assert.strictEqual(result.noHits, 1);
});

test('Dashboard-Release-Check: Preview mutiert keine Manga-Daten', () => {
  const list = [{ title: 'Manga B', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const before = JSON.stringify(list);
  const cache = { items: [{ seriesTitle: 'Manga B', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-08-15' }] };
  const result = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  assert.strictEqual(result.releaseDateHits, 1);
  assert.strictEqual(JSON.stringify(list), before, 'nextDate darf nicht automatisch gesetzt werden');
});

// Phase 18d Tests ----------------------------------------------------------

console.log('\nPhase 18d - Explizite Dashboard-Release-Daten-Uebernahme Tests\n');

test('Dashboard-Release-Uebernahme: Kandidaten haben Checkboxen und Apply-Button', () => {
  const list = [{ id: 'm1', title: 'Manga C', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Manga C', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-01' }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const html = renderDashboardReleaseCheckPreviewForTest(preview);
  assert.ok(html.includes('type="checkbox"'), 'Checkbox fehlt');
  assert.ok(html.includes('dashboard-release-apply-check'), 'Auswahl-Klasse fehlt');
  assert.ok(html.includes('Ausgewaehlte Release-Daten uebernehmen'), 'Apply-Button fehlt');
  assert.ok(!html.includes('checked'), 'Checkboxen duerfen standardmaessig nicht aktiv sein');
});

test('Dashboard-Release-Uebernahme: ohne Auswahl keine Mutation', () => {
  const list = [{ id: 'm1', title: 'Manga D', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Manga D', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-02' }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const before = JSON.stringify(list);
  const result = applySelectedDashboardReleaseDatesForTest(list, preview, []);
  assert.strictEqual(result.changed, 0);
  assert.strictEqual(result.backupCreated, false);
  assert.strictEqual(JSON.stringify(list), before);
});

test('Dashboard-Release-Uebernahme: Abbruch im Bestaetigungsdialog mutiert nichts', () => {
  const list = [{ id: 'm1', title: 'Manga E', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Manga E', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-03' }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const before = JSON.stringify(list);
  const result = applySelectedDashboardReleaseDatesForTest(list, preview, [0], { confirm: false });
  assert.deepStrictEqual(result.events, ['confirm']);
  assert.strictEqual(result.changed, 0);
  assert.strictEqual(JSON.stringify(list), before);
});

test('Dashboard-Release-Uebernahme: schreibt nur erlaubtes Release-Datum', () => {
  const list = [{
    id: 'm1', title: 'Manga F', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null,
    owned: 1, read: 0, boughtAt: '2026-01-01', readAt: '2026-01-02',
    coverUrl: 'cover.jpg', isbn13: '9781234567890', collectionStatus: 'owned', ongoing: 'true',
  }];
  const cache = { items: [{
    seriesTitle: 'Manga F', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-04',
    isbn13: '9789999999999', coverUrl: 'new-cover.jpg',
  }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const result = applySelectedDashboardReleaseDatesForTest(list, preview, [0]);
  assert.strictEqual(result.changed, 1);
  assert.strictEqual(list[0].nextDate, '2026-09-04');
  assert.strictEqual(list[0].isbn13, '9781234567890');
  assert.strictEqual(list[0].coverUrl, 'cover.jpg');
  assert.strictEqual(list[0].collectionStatus, 'owned');
  assert.strictEqual(list[0].ongoing, 'true');
});

test('Dashboard-Release-Uebernahme: Backup wird vor Mutation erstellt', () => {
  const list = [{ id: 'm1', title: 'Manga G', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Manga G', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-05' }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const result = applySelectedDashboardReleaseDatesForTest(list, preview, [0]);
  assert.deepStrictEqual(result.events, ['confirm', 'backup', 'persist']);
  assert.strictEqual(result.backupCreated, true);
  assert.strictEqual(list[0].nextDate, '2026-09-05');
});

test('Dashboard-Release-Uebernahme: fehlgeschlagenes Backup verhindert Mutation', () => {
  const list = [{ id: 'm1', title: 'Manga H', pub: 'Tokyopop', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const cache = { items: [{ seriesTitle: 'Manga H', publisher: 'Tokyopop', volumeNumber: 2, releaseDate: '2026-09-06' }] };
  const preview = buildDashboardReleaseCheckPreviewForTest(list, cache, 'loaded');
  const result = applySelectedDashboardReleaseDatesForTest(list, preview, [0], { backupFails: true });
  assert.deepStrictEqual(result.events, ['confirm', 'backup']);
  assert.strictEqual(result.changed, 0);
  assert.strictEqual(list[0].nextDate, null);
});
// ─── Ergebnis ─────────────────────────────────────────────────────────────


// Phase 18e Tests ----------------------------------------------------------

console.log('\nPhase 18e - Dashboard Serien-Status-Pruefung Preview Tests\n');

test('Dashboard-Serienstatus-Check: Button und Preview-Container sind in app.js vorhanden', () => {
  const appJs = require('fs').readFileSync('src/app.js', 'utf8');
  assert.ok(appJs.includes('Alle Serien-Status'), 'Button fehlt');
  assert.ok(appJs.includes('dashboard-series-status-check-result'), 'Preview-Container fehlt');
  assert.ok(appJs.includes('runDashboardSeriesStatusCheck'), 'Run-Funktion fehlt');
});

test('Dashboard-Serienstatus-Check: robuster Preview bei leerer Datenbank', () => {
  const result = buildDashboardSeriesStatusPreviewForTest([]);
  assert.strictEqual(result.checkedSeries, 0);
  assert.strictEqual(result.okSeries, 0);
  assert.strictEqual(result.flaggedSeries, 0);
  assert.deepStrictEqual(result.flagged, []);
});

test('Dashboard-Serienstatus-Check: erkennt auffaellige Status-Kombinationen', () => {
  const list = [
    { title: 'Abgeschlossen mit Luecke', ongoing: 'false', bands: { '1': 'owned' }, total: 3, nextDate: null },
    { title: 'Abgeschlossen mit Datum', ongoing: 'false', bands: { '1': 'completed' }, total: 1, nextDate: '2026-10-01' },
    { title: 'Laufend fertig gelesen', ongoing: 'true', bands: { '1': 'completed', '2': 'completed' }, total: 2, nextDate: null },
  ];
  const result = buildDashboardSeriesStatusPreviewForTest(list);
  const codes = result.flagged.flatMap(item => item.reasons.map(r => r.code));
  assert.strictEqual(result.checkedSeries, 3);
  assert.strictEqual(result.flaggedSeries, 3);
  assert.ok(codes.includes('finished_missing_volumes'));
  assert.ok(codes.includes('finished_has_next_date'));
  assert.ok(codes.includes('ongoing_complete_read_no_next_date'));
});

test('Dashboard-Serienstatus-Check: unauffaellige Serien werden nicht falsch markiert', () => {
  const list = [
    { title: 'Laufend mit fehlendem Band und Datum', ongoing: 'true', bands: { '1': 'owned' }, total: 2, nextDate: '2026-10-01' },
    { title: 'Abgeschlossen komplett', ongoing: 'false', bands: { '1': 'completed', '2': 'completed' }, total: 2, nextDate: null },
    { title: 'Unbekannt kleine DB', ongoing: 'unknown', bands: {}, total: null, nextDate: null },
  ];
  const result = buildDashboardSeriesStatusPreviewForTest(list);
  assert.strictEqual(result.checkedSeries, 3);
  assert.strictEqual(result.okSeries, 3);
  assert.strictEqual(result.flaggedSeries, 0);
});

test('Dashboard-Serienstatus-Check: Preview mutiert keine Daten und schreibt nicht', () => {
  const events = [];
  const list = [{ title: 'Manga I', ongoing: 'false', bands: { '1': 'owned' }, total: 2, nextDate: null }];
  const before = JSON.stringify(list);
  const result = buildDashboardSeriesStatusPreviewForTest(list, { events });
  assert.strictEqual(result.flaggedSeries, 1);
  assert.strictEqual(JSON.stringify(list), before);
  assert.deepStrictEqual(events, [], 'kein persist/localStorage-Write durch reine Pruefung');
});

console.log(`\n${passed + failed} Tests — ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
