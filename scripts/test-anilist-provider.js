#!/usr/bin/env node
// scripts/test-anilist-provider.js — Phase 73: AniList-Provider-Tests (offline)
//
// Testet ausschließlich src/anilist-utils.js (UMD, pure Funktionen). Es findet
// KEIN Netzzugriff statt: der Fetch-Glue in src/app.js nimmt ein injizierbares
// fetchImpl entgegen, hier werden nur die davon gelieferten Werte klassifiziert.
// CI darf niemals von AniList abhängen.
'use strict';

const assert = require('assert');
const AniList = require('../src/anilist-utils.js');

let _passed = 0;
let _failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
    _failed++;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function fullMedia(overrides) {
  return Object.assign({
    id: 16498,
    title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
    episodes: 25,
    status: 'RELEASING',
    format: 'TV',
    seasonYear: 2013,
    season: 'SPRING',
    coverImage: { large: 'https://img.anili.st/cover-16498.jpg' },
    genres: ['Action', 'Drama'],
    nextAiringEpisode: { episode: 26, airingAt: 1770000000 },
    relations: { edges: [] },
  }, overrides || {});
}

// Antwort-Hülle wie sie AniList liefert.
function pageBody(mediaList) {
  return { data: { Page: { media: mediaList } } };
}

console.log('\nPhase 73 — AniList-Provider Tests (offline)\n');

// ─── 1) buildSearchQuery ──────────────────────────────────────────────────

runTest('buildSearchQuery: type: ANIME in der Query, Titel nur in variables (keine Query-Injection)', function() {
  const payload = AniList.buildSearchQuery('Attack on Titan"){ id } #', 5);
  assert.ok(payload.query.includes('type: ANIME'), 'Query muss type: ANIME enthalten');
  assert.ok(payload.query.includes('search: $q'), 'Suchbegriff muss als Variable referenziert werden');
  assert.ok(!payload.query.includes('Attack on Titan'), 'Titel darf NICHT in den Query-Text interpoliert werden');
  assert.strictEqual(payload.variables.q, 'Attack on Titan"){ id } #');
  assert.strictEqual(payload.variables.perPage, 5);
  // Alle in der Spec geforderten Felder werden angefragt
  ['id', 'episodes', 'status', 'format', 'seasonYear', 'coverImage', 'genres',
   'nextAiringEpisode', 'relations'].forEach(function(field) {
    assert.ok(payload.query.includes(field), 'Feld fehlt in der Query: ' + field);
  });
});

runTest('buildSearchQuery: perPage wird auf einen sinnvollen Bereich normalisiert', function() {
  assert.strictEqual(AniList.buildSearchQuery('x').variables.perPage, 10);
  assert.strictEqual(AniList.buildSearchQuery('x', 0).variables.perPage, 10);
  assert.strictEqual(AniList.buildSearchQuery('x', 999).variables.perPage, 25);
  assert.strictEqual(AniList.buildSearchQuery('x', 'abc').variables.perPage, 10);
});

// ─── 2) Mapping Happy Path ────────────────────────────────────────────────

runTest('mapMediaToEntry: vollständige Fixture wird korrekt gemappt', function() {
  const entry = AniList.mapMediaToEntry(fullMedia(), { id: 'fixed-id', now: 1700000000000 });
  assert.strictEqual(entry.id, 'fixed-id');
  assert.strictEqual(entry.title, 'Attack on Titan');
  assert.strictEqual(entry.mediaType, 'anime');
  assert.strictEqual(entry.total, 25);
  assert.strictEqual(entry.ongoing, 'true');
  assert.strictEqual(entry.cover, 'https://img.anili.st/cover-16498.jpg');
  assert.deepStrictEqual(entry.genres, ['Action', 'Drama']);
  assert.strictEqual(entry.pub, '', 'Anime hat keinen Verlag — pub bleibt leer');
  assert.deepStrictEqual(entry.bands, {}, 'Import legt keine Sehstatus an');
  assert.strictEqual(entry.at, 1700000000000);
  assert.strictEqual(Object.keys(entry.seasons).length, 25);
  assert.strictEqual(entry.seasons['1'], 1);
  assert.strictEqual(entry.externalIds.anilistId, 16498);
  assert.strictEqual(entry.externalIds.anilistRootId, 16498, 'ohne PREQUEL-Kante ist die Media-ID selbst der Anker');
});

