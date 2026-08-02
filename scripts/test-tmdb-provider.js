#!/usr/bin/env node
// scripts/test-tmdb-provider.js — Phase 75: TMDB-Provider-Tests (offline)
//
// Testet primär scripts/tmdb-provider.js (Node, pure Funktionen + der
// Fetch-Glue mit injiziertem fetchImpl). Es findet KEIN Netzzugriff statt —
// CI darf niemals von TMDB abhängen. Seit Phase 77 zusätzlich ein kleiner
// Abschnitt, der validateTmdbSeriesCatalog() direkt importiert, um die
// streamingProviders-Feldvalidierung (positiv + negativ) gezielt zu prüfen —
// die "Validate TMDB series catalog"-Step in run-all-checks.js deckt nur den
// echten (validen) Katalog ab, keine Negativfälle.
'use strict';

const assert = require('assert');
const TMDB = require('./tmdb-provider.js');
const { validateTmdbSeriesCatalog } = require('./validate-tmdb-series-catalog.js');

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
      'cover', 'genres', 'network', 'ongoing', 'overview', 'seasonCount', 'seasons', 'streamingProviders', 'title', 'total', 'tmdbId',
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

  // ─── 6b) pickStreamingProviders (Phase 77) ──────────────────────────────

  function watchProviders(flatrate) {
    return { results: { DE: { flatrate } } };
  }

  await runTest('pickStreamingProviders: DE-flatrate-Namen werden extrahiert und getrimmt', function() {
    const tmdb = { 'watch/providers': watchProviders([
      { provider_id: 8, provider_name: '  Netflix  ' },
      { provider_id: 337, provider_name: 'Disney Plus' },
    ]) };
    assert.deepStrictEqual(TMDB.pickStreamingProviders(tmdb), ['Netflix', 'Disney Plus']);
  });

  await runTest('pickStreamingProviders: dedupliziert gleiche Anbieter (auch nach Trim)', function() {
    const tmdb = { 'watch/providers': watchProviders([
      { provider_name: 'Netflix' },
      { provider_name: 'Netflix' },
      { provider_name: '  Netflix  ' },
      { provider_name: 'Crunchyroll' },
    ]) };
    assert.deepStrictEqual(TMDB.pickStreamingProviders(tmdb), ['Netflix', 'Crunchyroll']);
  });

  await runTest('pickStreamingProviders: Kappung bei MAX_PROVIDERS', function() {
    const flatrate = Array.from({ length: 50 }, (_, i) => ({ provider_name: 'Provider' + i }));
    const out = TMDB.pickStreamingProviders({ 'watch/providers': watchProviders(flatrate) });
    assert.strictEqual(out.length, TMDB.MAX_PROVIDERS);
    assert.deepStrictEqual(out, Array.from({ length: TMDB.MAX_PROVIDERS }, (_, i) => 'Provider' + i));
  });

  await runTest('pickStreamingProviders: fehlendes watch/providers (ganz) → []', function() {
    assert.deepStrictEqual(TMDB.pickStreamingProviders({}), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': undefined }), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders(null), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders(undefined), []);
  });

  await runTest('pickStreamingProviders: fehlendes results → []', function() {
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': {} }), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': { results: undefined } }), []);
  });

  await runTest('pickStreamingProviders: fehlendes results.DE → []', function() {
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': { results: {} } }), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Hulu' }] } } } }), []);
  });

  await runTest('pickStreamingProviders: fehlendes DE.flatrate → []', function() {
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': { results: { DE: {} } } }), []);
    assert.deepStrictEqual(TMDB.pickStreamingProviders({ 'watch/providers': { results: { DE: { flatrate: undefined } } } }), []);
  });

  await runTest('pickStreamingProviders: nur rent/buy vorhanden, kein flatrate → [] (nur flatrate wird gelesen)', function() {
    const tmdb = {
      'watch/providers': {
        results: {
          DE: {
            rent: [{ provider_name: 'Apple TV' }],
            buy: [{ provider_name: 'Google Play' }],
          },
        },
      },
    };
    assert.deepStrictEqual(TMDB.pickStreamingProviders(tmdb), []);
  });

  await runTest('pickStreamingProviders: flatrate ist kein Array (Objekt/String/null) → []', function() {
    [{ x: 1 }, 'Netflix', null, 42, true].forEach(function(v) {
      assert.deepStrictEqual(
        TMDB.pickStreamingProviders({ 'watch/providers': { results: { DE: { flatrate: v } } } }),
        [], 'flatrate=' + JSON.stringify(v));
    });
  });

  await runTest('pickStreamingProviders: provider_name fehlt/leer/nicht-String/nur Whitespace wird verworfen', function() {
    const tmdb = { 'watch/providers': watchProviders([
      { provider_name: 'Netflix' },
      { provider_name: '' },
      { provider_name: '   ' },
      { provider_name: null },
      { provider_name: undefined },
      { provider_name: 42 },
      { provider_id: 9 }, // provider_name fehlt komplett
      null,
      'kein-objekt',
      { provider_name: 'Prime Video' },
    ]) };
    assert.deepStrictEqual(TMDB.pickStreamingProviders(tmdb), ['Netflix', 'Prime Video']);
  });

  await runTest('pickStreamingProviders: XSS-artiger provider_name wird unverändert als String durchgereicht (Escaping ist Renderer-Aufgabe)', function() {
    const evil = '<img src=x onerror=alert(1)>';
    const tmdb = { 'watch/providers': watchProviders([{ provider_name: evil }]) };
    assert.deepStrictEqual(TMDB.pickStreamingProviders(tmdb), [evil]);
  });

  await runTest('mapSeriesToRecord: streamingProviders ist stets präsent, auch ohne Provider-Daten ([])', function() {
    const record = TMDB.mapSeriesToRecord(fullTmdb());
    assert.deepStrictEqual(record.streamingProviders, []);
  });

  await runTest('mapSeriesToRecord: streamingProviders end-to-end aus einer vollen watch/providers-Fixture gemappt', function() {
    const tmdb = fullTmdb({ 'watch/providers': watchProviders([
      { provider_id: 8, provider_name: 'Netflix' },
      { provider_id: 1770, provider_name: 'Crunchyroll' },
    ]) });
    const record = TMDB.mapSeriesToRecord(tmdb);
    assert.deepStrictEqual(record.streamingProviders, ['Netflix', 'Crunchyroll']);
  });

  await runTest('mapSeriesToRecord: logo_path/provider_id/Roh-watch-providers-Blob landen NICHT im Record', function() {
    const tmdb = fullTmdb({ 'watch/providers': watchProviders([
      { provider_id: 8, provider_name: 'Netflix', logo_path: '/geheim.jpg' },
    ]) });
    const record = TMDB.mapSeriesToRecord(tmdb);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(record, 'watch/providers'), false, 'Roh-Blob darf nicht im Record landen');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(record, 'logo_path'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(record, 'provider_id'), false);
    assert.strictEqual(JSON.stringify(record).includes('geheim.jpg'), false, 'logo_path darf nirgends im Record auftauchen');
    assert.strictEqual(JSON.stringify(record).includes('provider_id'), false);
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

  await runTest('fetchSeries: URL enthält append_to_response=watch/providers, ohne api_key/language zu verlieren (Phase 77)', async function() {
    let capturedUrl = null;
    const fetchImpl = async (url) => { capturedUrl = url; return jsonResponse(200, fullTmdb()); };
    await TMDB.fetchSeries(1399, { fetchImpl, apiKey: 'deadbeef00000000000000000000000' });
    assert.ok(capturedUrl.includes('append_to_response=watch%2Fproviders'), 'URL muss append_to_response=watch%2Fproviders enthalten: ' + capturedUrl);
    assert.strictEqual(decodeURIComponent(capturedUrl.split('append_to_response=')[1]), 'watch/providers');
    assert.ok(capturedUrl.includes('api_key=deadbeef00000000000000000000000'), 'api_key darf durch die URL-Erweiterung nicht verloren gehen: ' + capturedUrl);
    assert.ok(capturedUrl.includes('language=de-DE'), 'language=de-DE darf durch die URL-Erweiterung nicht verloren gehen: ' + capturedUrl);
    assert.ok(capturedUrl.includes('/tv/1399'), 'Es bleibt EIN Request an /tv/{id}, kein zweiter Fetch: ' + capturedUrl);
  });

  await runTest('fetchSeries: Fixture mit DE-flatrate-Providern mappt end-to-end zu record.streamingProviders', async function() {
    const tmdbWithProviders = fullTmdb({
      'watch/providers': { results: { DE: { flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Amazon Prime Video' }] } } },
    });
    const fetchImpl = async () => jsonResponse(200, tmdbWithProviders);
    const res = await TMDB.fetchSeries(1399, { fetchImpl, apiKey: 'x' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.record.streamingProviders, ['Netflix', 'Amazon Prime Video']);
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

  // ─── 9) validate-tmdb-series-catalog.js — streamingProviders-Feldvalidierung (Phase 77) ──

  function catalogDoc(items) {
    return {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'update-tmdb-catalog.js',
      items,
    };
  }

  function validItem(overrides) {
    return Object.assign({
      tmdbId: 1399,
      title: 'Game of Thrones',
      network: 'HBO',
      total: 73,
      seasonCount: 8,
      ongoing: 'false',
      cover: '',
      genres: ['Drama'],
      overview: '',
      seasons: { 1: 1 },
      streamingProviders: [],
    }, overrides || {});
  }

  await runTest('validateTmdbSeriesCatalog: gültige streamingProviders (leer und mit Namen) werden akzeptiert', function() {
    const okEmpty = validateTmdbSeriesCatalog(catalogDoc([validItem()]));
    assert.strictEqual(okEmpty.ok, true, 'leeres streamingProviders sollte gültig sein: ' + JSON.stringify(okEmpty.errors));

    const okFilled = validateTmdbSeriesCatalog(catalogDoc([validItem({ streamingProviders: ['Netflix', 'Crunchyroll'] })]));
    assert.strictEqual(okFilled.ok, true, 'gefülltes streamingProviders sollte gültig sein: ' + JSON.stringify(okFilled.errors));
  });

  await runTest('validateTmdbSeriesCatalog: streamingProviders fehlt im Item → Fehler (Pflichtfeld, fail-closed)', function() {
    const item = validItem();
    delete item.streamingProviders;
    const result = validateTmdbSeriesCatalog(catalogDoc([item]));
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => /streamingProviders/.test(e)), 'erwarte einen streamingProviders-Fehler: ' + JSON.stringify(result.errors));
  });

  await runTest('validateTmdbSeriesCatalog: streamingProviders falscher Typ (String/Objekt/null statt Array) → Fehler', function() {
    ['Netflix', { 0: 'Netflix' }, null, 42].forEach(function(bad) {
      const result = validateTmdbSeriesCatalog(catalogDoc([validItem({ streamingProviders: bad })]));
      assert.strictEqual(result.ok, false, 'streamingProviders=' + JSON.stringify(bad) + ' sollte abgelehnt werden');
      assert.ok(result.errors.some(e => /streamingProviders/.test(e)), 'streamingProviders=' + JSON.stringify(bad) + ': ' + JSON.stringify(result.errors));
    });
  });

  await runTest('validateTmdbSeriesCatalog: streamingProviders-Element leerer/kein String → Fehler', function() {
    const result = validateTmdbSeriesCatalog(catalogDoc([validItem({ streamingProviders: ['Netflix', '', 42, null] })]));
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => /streamingProviders\[1\]/.test(e)), JSON.stringify(result.errors));
    assert.ok(result.errors.some(e => /streamingProviders\[2\]/.test(e)), JSON.stringify(result.errors));
    assert.ok(result.errors.some(e => /streamingProviders\[3\]/.test(e)), JSON.stringify(result.errors));
  });

  await runTest('validateTmdbSeriesCatalog: streamingProviders mit mehr als MAX_PROVIDERS (20) Einträgen → Fehler', function() {
    const many = Array.from({ length: 21 }, (_, i) => 'Provider' + i);
    const result = validateTmdbSeriesCatalog(catalogDoc([validItem({ streamingProviders: many })]));
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => /streamingProviders/.test(e) && /20/.test(e)), JSON.stringify(result.errors));

    const exactlyMax = Array.from({ length: 20 }, (_, i) => 'Provider' + i);
    const okAtMax = validateTmdbSeriesCatalog(catalogDoc([validItem({ streamingProviders: exactlyMax })]));
    assert.strictEqual(okAtMax.ok, true, 'genau 20 Einträge sollten noch gültig sein: ' + JSON.stringify(okAtMax.errors));
  });

  await runTest('validateTmdbSeriesCatalog: Fremdfeld (nicht allowlisteter Key) im Item → Fehler', function() {
    const item = validItem({ logoPath: '/geheim.jpg' });
    const result = validateTmdbSeriesCatalog(catalogDoc([item]));
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => /logoPath/.test(e) && /nicht allowlistet/.test(e)), JSON.stringify(result.errors));
  });

  await runTest('validateTmdbSeriesCatalog: verbotener Key api_key innerhalb eines streamingProviders-Elements wird strukturell erkannt', function() {
    const item = validItem({ streamingProviders: [{ api_key: 'geheim' }] });
    const result = validateTmdbSeriesCatalog(catalogDoc([item]));
    assert.strictEqual(result.ok, false, 'sollte fehlschlagen (Element ist kein String UND api_key ist ein verbotener Key)');
    assert.ok(result.errors.some(e => /api_key/.test(e) && /verbotener Key/.test(e)), JSON.stringify(result.errors));
  });

  // ─── Ergebnis ────────────────────────────────────────────────────────────

  console.log('');
  console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
  if (_failed > 0) process.exit(1);
})();
