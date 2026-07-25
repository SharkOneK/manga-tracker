#!/usr/bin/env node
// scripts/test-tmdb-provider.js — Phase 75: TMDB-Provider-Tests (offline)
//
// Testet ausschließlich scripts/tmdb-provider.js (Node, pure Funktionen + der
// Fetch-Glue mit injiziertem fetchImpl). Es findet KEIN Netzzugriff statt —
// CI darf niemals von TMDB abhängen.
'use strict';

const assert = require('assert');
const TMDB = require('./tmdb-provider.js');

let _passed = 0;
let _failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
    _failed++;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function fullTmdb(overrides) {
  return Object.assign({
    id: 1399,
    name: 'Game of Thrones',
    networks: [{ id: 49, name: 'HBO' }],
    number_of_seasons: 8,
    number_of_episodes: 73,
    seasons: [
      { season_number: 0, episode_count: 2 }, // Specials — muss ausgeschlossen bleiben
      { season_number: 1, episode_count: 10 },
      { season_number: 2, episode_count: 10 },
      { season_number: 3, episode_count: 10 },
      { season_number: 4, episode_count: 10 },
      { season_number: 5, episode_count: 10 },
      { season_number: 6, episode_count: 10 },
      { season_number: 7, episode_count: 7 },
      { season_number: 8, episode_count: 6 },
    ],
    status: 'Ended',
    poster_path: '/gwPSoYUHAKmdyVywgLpKKA5dl2S.jpg',
    genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 18, name: 'Drama' }],
    overview: 'Sieben Adelshäuser kämpfen um die Kontrolle des mythischen Landes Westeros.',
  }, overrides || {});
}

function jsonResponse(status, body) {
  return { status, async json() { return body; } };
}