runTest('mapMediaToEntry: Titel-Fallback english → romaji → native, alles leer ⇒ null', function() {
  assert.strictEqual(
    AniList.mapMediaToEntry(fullMedia({ title: { english: null, romaji: 'Romaji-Titel', native: 'ネイティブ' } }), {}).title,
    'Romaji-Titel');
  assert.strictEqual(
    AniList.mapMediaToEntry(fullMedia({ title: { english: '  ', romaji: null, native: 'ネイティブ' } }), {}).title,
    'ネイティブ');
  assert.strictEqual(
    AniList.mapMediaToEntry(fullMedia({ title: { english: null, romaji: '', native: '   ' } }), {}),
    null, 'Eintrag ohne verwertbaren Titel wird verworfen');
  assert.strictEqual(AniList.mapMediaToEntry(null, {}), null);
  assert.strictEqual(AniList.mapMediaToEntry('kein objekt', {}), null);
});

runTest('mapMediaToEntry: Wunschlisten-Kontext setzt status "wishlist", sonst "owned"', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia(), { wishlist: true }).status, 'wishlist');
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia(), { wishlist: false }).status, 'owned');
});

// ─── 3) ongoing-Ableitung ─────────────────────────────────────────────────

runTest('ongoing: RELEASING → "true"', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'RELEASING' }), {}).ongoing, 'true');
});
runTest('ongoing: FINISHED → "false"', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'FINISHED' }), {}).ongoing, 'false');
});
runTest('ongoing: NOT_YET_RELEASED → null (nicht "false" raten)', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'NOT_YET_RELEASED' }), {}).ongoing, null);
});
runTest('ongoing: CANCELLED → null', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'CANCELLED' }), {}).ongoing, null);
});
runTest('ongoing: HIATUS → null', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'HIATUS' }), {}).ongoing, null);
});
runTest('ongoing: unbekannter/fehlender Status → null', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: 'WAT' }), {}).ongoing, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ status: undefined }), {}).ongoing, null);
});

// ─── 4) seasons ───────────────────────────────────────────────────────────

runTest('seasons: "Season 2" im Titel → alle Bänder tragen Ordinal 2', function() {
  const media = fullMedia({
    title: { english: 'Attack on Titan Season 2', romaji: null, native: null },
    episodes: 12,
  });
  const entry = AniList.mapMediaToEntry(media, {});
  assert.strictEqual(Object.keys(entry.seasons).length, 12);
  Object.values(entry.seasons).forEach(function(v) { assert.strictEqual(v, 2); });
});

runTest('seasons: "2nd Season" / "Part 3" werden erkannt', function() {
  const a = AniList.mapMediaToEntry(fullMedia({ title: { english: 'Kaguya-sama 2nd Season', romaji: null, native: null }, episodes: 2 }), {});
  assert.strictEqual(a.seasons['1'], 2);
  const b = AniList.mapMediaToEntry(fullMedia({ title: { english: 'Serie Part 3', romaji: null, native: null }, episodes: 2 }), {});
  assert.strictEqual(b.seasons['1'], 3);
});

runTest('seasons: ohne Staffelhinweis → Ordinal 1', function() {
  const entry = AniList.mapMediaToEntry(fullMedia({ title: { english: 'Cowboy Bebop', romaji: null, native: null }, episodes: 3 }), {});
  assert.deepStrictEqual(entry.seasons, { 1: 1, 2: 1, 3: 1 });
});

runTest('seasons: episodes null → seasons leer (keine geratenen Episodenzahlen)', function() {
  const entry = AniList.mapMediaToEntry(fullMedia({ episodes: null }), {});
  assert.strictEqual(entry.total, null);
  assert.deepStrictEqual(entry.seasons, {});
});

runTest('seasons: alle Werte sind Number.isFinite-tauglich (sonst filtert die Projektion still)', function() {
  const entry = AniList.mapMediaToEntry(fullMedia({ episodes: 4 }), {});
  Object.entries(entry.seasons).forEach(function(pair) {
    assert.ok(Number.isFinite(Number(pair[1])), 'seasons[' + pair[0] + '] ist nicht finit: ' + pair[1]);
  });
});

// ─── 5) total ─────────────────────────────────────────────────────────────

