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

function loadSupabaseAdapter(mockFetch) {
  const supabaseJs = fs.readFileSync(supabaseJsPath, 'utf8');
  const storage = new Map();
  const sandbox = {
    console,
    fetch: mockFetch,
    URLSearchParams,
    history: { replaceState() {} },
    window: {},
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
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
        notes: 'privat',
        isbn13: '9780000000000',
        startedAt: '2026-01-01',
        finishedAt: '2026-02-01',
        mpEditionId: 'private-edition',
      }],
    };

    const projection = buildPublicCollectionData(input);
    assert.deepStrictEqual(Object.keys(projection.m[0]).sort(), [
      'bandCovers', 'bands', 'cover', 'genres', 'id', 'nextDate',
      'ongoing', 'pub', 'status', 'title', 'total',
    ].sort());
    assert.strictEqual(projection.schemaVersion, 3);
    assert.strictEqual(projection.m[0].cover, '');
    assert.deepStrictEqual(projection.m[0].bandCovers, { 1: 'https://example.com/cover-1.jpg' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'notes'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'isbn13'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.m[0], 'mpEditionId'), false);
  });

  await runTest('Cloud-Push sendet data und public_data, wenn public_data akzeptiert wird', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 204, ''),
    ], calls));

    const data = { m: [{ id: 'private' }] };
    const publicData = { m: [{ id: 'public' }] };
    const result = await adapter.patchCollection('col1', 'tok1', data, publicData);

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].body, { data, public_data: publicData });
    assert.strictEqual(calls[0].options.headers['x-owner-token'], 'tok1');
    assert.strictEqual(result.publicDataWritten, true);
  });

  await runTest('Cloud-Push fällt auf data-only zurück, wenn public_data remote fehlt', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(false, 400, "Could not find the 'public_data' column in the schema cache"),
      mockResponse(true, 204, ''),
    ], calls));

    const data = { m: [{ id: 'private' }] };
    const publicData = { m: [{ id: 'public' }] };
    const result = await adapter.patchCollection('col1', 'tok1', data, publicData);

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].body, { data, public_data: publicData });
    assert.deepStrictEqual(calls[1].body, { data });
    assert.strictEqual(result.publicDataWritten, false);
  });

  await runTest('Owner-Pull nutzt owner RPC mit x-owner-token', async function() {
    const calls = [];
    const adapter = loadSupabaseAdapter(makeFetchSequence([
      mockResponse(true, 200, { m: [{ id: 'private' }] }),
    ], calls));

    const result = await adapter.fetchCollection('col1', 'tok1');
    assert.deepStrictEqual(result, { m: [{ id: 'private' }] });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/rpc/get_owner_collection'));
    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers['x-owner-token'], 'tok1');
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
    assert.ok(appJs.includes('SupabaseAdapter.patchCollection(_collId, _ownerToken, db, buildPublicCollectionData(db))'));
    assert.ok(appJs.includes('SupabaseAdapter.fetchPublicCollection(_viewColl)'));
    const supabaseJs = fs.readFileSync(supabaseJsPath, 'utf8');
    assert.ok(supabaseJs.includes('collection_public_projection'));
    assert.ok(!/fetchPublicCollection[\s\S]*select=data/.test(supabaseJs));
  });

  console.log('');
  console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
  if (_failed > 0) process.exit(1);
})();