(async function main() {
  console.log('\nPhase 75 — TMDB-Provider Tests (offline)\n');

  // ─── 1) computeSeasonsAndTotal ──────────────────────────────────────────

  await runTest('computeSeasonsAndTotal: fortlaufende Bänder über alle regulären Staffeln, Season 0 ausgeschlossen', function() {
    const result = TMDB.computeSeasonsAndTotal(fullTmdb().seasons);
    assert.strictEqual(result.total, 73, 'total = Summe der regulären episode_count (nicht number_of_episodes)');
    assert.strictEqual(result.seasonCount, 8);
    assert.strictEqual(Object.keys(result.seasons).length, 73);
    assert.strictEqual(result.seasons['1'], 1);
    assert.strictEqual(result.seasons['10'], 1);
    assert.strictEqual(result.seasons['11'], 2, 'S2E1 ist Band 11 (fortlaufend nach S1-Ende)');
    assert.strictEqual(result.seasons['73'], 8, 'letzter Band gehört zur letzten Staffel');
  });

  await runTest('computeSeasonsAndTotal: Season 0 (Specials) trägt nie zu total/seasons bei', function() {
    const onlySpecials = TMDB.computeSeasonsAndTotal([{ season_number: 0, episode_count: 12 }]);
    assert.strictEqual(onlySpecials.total, null);
    assert.deepStrictEqual(onlySpecials.seasons, {});
    assert.strictEqual(onlySpecials.seasonCount, 0);
  });

  await runTest('computeSeasonsAndTotal: seasons[] fehlt/leer → total null, seasons leer', function() {
    [undefined, null, [], 'kein-array'].forEach(function(v) {
      const r = TMDB.computeSeasonsAndTotal(v);
      assert.strictEqual(r.total, null, 'seasons=' + JSON.stringify(v));
      assert.deepStrictEqual(r.seasons, {});
      assert.strictEqual(r.seasonCount, 0);
    });
  });

  await runTest('computeSeasonsAndTotal: episode_count fehlt/negativ/nicht-ganzzahlig normalisiert auf 0', function() {
    const r = TMDB.computeSeasonsAndTotal([
      { season_number: 1, episode_count: undefined },
      { season_number: 2, episode_count: -5 },
      { season_number: 3, episode_count: 4.5 },
      { season_number: 4, episode_count: 'zwölf' },
    ]);
    // Alle vier Staffeln normalisieren auf 0 Episoden ⇒ Summe 0 ⇒ Leerfall.
    assert.strictEqual(r.total, null);
    assert.deepStrictEqual(r.seasons, {});
    // seasonCount zählt trotzdem die realen Staffeln (Strukturwissen bleibt erhalten).
    assert.strictEqual(r.seasonCount, 4);
  });

  await runTest('computeSeasonsAndTotal: eine kaputte Staffel neben validen Staffeln verliert nur ihre eigenen Bänder', function() {
    const r = TMDB.computeSeasonsAndTotal([
      { season_number: 1, episode_count: 5 },
      { season_number: 2, episode_count: -1 }, // normalisiert auf 0 → trägt keine Bänder bei
      { season_number: 3, episode_count: 3 },
    ]);
    assert.strictEqual(r.total, 8);
    assert.strictEqual(Object.keys(r.seasons).length, 8);
    assert.strictEqual(r.seasons['5'], 1);
    assert.strictEqual(r.seasons['6'], 3, 'nach der leeren Staffel 2 geht die Zählung fortlaufend mit Staffel 3 weiter');
    assert.strictEqual(r.seasonCount, 3);
  });

  await runTest('computeSeasonsAndTotal: unsortierte Staffeleingabe wird nach season_number aufsteigend verarbeitet', function() {
    const r = TMDB.computeSeasonsAndTotal([
      { season_number: 2, episode_count: 3 },
      { season_number: 1, episode_count: 2 },
    ]);
    assert.strictEqual(r.seasons['1'], 1);
    assert.strictEqual(r.seasons['2'], 1);
    assert.strictEqual(r.seasons['3'], 2);
    assert.strictEqual(r.seasons['4'], 2);
    assert.strictEqual(r.seasons['5'], 2);
  });

  await runTest('computeSeasonsAndTotal: Kappung bei MAX_EPISODES — seasons gekappt, total bleibt der volle Summenwert', function() {
    const r = TMDB.computeSeasonsAndTotal([{ season_number: 1, episode_count: 2500 }]);
    assert.strictEqual(r.total, 2500, 'total spiegelt die echte Episodenzahl, unabhängig von der Kappung');
    assert.strictEqual(Object.keys(r.seasons).length, TMDB.MAX_EPISODES,
      'seasons wird auf MAX_EPISODES gekappt, sonst friert die Bandverwaltung ein');
    assert.ok(TMDB.MAX_EPISODES <= 2000);
  });

  // ─── 2) pickNetwork ──────────────────────────────────────────────────────

  await runTest('pickNetwork: erster Netzwerkname, leer/fehlend → ""', function() {
    assert.strictEqual(TMDB.pickNetwork({ networks: [{ name: 'HBO' }, { name: 'Sky' }] }), 'HBO');
    assert.strictEqual(TMDB.pickNetwork({ networks: [] }), '');
    assert.strictEqual(TMDB.pickNetwork({ networks: null }), '');
    assert.strictEqual(TMDB.pickNetwork({}), '');
    assert.strictEqual(TMDB.pickNetwork({ networks: [{ name: '  ' }, { name: 'Netflix' }] }), 'Netflix');
  });

  // ─── 3) normalizeGenres ──────────────────────────────────────────────────

  await runTest('normalizeGenres: Nicht-Strings/leer raus, dedupliziert, gekappt bei MAX_GENRES', function() {
    assert.deepStrictEqual(
      TMDB.normalizeGenres(['Drama', 'Drama', '', '  ', null, 42, { x: 1 }, 'Fantasy']),
      ['Drama', 'Fantasy']);
    const many = TMDB.normalizeGenres(Array.from({ length: 50 }, (_, i) => 'G' + i));
    assert.strictEqual(many.length, TMDB.MAX_GENRES);
    assert.deepStrictEqual(TMDB.normalizeGenres('Drama'), []);
    assert.deepStrictEqual(TMDB.normalizeGenres(undefined), []);
  });

  // ─── 4) safeCoverUrl ─────────────────────────────────────────────────────

  await runTest('safeCoverUrl: poster_path null/http:/javascript: → "", relativer Pfad → https-URL', function() {
    assert.strictEqual(TMDB.safeCoverUrl(null), '');
    assert.strictEqual(TMDB.safeCoverUrl(undefined), '');
    assert.strictEqual(TMDB.safeCoverUrl(''), '');
    assert.strictEqual(TMDB.safeCoverUrl('http://evil.com/x.jpg'), '');
    assert.strictEqual(TMDB.safeCoverUrl('javascript:alert(1)'), '');
    assert.strictEqual(TMDB.safeCoverUrl('https://evil.com/x.jpg'), '', 'keine absoluten Fremd-URLs, nur TMDB-relative poster_path');
    assert.strictEqual(TMDB.safeCoverUrl('/gwPSoYUHAKmdyVywgLpKKA5dl2S.jpg'),
      'https://image.tmdb.org/t/p/w500/gwPSoYUHAKmdyVywgLpKKA5dl2S.jpg');
  });

  // ─── 5) ongoing-Ableitung ────────────────────────────────────────────────

  await runTest('ongoing: Returning Series → "true"', function() {
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ status: 'Returning Series' })).ongoing, 'true');
  });
  await runTest('ongoing: Ended → "false"', function() {
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ status: 'Ended' })).ongoing, 'false');
  });
  await runTest('ongoing: Canceled → "false"', function() {
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ status: 'Canceled' })).ongoing, 'false');
  });
  await runTest('ongoing: unbekannter/fehlender Status (Planned, In Production, Pilot, undefined) → null (nicht geraten)', function() {
    ['Planned', 'In Production', 'Pilot', 'WAT', undefined].forEach(function(status) {
      assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ status })).ongoing, null, 'status=' + status);
    });
  });

  // ─── 6) mapSeriesToRecord: Allowlist + Happy Path ───────────────────────

  await runTest('mapSeriesToRecord: vollständige Fixture wird korrekt gemappt (exakte Allowlist-Keys)', function() {
    const record = TMDB.mapSeriesToRecord(fullTmdb());
    assert.deepStrictEqual(Object.keys(record).sort(), [
      'cover', 'genres', 'network', 'ongoing', 'overview', 'seasonCount', 'seasons', 'title', 'total', 'tmdbId',
    ].sort());
    assert.strictEqual(record.tmdbId, 1399);
    assert.strictEqual(record.title, 'Game of Thrones');
    assert.strictEqual(record.network, 'HBO');
    assert.strictEqual(record.total, 73);
    assert.strictEqual(record.seasonCount, 8);
    assert.strictEqual(record.ongoing, 'false');
    assert.strictEqual(record.cover, 'https://image.tmdb.org/t/p/w500/gwPSoYUHAKmdyVywgLpKKA5dl2S.jpg');
    assert.deepStrictEqual(record.genres, ['Sci-Fi & Fantasy', 'Drama']);
    assert.ok(record.overview.length > 0);
  });

  await runTest('mapSeriesToRecord: kein/leerer Titel → null (Record verworfen)', function() {
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ name: '' })), null);
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ name: '   ' })), null);
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ name: null })), null);
    assert.strictEqual(TMDB.mapSeriesToRecord(null), null);
    assert.strictEqual(TMDB.mapSeriesToRecord('kein objekt'), null);
  });

  await runTest('mapSeriesToRecord: fehlende/ungültige tmdbId → null', function() {
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ id: undefined })), null);
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ id: 0 })), null);
    assert.strictEqual(TMDB.mapSeriesToRecord(fullTmdb({ id: 'abc' })), null);
  });

  await runTest('mapSeriesToRecord ist eine Allowlist: kein api_key, kein Roh-Blob, keine Zusatzfelder landen im Record', function() {
    const tmdb = fullTmdb({
      api_key: 'geheim-darf-nie-rein',
      homepage: 'https://www.hbo.com/game-of-thrones',
      production_companies: [{ name: 'HBO' }],
      vote_average: 8.4,
      __proto__value: 'x',
    });
    const record = TMDB.mapSeriesToRecord(tmdb);
    ['api_key', 'homepage', 'production_companies', 'vote_average', '__proto__value'].forEach(function(k) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(record, k), false, 'Feld geleakt: ' + k);
    });
    assert.strictEqual(JSON.stringify(record).includes('geheim-darf-nie-rein'), false);
    assert.strictEqual(Object.getPrototypeOf(record), Object.prototype);
  });

  await runTest('mapSeriesToRecord: Serie ohne bekannte Episodenzahl (leere seasons) bleibt konsistent', function() {
    const record = TMDB.mapSeriesToRecord(fullTmdb({ seasons: [{ season_number: 0, episode_count: 3 }] }));
    assert.strictEqual(record.total, null);
    assert.deepStrictEqual(record.seasons, {});
    assert.strictEqual(record.seasonCount, 0);
  });

  // ─── 7) classifyError ────────────────────────────────────────────────────

  await runTest('classifyError: Timeout (AbortError) → "timeout"', function() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.strictEqual(TMDB.classifyError(err), 'timeout');
    const t = new Error('timed out');
    t.name = 'TimeoutError';
    assert.strictEqual(TMDB.classifyError(t), 'timeout');
  });

  await runTest('classifyError: Netzwerkabbruch (TypeError) → "network"', function() {
    assert.strictEqual(TMDB.classifyError(new TypeError('fetch failed')), 'network');
  });

  await runTest('classifyError: HTTP 429 → "rate-limited"', function() {
    assert.strictEqual(TMDB.classifyError(null, 429, {}), 'rate-limited');
  });

  await runTest('classifyError: HTTP >= 400 → "http"', function() {
    assert.strictEqual(TMDB.classifyError(null, 401, {}), 'http');
    assert.strictEqual(TMDB.classifyError(null, 404, {}), 'http');
    assert.strictEqual(TMDB.classifyError(null, 500, null), 'http');
  });

  await runTest('classifyError: HTTP 200 mit success:false → "http" (Status allein ist kein Erfolgssignal)', function() {
    assert.strictEqual(TMDB.classifyError(null, 200, { success: false, status_code: 34, status_message: 'not found' }), 'http');
  });

  await runTest('classifyError: kaputtes JSON / kein Objekt → "malformed"', function() {
    assert.strictEqual(TMDB.classifyError(null, 200, null), 'malformed');
    assert.strictEqual(TMDB.classifyError(null, 200, 'kein json'), 'malformed');
    assert.strictEqual(TMDB.classifyError(null, 200, undefined), 'malformed');
  });

  await runTest('classifyError: leere Antwort (Objekt ohne verwertbaren Namen) → "empty"', function() {
    assert.strictEqual(TMDB.classifyError(null, 200, {}), 'empty');
    assert.strictEqual(TMDB.classifyError(null, 200, { name: '' }), 'empty');
    assert.strictEqual(TMDB.classifyError(null, 200, { name: '   ' }), 'empty');
  });

  await runTest('classifyError: valide Antwort → null (kein Fehler)', function() {
    assert.strictEqual(TMDB.classifyError(null, 200, fullTmdb()), null);
  });

  // ─── 8) fetchSeries (injizierter Fetch, kein echtes Netz) ───────────────

  await runTest('fetchSeries: erfolgreicher Lauf liefert einen gemappten Record, Key landet nie in der Rückgabe', async function() {
    let capturedUrl = null;
    const fetchImpl = async (url) => { capturedUrl = url; return jsonResponse(200, fullTmdb()); };
    const res = await TMDB.fetchSeries(1399, { fetchImpl, apiKey: 'deadbeef00000000000000000000000' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.record.tmdbId, 1399);
    assert.ok(capturedUrl.includes('api_key=deadbeef00000000000000000000000'), 'Key muss als Query-Param gesendet werden');
    assert.strictEqual(JSON.stringify(res).includes('deadbeef00000000000000000000000'), false, 'Key darf nie in der Rückgabe landen');
  });

  await runTest('fetchSeries: HTTP 429 → { ok:false, reason:"rate-limited" }', async function() {
    const fetchImpl = async () => jsonResponse(429, {});
    const res = await TMDB.fetchSeries(1, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'rate-limited');
    assert.strictEqual(res.record, null);
  });

  await runTest('fetchSeries: HTTP 404 (unbekannte ID) → { ok:false, reason:"http" }, Gesamtlauf wird nicht beeinflusst', async function() {
    const fetchImpl = async () => jsonResponse(404, { success: false, status_code: 34 });
    const res = await TMDB.fetchSeries(999999999, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'http');
  });

  await runTest('fetchSeries: Netzwerkfehler (fetchImpl wirft) → { ok:false, reason:"network" }', async function() {
    const fetchImpl = async () => { throw new TypeError('fetch failed'); };
    const res = await TMDB.fetchSeries(1, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'network');
  });

  await runTest('fetchSeries: Timeout (AbortError) → { ok:false, reason:"timeout" }', async function() {
    const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const res = await TMDB.fetchSeries(1, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'timeout');
  });

  await runTest('fetchSeries: kaputtes JSON → { ok:false, reason:"malformed" }', async function() {
    const fetchImpl = async () => ({ status: 200, async json() { throw new SyntaxError('unexpected token'); } });
    const res = await TMDB.fetchSeries(1, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'malformed');
  });

  await runTest('fetchSeries: leere/unverwertbare Antwort → { ok:false, reason:"empty" }', async function() {
    const fetchImpl = async () => jsonResponse(200, { id: 1 });
    const res = await TMDB.fetchSeries(1, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'empty');
  });

  await runTest('fetchSeries: ohne fetchImpl wirft sofort (Programmierfehler, kein stiller Live-Fallback)', async function() {
    await assert.rejects(() => TMDB.fetchSeries(1, { apiKey: 'x' }), /fetchImpl/);
  });

  // ─── Ergebnis ────────────────────────────────────────────────────────────

  console.log('');
  console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
  if (_failed > 0) process.exit(1);
})();