runTest('total: null / 0 / negativ / nicht-numerisch / nicht-ganzzahlig → null', function() {
  [null, undefined, 0, -5, 'zwölf', {}, [], 12.5, NaN].forEach(function(v) {
    const entry = AniList.mapMediaToEntry(fullMedia({ episodes: v }), {});
    assert.strictEqual(entry.total, null, 'episodes=' + JSON.stringify(v) + ' sollte total=null ergeben');
  });
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ episodes: 1 }), {}).total, 1);
});

// ─── 6) nextDate ──────────────────────────────────────────────────────────

runTest('nextDate: airingAt → YYYY-MM-DD in lokaler Zeitzone (kein Off-by-one)', function() {
  const airingAt = 1770000000;
  const expected = (function() {
    const d = new Date(airingAt * 1000);
    const pad = function(n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  })();
  const entry = AniList.mapMediaToEntry(fullMedia({ nextAiringEpisode: { episode: 26, airingAt } }), {});
  assert.strictEqual(entry.nextDate, expected);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(entry.nextDate), 'nextDate muss dem ISO-Datumsformat entsprechen');
  assert.deepStrictEqual(entry.anilistAiring, { episode: 26, airingAt });
});

runTest('nextDate: nextAiringEpisode null / unplausible Werte → null', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ nextAiringEpisode: null }), {}).nextDate, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ nextAiringEpisode: null }), {}).anilistAiring, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ nextAiringEpisode: { episode: 1, airingAt: 'bald' } }), {}).nextDate, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ nextAiringEpisode: { episode: 1, airingAt: -5 } }), {}).nextDate, null);
});

// ─── 7) Cover ─────────────────────────────────────────────────────────────

runTest('cover: javascript: und http: → null, https: wird durchgereicht', function() {
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ coverImage: { large: 'javascript:alert(1)' } }), {}).cover, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ coverImage: { large: 'http://example.com/c.jpg' } }), {}).cover, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ coverImage: { large: 'nonsense' } }), {}).cover, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ coverImage: null }), {}).cover, null);
  assert.strictEqual(AniList.mapMediaToEntry(fullMedia({ coverImage: { large: 'https://x/c.jpg' } }), {}).cover, 'https://x/c.jpg');
});

runTest('genres: Nicht-Strings/leer raus, dedupliziert, gekappt', function() {
  const entry = AniList.mapMediaToEntry(fullMedia({
    genres: ['Action', 'Action', '', '  ', null, 42, { x: 1 }, 'Drama'],
  }), {});
  assert.deepStrictEqual(entry.genres, ['Action', 'Drama']);
  const many = AniList.mapMediaToEntry(fullMedia({
    genres: Array.from({ length: 50 }, function(_, i) { return 'G' + i; }),
  }), {});
  assert.strictEqual(many.genres.length, AniList.MAX_GENRES);
  assert.deepStrictEqual(AniList.mapMediaToEntry(fullMedia({ genres: 'Action' }), {}).genres, []);
});

// ─── 8) Fehlerfälle (classifyError) ───────────────────────────────────────

runTest('classifyError: Timeout (AbortError) → "timeout"', function() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  assert.strictEqual(AniList.classifyError(err), 'timeout');
  const t = new Error('timed out');
  t.name = 'TimeoutError';
  assert.strictEqual(AniList.classifyError(t), 'timeout');
});

runTest('classifyError: Netzwerkabbruch (TypeError) → "network"', function() {
  assert.strictEqual(AniList.classifyError(new TypeError('Failed to fetch')), 'network');
});

runTest('classifyError: HTTP 429 → "rate-limited"', function() {
  assert.strictEqual(AniList.classifyError(null, 429, {}), 'rate-limited');
});

runTest('classifyError: HTTP 5xx → "http"', function() {
  assert.strictEqual(AniList.classifyError(null, 500, {}), 'http');
  assert.strictEqual(AniList.classifyError(null, 503, null), 'http');
  assert.strictEqual(AniList.classifyError(null, 404, {}), 'http');
});

runTest('classifyError: HTTP 200 mit errors-Array → "http" (res.ok ist kein Erfolgssignal)', function() {
  assert.strictEqual(
    AniList.classifyError(null, 200, { errors: [{ message: 'Not Found' }], data: null }),
    'http');
});

