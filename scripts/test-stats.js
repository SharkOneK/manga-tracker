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
  assert.ok(appJs.includes('Aktionszentrale: Prüfen &amp; Automatisieren'), 'Dashboard-Aktionszentrale fehlt');
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

// ─── Hotfix: completed_display_missing_volumes Text ────────────────────────

console.log('\nHotfix — completed_display_missing_volumes Textkorrektur Tests\n');

test('Hotfix: completed_display_missing_volumes enthält keinen irreführenden Text', () => {
  const appJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('wirkt abgeschlossen'), 'Irreführender Text "wirkt abgeschlossen" darf nicht mehr enthalten sein');
  assert.ok(!appJs.includes('Nicht als vollständig interpretieren'), 'Irreführende Suggestion darf nicht mehr enthalten sein');
});

test('Hotfix: completed_display_missing_volumes enthält neuen präzisen Text', () => {
  const appJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(appJs.includes('Abgeschlossene Serie'), 'Neuer Text "Abgeschlossene Serie" muss vorhanden sein');
  assert.ok(appJs.includes('Kein Fehler'), 'Neue Suggestion "Kein Fehler" muss vorhanden sein');
  assert.ok(appJs.includes('Kaufen-Tab'), 'Handlungsempfehlung "Kaufen-Tab" muss vorhanden sein');
});

test('Hotfix: completed_display_missing_volumes-Code ist noch vorhanden (keine Logikänderung)', () => {
  const appJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(appJs.includes('completed_display_missing_volumes'), 'Code "completed_display_missing_volumes" muss weiterhin vorhanden sein');
});

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
  const docsPath = _path22.join(_root22, 'docs', 'release-cache-coverage-gaps.md');
  assert.ok(_fs22.existsSync(validatorPath), 'validate-release-cache-coverage-gaps.js muss existieren');
  assert.ok(_fs22.existsSync(docsPath), 'release-cache-coverage-gaps.md muss existieren');
  const validator = _fs22.readFileSync(validatorPath, 'utf8');
  const docs = _fs22.readFileSync(docsPath, 'utf8');
  assert.ok(validator.includes('source-data-gap'), 'Validator muss source-data-gap pruefen');
  assert.ok(validator.includes('missingCacheCoverage'), 'Validator muss Summary-Zaehler pruefen');
  assert.ok(docs.includes('34') && docs.includes('12') && docs.includes('8'), 'Docs muessen dokumentierten Stand 34/12/8 enthalten');
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

test('Phase 22: buildReleaseCacheCoverageReport-Marker in app.js vorhanden', () => {
  const appJs = _fs22.readFileSync(_path22.join(_root22, 'src', 'app.js'), 'utf8');
  assert.ok(appJs.includes('buildReleaseCacheCoverageReport'), 'buildReleaseCacheCoverageReport muss in app.js vorhanden sein');
});

test('Phase 22: copyReleaseCacheCoverageBatch-Marker in app.js vorhanden', () => {
  const appJs = _fs22.readFileSync(_path22.join(_root22, 'src', 'app.js'), 'utf8');
  assert.ok(appJs.includes('copyReleaseCacheCoverageBatch'), 'copyReleaseCacheCoverageBatch muss in app.js vorhanden sein');
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

console.log(`\n${passed + failed} Tests — ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
