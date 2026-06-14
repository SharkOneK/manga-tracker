#!/usr/bin/env node
'use strict';

/**
 * test-isbn13-lookup.js — Backlog 3.1
 *
 * Gemockte Unit-Tests für scripts/lookup-isbn13.js. Framework-frei (Node-assert,
 * Stil wie scripts/test-publisher-providers.js). KEINE echten Netz-Calls:
 * fetchJson wird über context injiziert und liefert lokale Fixtures aus
 * tests/fixtures/isbn-lookup/.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  expandWatchlistItems,
  selectIsbnFromResponse,
  lookupOne,
  runLookup,
  mergeWithExistingCache,
} = require('./lookup-isbn13');

const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'isbn-lookup');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

// Fake-fetchJson: liefert je nach Fall die passende Fixture; macht kein Netzwerk.
function fakeFetchJson(fixtureName) {
  return async () => fixture(fixtureName);
}

function testExpandWatchlistItems() {
  const watchlist = {
    items: [
      { seriesTitle: 'A', publisher: 'P1', volumeNumber: 1, enabled: true },
      { seriesTitle: 'B', publisher: 'P2', volumeNumbers: [3, 4], enabled: true },
      { seriesTitle: 'C', publisher: 'P3', volumeNumber: 9, enabled: false },
      { seriesTitle: 'A', publisher: 'P1', volumeNumber: 1, enabled: true },
    ],
  };
  const expanded = expandWatchlistItems(watchlist);
  // A#1 (dedupliziert), B#3, B#4 = 3 Items; C ist enabled:false -> ignoriert.
  assert.strictEqual(expanded.length, 3, 'volumeNumbers aufgefächert, enabled:false gefiltert, Duplikate entfernt');
  assert.deepStrictEqual(expanded.map(i => i.volumeNumber).sort(), [1, 3, 4]);
  assert.ok(!expanded.some(i => i.seriesTitle === 'C'), 'enabled:false darf nicht vorkommen');
}

function testSelectHigh() {
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-eindeutig.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'high');
  assert.strictEqual(result.isbn13, '9783551796160');
  assert.strictEqual(result.candidateCount, 1);
}

function testSelectUnsure() {
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-mehrdeutig.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'unsure');
  assert.strictEqual(result.isbn13, null, 'unsure darf keine ISBN schreiben');
  assert.ok(result.candidateCount > 1);
}

function testSelectNoneEmpty() {
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-leer.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'none');
  assert.strictEqual(result.isbn13, null);
  assert.strictEqual(result.candidateCount, 0);
}

function testSelectNoneInvalidIsbn() {
  // Nur ISBN-10/fehlerhafte Werte -> durch normalizeIsbn13 verworfen -> none.
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-ungueltige-isbn.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'none');
  assert.strictEqual(result.isbn13, null, 'Nicht-978/979-ISBN darf nicht geschrieben werden');
}

function testSelectNoneMissingPublisher() {
  // Fehlender Verlag in der Query darf einen sonst eindeutigen Treffer nicht
  // verhindern (Verlag ist nur ein Zusatzsignal, kein Pflichtkriterium).
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: null, volumeNumber: 16 },
    fixture('openlibrary-eindeutig.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'high');
  assert.strictEqual(result.isbn13, '9783551796160');
}

function testSelectUnsureOneDocMultipleIsbn() {
  // B1: EIN titel-passender doc mit MEHREREN distinkten gültigen ISBN-13.
  // Open Library bündelt Editionen unter einem Work -> willkürlicher Treffer
  // wäre falsch. Erwartet: unsure, isbn13 null.
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-doc-mehrere-isbn.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'unsure', 'mehrere distinkte ISBN-13 im selben doc -> unsure');
  assert.strictEqual(result.isbn13, null, 'unsure darf keine ISBN schreiben');
  assert.strictEqual(result.candidateCount, 2, 'candidateCount zählt distinkte ISBN-13');
}

function testSelectHighDuplicateIsbn() {
  // B1: ein doc mit mehreren ISBN-Einträgen, die aber alle dieselbe distinkte
  // ISBN-13 sind (Dubletten + Bindestrich-Variante) -> bleibt high.
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-doc-isbn-dubletten.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'high', 'eine distinkte ISBN trotz Dubletten -> high');
  assert.strictEqual(result.isbn13, '9783551796160');
  assert.strictEqual(result.candidateCount, 1);
}

function testSelectUnsureNarrowableWithoutPublisher() {
  // B2: widersprüchliche Kandidaten (zwei distinkte ISBN, beide german) OHNE
  // expectedPublisher -> NICHT verengen -> unsure.
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: null, volumeNumber: 16 },
    fixture('openlibrary-verengbar-verlag.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'unsure', 'ohne expectedPublisher keine Verengung');
  assert.strictEqual(result.isbn13, null);
  assert.strictEqual(result.candidateCount, 2);
}

function testSelectHighNarrowedWithPublisher() {
  // B2: gleiche Antwort, aber mit passendem expectedPublisher, der eindeutig
  // auf genau eine distinkte ISBN verengt -> high.
  const result = selectIsbnFromResponse(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    fixture('openlibrary-verengbar-verlag.json'),
    {}
  );
  assert.strictEqual(result.confidence, 'high', 'passender Verlag verengt auf eine ISBN -> high');
  assert.strictEqual(result.isbn13, '9783551796160');
}

async function testLookupOneHigh() {
  const item = await lookupOne(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    { fetchJson: fakeFetchJson('openlibrary-eindeutig.json'), checkedAt: '2026-06-14T00:00:00.000Z' }
  );
  assert.strictEqual(item.confidence, 'high');
  assert.strictEqual(item.isbn13, '9783551796160');
  assert.strictEqual(item.source, 'openlibrary');
  assert.strictEqual(item.seriesTitle, 'Fairy Tail 16');
  assert.strictEqual(item.volumeNumber, 16);
  assert.strictEqual(item.checkedAt, '2026-06-14T00:00:00.000Z');
}

async function testLookupOneNetworkError() {
  const item = await lookupOne(
    { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
    {
      fetchJson: async () => { throw new Error('ETIMEDOUT'); },
      checkedAt: '2026-06-14T00:00:00.000Z',
    }
  );
  assert.strictEqual(item.confidence, 'none', 'Netzfehler -> none, kein Crash');
  assert.strictEqual(item.isbn13, null);
  assert.ok(/ETIMEDOUT/.test(item.evidence), 'Fehlertext landet in evidence');
}

async function testRunLookupSchema() {
  // Gemischte Items über eine URL-abhängige Fake-Antwort.
  const fakeJson = async (url) => {
    if (/title=Fairy/.test(url)) return fixture('openlibrary-eindeutig.json');
    return fixture('openlibrary-leer.json');
  };
  const cache = await runLookup({
    items: [
      { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
      { seriesTitle: 'Unbekannt', publisher: 'X', volumeNumber: 1 },
    ],
    context: { fetchJson: fakeJson, generatedAt: '2026-06-14T00:00:00.000Z' },
  });
  assert.strictEqual(cache.schemaVersion, 1);
  assert.strictEqual(cache.source, 'lookup-isbn13.js');
  assert.strictEqual(cache.itemCount, 2);
  assert.strictEqual(cache.items.length, 2);
  assert.strictEqual(cache.items[0].confidence, 'high');
  assert.strictEqual(cache.items[1].confidence, 'none');
}

async function testRunLookupLimit() {
  const cache = await runLookup({
    items: [
      { seriesTitle: 'Fairy Tail 16', publisher: 'Carlsen Manga', volumeNumber: 16 },
      { seriesTitle: 'Fairy Tail 17', publisher: 'Carlsen Manga', volumeNumber: 17 },
    ],
    context: { fetchJson: fakeFetchJson('openlibrary-leer.json') },
    limit: 1,
  });
  assert.strictEqual(cache.itemCount, 1, '--limit begrenzt die abgefragten Bände');
}

function testMergeKeepsHighOnLaterNone() {
  const existing = {
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: '9783551796160',
        confidence: 'high',
        evidence: 'Genau ein plausibler Treffer.',
      },
    ],
  };
  const fresh = {
    schemaVersion: 1,
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: null,
        confidence: 'none',
        evidence: 'Open Library lieferte keine Treffer.',
        checkedAt: '2026-06-14T00:00:00.000Z',
      },
    ],
  };
  const merged = mergeWithExistingCache(fresh, existing);
  assert.strictEqual(merged.items[0].confidence, 'high', 'bestehende high-ISBN bleibt erhalten');
  assert.strictEqual(merged.items[0].isbn13, '9783551796160');
  assert.strictEqual(merged.items[0].checkedAt, '2026-06-14T00:00:00.000Z', 'checkedAt wird aktualisiert');
}

function testMergeReplacesHighOnNewHigh() {
  const existing = {
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: '9783551796160',
        confidence: 'high',
        evidence: 'alt',
      },
    ],
  };
  const fresh = {
    schemaVersion: 1,
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: '9783551796177',
        confidence: 'high',
        evidence: 'neu',
        checkedAt: '2026-06-14T00:00:00.000Z',
      },
    ],
  };
  const merged = mergeWithExistingCache(fresh, existing);
  assert.strictEqual(merged.items[0].isbn13, '9783551796177', 'neuer high-Treffer ersetzt alten');
  assert.strictEqual(merged.items[0].evidence, 'neu');
}

function testMergeKeepsHighMissingInFreshRun() {
  // B3: ein bestehendes high-Band fehlt im neuen Lauf (z. B. --limit oder
  // enabled:false). Die sichere ISBN muss als Union erhalten bleiben.
  const existing = {
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: '9783551796160',
        confidence: 'high',
        evidence: 'früher gefunden',
      },
      {
        seriesTitle: 'Naruto 1',
        publisher: 'Carlsen Manga',
        volumeNumber: 1,
        isbn13: '9783898858144',
        confidence: 'high',
        evidence: 'früher gefunden',
      },
    ],
  };
  const fresh = {
    schemaVersion: 1,
    items: [
      {
        seriesTitle: 'Fairy Tail 16',
        publisher: 'Carlsen Manga',
        volumeNumber: 16,
        isbn13: '9783551796160',
        confidence: 'high',
        evidence: 'neu',
        checkedAt: '2026-06-14T00:00:00.000Z',
      },
    ],
  };
  const merged = mergeWithExistingCache(fresh, existing);
  assert.strictEqual(merged.itemCount, 2, 'fehlendes high-Band wird angehängt (Union)');
  const naruto = merged.items.find(i => i.seriesTitle === 'Naruto 1');
  assert.ok(naruto, 'nicht abgefragtes high-Band bleibt erhalten');
  assert.strictEqual(naruto.confidence, 'high');
  assert.strictEqual(naruto.isbn13, '9783898858144');
}

async function main() {
  testExpandWatchlistItems();
  testSelectHigh();
  testSelectUnsure();
  testSelectUnsureOneDocMultipleIsbn();
  testSelectHighDuplicateIsbn();
  testSelectUnsureNarrowableWithoutPublisher();
  testSelectHighNarrowedWithPublisher();
  testSelectNoneEmpty();
  testSelectNoneInvalidIsbn();
  testSelectNoneMissingPublisher();
  await testLookupOneHigh();
  await testLookupOneNetworkError();
  await testRunLookupSchema();
  await testRunLookupLimit();
  testMergeKeepsHighOnLaterNone();
  testMergeReplacesHighOnNewHigh();
  testMergeKeepsHighMissingInFreshRun();
  console.log('test-isbn13-lookup: ok');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