runTest('classifyError: data null / media kein Array / kaputtes JSON → "malformed"', function() {
  assert.strictEqual(AniList.classifyError(null, 200, { data: null }), 'malformed');
  assert.strictEqual(AniList.classifyError(null, 200, { data: { Page: { media: 'nichtarray' } } }), 'malformed');
  assert.strictEqual(AniList.classifyError(null, 200, { data: {} }), 'malformed');
  assert.strictEqual(AniList.classifyError(null, 200, null), 'malformed');
  assert.strictEqual(AniList.classifyError(null, 200, 'kein json'), 'malformed');
});

runTest('classifyError: leeres Trefferarray und Liste nur mit null-Einträgen → "empty"', function() {
  assert.strictEqual(AniList.classifyError(null, 200, pageBody([])), 'empty');
  assert.strictEqual(AniList.classifyError(null, 200, pageBody([null, null])), 'empty');
});

runTest('classifyError: valide Antwort → null (kein Fehler)', function() {
  assert.strictEqual(AniList.classifyError(null, 200, pageBody([fullMedia()])), null);
});

runTest('extractMediaList: null-Einträge in der Liste werden defensiv gefiltert, kein Absturz', function() {
  const list = AniList.extractMediaList(pageBody([null, fullMedia(), 'string', undefined]));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 16498);
  assert.deepStrictEqual(AniList.extractMediaList(null), []);
  assert.deepStrictEqual(AniList.extractMediaList({ data: null }), []);
});

// Simulierter Provider-Durchlauf mit injiziertem Fetch — spiegelt die Glue-Logik
// aus src/app.js (anilistFetch) offline nach, ohne echten Netzzugriff.
runTest('Injizierter Fetch: kompletter Suchlauf ohne Netz liefert einen gemappten Eintrag', function() {
  // Stellvertreter für die Antwort, die anilistFetch() in src/app.js von einem
  // injizierten fetchImpl bekommt — hier komplett synthetisch, ohne Netz.
  const stubbedResponse = { status: 200, body: pageBody([fullMedia()]) };
  assert.strictEqual(AniList.classifyError(null, stubbedResponse.status, stubbedResponse.body), null);
  const list = AniList.extractMediaList(stubbedResponse.body);
  assert.strictEqual(list.length, 1);
  const entry = AniList.mapMediaToEntry(list[0], { id: 'x' });
  assert.strictEqual(entry.mediaType, 'anime');
  assert.strictEqual(entry.total, 25);
});

// ─── 9) pickBestCandidate ─────────────────────────────────────────────────

runTest('pickBestCandidate: exakter Titeltreffer gewinnt', function() {
  const list = [
    fullMedia({ id: 1, title: { english: 'Attack on Titan: No Regrets', romaji: null, native: null } }),
    fullMedia({ id: 2, title: { english: 'Attack on Titan', romaji: null, native: null } }),
  ];
  const res = AniList.pickBestCandidate('Attack on Titan', list);
  assert.strictEqual(res.best.id, 2);
});

runTest('pickBestCandidate: exakter Treffer auch über romaji/native', function() {
  const list = [fullMedia({ id: 7, title: { english: null, romaji: 'Shingeki no Kyojin', native: null } })];
  assert.strictEqual(AniList.scoreCandidate('Shingeki no Kyojin', list[0]), 100);
  assert.strictEqual(AniList.pickBestCandidate('Shingeki no Kyojin', list).best.id, 7);
});

runTest('pickBestCandidate: zwei nahe Treffer → ambiguous true', function() {
  const list = [
    fullMedia({ id: 1, title: { english: 'Attack on Titan Season 2', romaji: null, native: null } }),
    fullMedia({ id: 2, title: { english: 'Attack on Titan Season 3', romaji: null, native: null } }),
  ];
  assert.strictEqual(AniList.pickBestCandidate('Attack on Titan', list).ambiguous, true);
});

runTest('pickBestCandidate: leere Liste / kein Array → best null, ambiguous false', function() {
  assert.deepStrictEqual(AniList.pickBestCandidate('x', []), { best: null, ambiguous: false });
  assert.deepStrictEqual(AniList.pickBestCandidate('x', null), { best: null, ambiguous: false });
  assert.deepStrictEqual(AniList.pickBestCandidate('x', [null, undefined]), { best: null, ambiguous: false });
});

