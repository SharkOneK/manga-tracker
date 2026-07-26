#!/usr/bin/env node
'use strict';

/**
 * test-public-projection.js — Phase 27b
 *
 * Prueft die gehaertete Public-Projection-Nutzung:
 *   - public_data enthält keine privaten Felder
 *   - Cloud-Push sendet data + public_data
 *   - Public-View liest ausschliesslich die Public Projection, nie private data
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const appJsPath = path.join(repoRoot, 'src', 'app.js');
const supabaseJsPath = path.join(repoRoot, 'src', 'supabase.js');

let _passed = 0;
let _failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.stack);
    _failed++;
  }
}

function loadPublicProjectionHelpers() {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const start = appJs.indexOf('function safeHttpsUrl');
  const end = appJs.indexOf('// Erhält beim Speichern Felder', start);
  if (start === -1 || end === -1) {
    throw new Error('Konnte safeHttpsUrl/buildPublicCollectionData-Block in src/app.js nicht finden');
  }
  const sandbox = {
    URL,
    Object,
  };
  vm.runInNewContext(appJs.slice(start, end) + '\nthis.buildPublicCollectionData = buildPublicCollectionData;', sandbox);
  return sandbox.buildPublicCollectionData;
}

const SESSION_KEY = 'sb-sssxiqtnkctvyghyrqff-auth-token';
function freshSession(accessToken) {
  return JSON.stringify({
    access_token: accessToken || 'jwt1',
    refresh_token: 'r1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

function loadSupabaseAdapter(mockFetch, seed) {
  const supabaseJs = fs.readFileSync(supabaseJsPath, 'utf8');
  const storage = new Map();
  if (seed) Object.keys(seed).forEach((k) => storage.set(k, String(seed[k])));
  const sandbox = {
    console,
    fetch: mockFetch,
    URLSearchParams,
    Date,
    history: { replaceState() {} },
    window: {},
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
  };
  sandbox.window.location = { hash: '', search: '', pathname: '/' };
  vm.runInNewContext(supabaseJs, sandbox);
  return sandbox.window.MangaTrackerSupabase;
}

function mockResponse(ok, status, body) {
  return {
    ok,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function makeFetchSequence(responses, calls) {
  return async function fetch(url, options) {
    calls.push({
      url: String(url),
      options: options || {},
      body: options && options.body ? JSON.parse(options.body) : null,
    });
    if (responses.length === 0) throw new Error('Unerwarteter fetch-Aufruf: ' + url);
    return responses.shift();
  };
}

console.log('\nPhase 27b - Public Projection/RLS Tests\n');

(async function main() {
  await runTest('buildPublicCollectionData entfernt private Felder und unsichere URLs', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = {
      schemaVersion: 3,
      m: [{
        id: 'm1',
        title: 'Test Manga',
        pub: 'Test Verlag',
        bands: { 1: 'completed' },
        total: 2,
        ongoing: 'true',
        nextDate: '2026-06-01',
        cover: 'http://example.com/private-cover.jpg',
        bandCovers: {
          1: 'https://example.com/cover-1.jpg',
          2: 'javascript:alert(1)',
        },
        genres: ['Drama'],
        status: 'reading',
        mediaType: 'series',
        seasons: { 1: 2, 2: null, 3: 0 },
        notes: 'privat',
        isbn13: '9780000000000',
        startedAt: '2026-01-01',
        finishedAt: '2026-02-01',
        mpEditionId: 'private-edition',
      }],
    };

    const projection = buildPublicCollectionData(input);
    assert.deepStrictEqual(Object.keys(projection.m[0]).sort(), [
      'bandCovers', 'bands', 'cover', 'genres', 'id', 'mediaType', 'nextDate',
      'ongoing', 'pub', 'seasons', 'status', 'title', 'total',
    ].sort());
    assert.strictEqual(projection.schemaVersion, 3);
    assert.strictEqual(projection.m[0].cover, '');
    assert.deepStrictEqual(projection.m[0].bandCovers, { 1: 'https://example.com/cover-1.jpg' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'notes'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'isbn13'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'mpEditionId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'startedAt'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'finishedAt'), false);
    assert.strictEqual(projection.m[0].mediaType, 'series');
    // season:0 ist ein legitimer Wert (Number.isFinite statt Truthiness) — season:null (Band 2)
    // hat keinen Wert und wird herausgefiltert, endliche Zahlen (auch 0) bleiben erhalten.
    assert.deepStrictEqual(projection.m[0].seasons, { 1: 2, 3: 0 });
  });

  await runTest('buildPublicCollectionData: Eintrag ohne mediaType wird als "manga" ausgegeben', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = { schemaVersion: 3, m: [{ id: 'm2', title: 'Unmigriert', bands: {} }] };
    const projection = buildPublicCollectionData(input);
    assert.strictEqual(projection.m[0].mediaType, 'manga');
    assert.deepStrictEqual(projection.m[0].seasons, {});
  });

  await runTest('buildPublicCollectionData: ungültiger mediaType wird als "manga" ausgegeben', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = { schemaVersion: 3, m: [{ id: 'm3', title: 'Kaputt', bands: {}, mediaType: 'movie' }] };
    const projection = buildPublicCollectionData(input);
    assert.strictEqual(projection.m[0].mediaType, 'manga');
  });

  // Phase 73: Anime-Einträge tragen private AniList-Rohdaten (externalIds, anilistAiring).
  // Diese duerfen NICHT in der Projektion landen; das Key-Set oben bleibt unveraendert (E4).
  await runTest('buildPublicCollectionData: Anime-Eintrag laesst externalIds/anilistAiring draussen, mediaType+seasons kommen durch', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = {
      schemaVersion: 3,
      m: [{
        id: 'an1',
        title: 'Attack on Titan Season 2',
        pub: '',
        bands: {},
        total: 12,
        ongoing: 'true',
        nextDate: '2026-08-01',
        cover: 'https://img.anili.st/cover.jpg',
        bandCovers: {},
        genres: ['Action', 'Drama'],
        status: 'owned',
        mediaType: 'anime',
        seasons: { 1: 2, 2: 2, 3: 2 },
        externalIds: { anilistId: 25777, anilistRootId: 16498 },
        anilistAiring: { episode: 13, airingAt: 1770000000 },
      }],
    };

    const projection = buildPublicCollectionData(input);
    // Exakt dasselbe Key-Set wie fuer Manga — E4: keine neuen Felder in der Projektion.
    assert.deepStrictEqual(Object.keys(projection.m[0]).sort(), [
      'bandCovers', 'bands', 'cover', 'genres', 'id', 'mediaType', 'nextDate',
      'ongoing', 'pub', 'seasons', 'status', 'title', 'total',
    ].sort());
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'externalIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'anilistAiring'), false);
    assert.strictEqual(projection.m[0].mediaType, 'anime');
    assert.strictEqual(projection.m[0].total, 12);
    assert.strictEqual(projection.m[0].ongoing, 'true');
    assert.strictEqual(projection.m[0].nextDate, '2026-08-01');
    assert.strictEqual(projection.m[0].cover, 'https://img.anili.st/cover.jpg');
    assert.deepStrictEqual(projection.m[0].genres, ['Action', 'Drama']);
    assert.deepStrictEqual(projection.m[0].seasons, { 1: 2, 2: 2, 3: 2 });
  });

  await runTest('buildPublicCollectionData: Anime ohne bekannte Episodenzahl (total null, seasons leer) bleibt konsistent', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = {
      schemaVersion: 3,
      m: [{
        id: 'an2', title: 'Laufender Anime', bands: {}, total: null, ongoing: null,
        mediaType: 'anime', seasons: {}, cover: null,
        externalIds: { anilistId: 999, anilistRootId: 999 }, anilistAiring: null,
      }],
    };
    const projection = buildPublicCollectionData(input);
    assert.strictEqual(projection.m[0].mediaType, 'anime');
    assert.strictEqual(projection.m[0].total, null);
    assert.strictEqual(projection.m[0].ongoing, null);
    assert.deepStrictEqual(projection.m[0].seasons, {});
    assert.strictEqual(projection.m[0].cover, '');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'externalIds'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'anilistAiring'), false);
  });

  // Phase 75: TMDB-Serieneinträge tragen private Rohdaten (externalIds.tmdbId).
  // Diese duerfen NICHT in der Projektion landen; das Key-Set bleibt exakt wie
  // bei Manga/Anime (E4) — keine neuen Public-Projection-Felder.
  await runTest('buildPublicCollectionData: Serie mit externalIds.tmdbId laesst externalIds draussen, Key-Set unveraendert (E4)', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = {
      schemaVersion: 3,
      m: [{
        id: 'tv1',
        title: 'Game of Thrones',
        pub: 'HBO',
        bands: {},
        total: 73,
        ongoing: 'false',
        nextDate: null,
        cover: 'https://image.tmdb.org/t/p/w500/x.jpg',
        bandCovers: {},
        genres: ['Drama', 'Fantasy'],
        status: 'owned',
        mediaType: 'series',
        seasons: { 1: 1, 2: 1 },
        externalIds: { tmdbId: 1399 },
      }],
    };

    const projection = buildPublicCollectionData(input);
    // Exakt dasselbe Key-Set wie fuer Manga/Anime — E4: keine neuen Felder in der Projektion.
    assert.deepStrictEqual(Object.keys(projection.m[0]).sort(), [
      'bandCovers', 'bands', 'cover', 'genres', 'id', 'mediaType', 'nextDate',
      'ongoing', 'pub', 'seasons', 'status', 'title', 'total',
    ].sort());
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'externalIds'), false);
    assert.strictEqual(projection.m[0].mediaType, 'series');
    assert.strictEqual(projection.m[0].pub, 'HBO');
    assert.strictEqual(projection.m[0].total, 73);
    assert.deepStrictEqual(projection.m[0].seasons, { 1: 1, 2: 1 });
  });

  await runTest('buildPublicCollectionData: schemaVersion-Fallback ohne Input ist 3', function() {
    const buildPublicCollectionData = loadPublicProjectionHelpers();
    const input = { m: [{ id: 'm4', title: 'Ohne schemaVersion', bands: {} }] };
    const projection = buildPublicCollectionData(input);
    assert.strictEqual(projection.schemaVersion, 3);
  });

  await runTest('Cloud-Push (Session) sendet data + public_data via JWT, ohne x-owner-token', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 200, [{ id: 'col1' }]), // return=representation → 1 Zeile
    ], calls), { [SESSION_KEY]: freshSession('jwt1') });

    const data = { m: [{ id: 'private' }] };
    const publicData = { m: [{ id: 'public' }] };
    const result = await adapter.patchCollection('col1', data, publicData);

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].body, { data, public_data: publicData });
    assert.strictEqual(calls[0].options.headers['Authorization'], 'Bearer jwt1');
    assert.strictEqual(calls[0].options.headers['Prefer'], 'return=representation');
    assert.ok(!calls[0].options.headers['x-owner-token']);
    assert.strictEqual(result.publicDataWritten, true);
  });

  await runTest('Cloud-Push erneuert abgelaufene Session per refresh_token', async function() {
    const calls = [];
    const expired = JSON.stringify({
      access_token: 'old', refresh_token: 'r1',
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 200, { access_token: 'jwt2', refresh_token: 'r2', expires_in: 3600 }), // refresh
      mockResponse(true, 200, [{ id: 'col1' }]), // patch
    ], calls), { [SESSION_KEY]: expired });

    const data = { m: [] };
    const result = await adapter.patchCollection('col1', data, { m: [] });

    assert.strictEqual(calls.length, 2);
    assert.ok(calls[0].url.includes('grant_type=refresh_token'));
    assert.deepStrictEqual(calls[0].body, { refresh_token: 'r1' });
    assert.strictEqual(calls[1].options.headers['Authorization'], 'Bearer jwt2');
    assert.strictEqual(result.publicDataWritten, true);
  });

  await runTest('Cloud-Push wirft ohne Session (kein Token-Fallback)', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([], calls)); // keine Session geseedet
    await assert.rejects(() => adapter.patchCollection('col1', { m: [] }, { m: [] }), /Nicht angemeldet/);
    assert.strictEqual(calls.length, 0);
  });

  await runTest('Owner-Pull nutzt get_owner_collection_for_user via JWT', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 200, { m: [{ id: 'private' }] }),
    ], calls), { [SESSION_KEY]: freshSession('jwt1') });

    const result = await adapter.fetchCollection('col1');
    assert.deepStrictEqual(result, { m: [{ id: 'private' }] });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/rpc/get_owner_collection_for_user'));
    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers['Authorization'], 'Bearer jwt1');
    assert.ok(!calls[0].options.headers['x-owner-token']);
    assert.deepStrictEqual(calls[0].body, { collection_id: 'col1' });
  });

  await runTest('Public-View liest ausschliesslich public projection', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 200, [{ public_data: { m: [{ id: 'public' }] } }]),
    ], calls));

    const result = await adapter.fetchPublicCollection('col1');
    assert.deepStrictEqual(result, { m: [{ id: 'public' }] });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/collection_public_projection'));
    assert.ok(calls[0].url.includes('select=public_data'));
    assert.ok(!calls[0].url.includes('select=data'));
  });

  await runTest('Public-View hat keinen Legacy-Fallback auf private data', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(false, 403, 'permission denied for view collection_public_projection'),
    ], calls));

    await assert.rejects(() => adapter.fetchPublicCollection('col1'), /HTTP 403/);
    assert.strictEqual(calls.length, 1);
    assert.ok(!calls.some(call => call.url.includes('select=data')));
  });
  await runTest('src/app.js verdrahtet Cloud-Push und Public-View mit public_data-Pfad', function() {
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes('SupabaseAdapter.patchCollection(_collId, db, buildPublicCollectionData(db))'));
    assert.ok(appJs.includes('SupabaseAdapter.fetchPublicCollection(_viewColl)'));
    const supabaseJs = fs.readFileSync(supabaseJsPath, 'utf8');
    assert.ok(supabaseJs.includes('collection_public_projection'));
    assert.ok(!/fetchPublicCollection[\s\S]*select=data/.test(supabaseJs));
  });

  console.log('');
  console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
  if (_failed > 0) process.exit(1);
})();