// ─── 10) Kein Feld-Leak ───────────────────────────────────────────────────

runTest('mapMediaToEntry ist eine Allowlist: Zusatzfelder der API landen nicht im Eintrag', function() {
  const media = fullMedia({
    isAdult: true,
    siteUrl: 'https://anilist.co/anime/16498',
    description: '<script>alert(1)</script>',
    mediaType: 'movie',
    id: 16498,
    notes: 'geheim',
    owner_token: 'darf-nie-rein',
  });
  media.__proto__value = 'x'; // harmloser Zusatzkey mit proto-artigem Namen
  const entry = AniList.mapMediaToEntry(media, { id: 'own-id' });
  ['isAdult', 'siteUrl', 'description', 'owner_token', '__proto__value'].forEach(function(k) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, k), false, 'Feld geleakt: ' + k);
  });
  assert.strictEqual(entry.id, 'own-id', 'die API darf die interne id nicht überschreiben');
  assert.strictEqual(entry.mediaType, 'anime', 'die API darf mediaType nicht überschreiben');
  assert.strictEqual(entry.notes, '', 'notes kommt nie aus der API');
  // Prototype Pollution: der Eintrag erbt keine manipulierten Eigenschaften
  assert.strictEqual(Object.getPrototypeOf(entry), Object.prototype);
});

// ─── 11) Episoden-Obergrenze ──────────────────────────────────────────────

runTest('Episoden-Obergrenze: episodes 9999 → seasons gekappt, total bleibt korrekt', function() {
  const entry = AniList.mapMediaToEntry(fullMedia({ episodes: 9999 }), {});
  assert.strictEqual(entry.total, 9999, 'total spiegelt die echte Episodenzahl');
  assert.strictEqual(Object.keys(entry.seasons).length, AniList.MAX_EPISODES,
    'seasons wird auf MAX_EPISODES gekappt, sonst friert die Bandverwaltung ein');
  assert.ok(AniList.MAX_EPISODES <= 2000);
});

// ─── 12) airingCountdownDays (Phase 76) ────────────────────────────────────
// Reine, injizierbare Funktion — nowMs fest, kein Date.now() intern.

runTest('airingCountdownDays: heute → 0', function() {
  // 2024-06-15 12:00 UTC lokal — nowMs beliebig, solange derselbe lokale Tag.
  const now = new Date(2024, 5, 15, 12, 0, 0).getTime();
  assert.strictEqual(AniList.airingCountdownDays('2024-06-15', now), 0);
});

runTest('airingCountdownDays: morgen → 1', function() {
  const now = new Date(2024, 5, 15, 23, 59, 0).getTime();
  assert.strictEqual(AniList.airingCountdownDays('2024-06-16', now), 1);
});

runTest('airingCountdownDays: gestern → -1', function() {
  const now = new Date(2024, 5, 15, 0, 0, 0).getTime();
  assert.strictEqual(AniList.airingCountdownDays('2024-06-14', now), -1);
});

runTest('airingCountdownDays: in 7 Tagen → 7', function() {
  const now = new Date(2024, 5, 15, 8, 0, 0).getTime();
  assert.strictEqual(AniList.airingCountdownDays('2024-06-22', now), 7);
});

runTest('airingCountdownDays: ungültig/leer/kein String → null', function() {
  const now = Date.now();
  [null, undefined, '', '2024-13-99', '15-06-2024', 20240615, {}, []].forEach(function(v) {
    assert.strictEqual(AniList.airingCountdownDays(v, now), null, 'sollte null ergeben für: ' + JSON.stringify(v));
  });
});

runTest('airingCountdownDays: Rechnung über lokale Mitternacht, kein Off-by-one an DST-nahen Tagen', function() {
  // Uhrzeitanteil von nowMs darf das Ergebnis nicht verschieben — nur das Datum zählt.
  const morning = new Date(2024, 2, 30, 0, 1, 0).getTime();
  const evening = new Date(2024, 2, 30, 23, 58, 0).getTime();
  assert.strictEqual(AniList.airingCountdownDays('2024-03-31', morning), 1);
  assert.strictEqual(AniList.airingCountdownDays('2024-03-31', evening), 1);
});

// ─── Ergebnis ─────────────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
if (_failed > 0) process.exit(1);
