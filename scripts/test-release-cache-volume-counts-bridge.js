#!/usr/bin/env node
'use strict';

/**
 * Volume-Counts-Bruecke — Unit- + Offline-Integrationstests.
 *
 * Deckt ab:
 *  - loadVolumeCountsCandidates: reine, best-effort-robuste Ableitung von
 *    'volume-counts'-Kandidaten aus data/release-volume-counts.json
 *    (publishedVolumesDE), deterministisch sortiert.
 *  - dedupeCandidates: 'volume-counts' hat die niedrigste Prioritaet und
 *    verliert jede Kollision mit einer bestehenden Quelle.
 *  - Akzeptanzfall Kagurabachi Band 8: der volume-counts-Kandidat erreicht
 *    ueber checkCandidateSource + evaluateReleaseCandidate (gemocktes
 *    fetchJson, kein Netzwerk) high-confidence mit konkreter Editions-URL.
 *
 * evaluateReleaseCandidate/checkCandidateSource/candidateToCacheItem und die
 * Provider bleiben unangetastet — dieser Test ruft sie nur auf.
 */

const assert = require('assert');
const {
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
} = require('./release-confidence');
const { checkCandidateSource } = require('./release-providers');
const {
  dedupeCandidates,
  loadVolumeCountsCandidates,
} = require('./run-release-cache-pipeline');

const sources = {
  schemaVersion: 1,
  requestPolicy: { minDelayMs: 0, timeoutMs: 1000, userAgent: 'MangaTrackerReleaseBot/1.0 test' },
  sources: [
    {
      id: 'manga-passion',
      name: 'Manga Passion',
      publisherAliases: ['Manga Passion'],
      baseUrl: 'https://www.manga-passion.de',
      allowedUrls: ['https://www.manga-passion.de'],
      enabled: true,
      type: 'provider',
    },
  ],
};
const aliasMap = buildPublisherAliasMap(sources);

function kagurabachiCountsDoc() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-02T07:07:29.983Z',
    items: [
      {
        seriesTitle: 'Kagurabachi',
        publisher: 'Carlsen Manga!',
        publishedVolumesDE: 8,
        source: 'manga-passion',
        sourceUrl: 'https://www.manga-passion.de/editions/5072',
        confidence: 'high',
        checkedAt: '2026-08-02T07:07:29.983Z',
      },
    ],
  };
}

function multiSeriesCountsDoc() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-02T07:07:29.983Z',
    items: [
      { seriesTitle: 'Zeta Manga', publisher: 'Egmont Manga', publishedVolumesDE: 3 },
      { seriesTitle: 'Adou', publisher: 'altraverse', publishedVolumesDE: 11 },
      { seriesTitle: 'Adou', publisher: 'altraverse', publishedVolumesDE: 2 },
    ],
  };
}

function makeFakeFetchJson(fixture) {
  return async function fakeFetchJson(url) {
    if (url.startsWith('https://api.manga-passion.de/editions?search=')) return fixture.searchHits;
    const m = url.match(/\/editions\/(\d+)\/volumes/);
    if (m) {
      const editionId = Number(m[1]);
      return fixture.volumesByEdition[editionId] || [];
    }
    throw new Error(`unexpected fetch URL ${url}`);
  };
}

function kagurabachiEdition5072Fixture() {
  return {
    searchHits: [
      {
        id: 5072,
        title: 'Kagurabachi',
        print: true,
        digital: false,
        publishers: [{ name: 'Carlsen Manga' }],
        numVolumes: 8,
        cover: 'https://media.manga-passion.de/edition/cover/5072.jpg',
      },
    ],
    volumesByEdition: {
      5072: [
        {
          number: 8,
          year: 2026,
          month: 6,
          day: 1,
          isbn13: '9783551740920',
          specialType: null,
          cover: 'https://media.manga-passion.de/volume/cover/5072-8.jpg',
        },
      ],
    },
  };
}

let passed = 0;

function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

async function okAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ok — ${name}`);
}

async function main() {
  console.log('test-release-cache-volume-counts-bridge:');

  // 1) Fixture inkl. Kagurabachi -> genau ein Kandidat mit den erwarteten Feldern.
  ok('Kagurabachi (publishedVolumesDE 8) ergibt genau einen volume-counts-Kandidaten', () => {
    const candidates = loadVolumeCountsCandidates(kagurabachiCountsDoc());
    assert.strictEqual(candidates.length, 1);
    const [candidate] = candidates;
    assert.strictEqual(candidate.origin, 'volume-counts');
    assert.strictEqual(candidate.seriesTitle, 'Kagurabachi');
    assert.strictEqual(candidate.publisher, 'Carlsen Manga!'); // verbatim, keine Normalisierung hier
    assert.strictEqual(candidate.volumeNumber, 8);
    assert.strictEqual(candidate.sourceUrl, null);
    assert.strictEqual(candidate.releaseDate, undefined);
    assert.strictEqual(candidate.sourceName, undefined);
  });

  // 2) Deterministische Sortierung ueber mehrere Serien (Titel -> Verlag -> Band).
  ok('Ausgabe ist deterministisch nach Titel/Verlag/Band sortiert', () => {
    const candidates = loadVolumeCountsCandidates(multiSeriesCountsDoc());
    assert.strictEqual(candidates.length, 3);
    assert.deepStrictEqual(
      candidates.map(c => `${c.seriesTitle}#${c.volumeNumber}`),
      ['Adou#2', 'Adou#11', 'Zeta Manga#3']
    );
  });

  // 3) Dedupe-Prioritaet: watchlist gewinnt gegen volume-counts bei gleicher (Titel,Verlag,Band).
  ok('dedupeCandidates behaelt den watchlist-Kandidaten gegenueber volume-counts', () => {
    const [volumeCountsCandidate] = loadVolumeCountsCandidates(kagurabachiCountsDoc());
    const watchlistCandidate = {
      origin: 'watchlist',
      seriesTitle: 'Kagurabachi',
      publisher: 'Carlsen Manga!',
      volumeNumber: 8,
      sourceUrl: null,
      notes: '',
      priority: 'mittel',
    };
    const deduped = dedupeCandidates([volumeCountsCandidate, watchlistCandidate], aliasMap);
    assert.strictEqual(deduped.length, 1);
    assert.strictEqual(deduped[0].origin, 'watchlist');

    // Reihenfolge der Eingabe darf das Ergebnis nicht beeinflussen.
    const dedupedReversed = dedupeCandidates([watchlistCandidate, volumeCountsCandidate], aliasMap);
    assert.strictEqual(dedupedReversed[0].origin, 'watchlist');
  });

  // 4) Fehlende/leere/kaputte Eingabe -> [].
  ok('loadVolumeCountsCandidates ist best-effort-robust gegen fehlende/leere Eingabe', () => {
    assert.deepStrictEqual(loadVolumeCountsCandidates(null), []);
    assert.deepStrictEqual(loadVolumeCountsCandidates({}), []);
    assert.deepStrictEqual(loadVolumeCountsCandidates({ items: [] }), []);
  });

  // 5) Items mit fehlender/ungueltiger publishedVolumesDE werden uebersprungen.
  ok('Items mit fehlender/ungueltiger publishedVolumesDE werden uebersprungen', () => {
    const doc = {
      items: [
        { seriesTitle: 'Missing', publisher: 'Carlsen' }, // publishedVolumesDE fehlt
        { seriesTitle: 'Zero', publisher: 'Carlsen', publishedVolumesDE: 0 },
        { seriesTitle: 'Negative', publisher: 'Carlsen', publishedVolumesDE: -1 },
        { seriesTitle: 'NotInteger', publisher: 'Carlsen', publishedVolumesDE: 2.5 },
        { seriesTitle: 'NotANumber', publisher: 'Carlsen', publishedVolumesDE: 'viele' },
        { seriesTitle: '', publisher: 'Carlsen', publishedVolumesDE: 3 }, // leerer Titel
        { seriesTitle: 'NoPublisher', publisher: '  ', publishedVolumesDE: 3 }, // leerer Verlag
        { seriesTitle: 'Valid', publisher: 'Carlsen', publishedVolumesDE: 3 },
      ],
    };
    const candidates = loadVolumeCountsCandidates(doc);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].seriesTitle, 'Valid');
  });

  // 6) Akzeptanz: Kagurabachi Band 8 erreicht via checkCandidateSource high-confidence.
  await okAsync('Kagurabachi Band 8 erreicht high-confidence ueber den Live-Provider-Check', async () => {
    const [candidate] = loadVolumeCountsCandidates(kagurabachiCountsDoc());
    const fixture = kagurabachiEdition5072Fixture();
    const checked = await checkCandidateSource(candidate, {
      sources,
      aliasMap,
      policy: { minDelayMs: 0, timeoutMs: 1000 },
      checkedAt: '2026-08-16T00:00:00.000Z',
      fetchJson: makeFakeFetchJson(fixture),
    });

    assert.strictEqual(checked.sourceUrl, 'https://www.manga-passion.de/editions/5072');
    const evaluation = evaluateReleaseCandidate(checked, { sources, aliasMap });
    assert.strictEqual(evaluation.confidence, 'high',
      `expected high, got ${evaluation.confidence} (${evaluation.reasonCodes.join(', ')})`);
  });

  // 7) Negativ: Band 8 nicht in der Bandliste -> volume-not-found, keine High-Confidence.
  await okAsync('Fehlender Band 8 beim Provider bleibt unter high-confidence (Review-Queue)', async () => {
    const [candidate] = loadVolumeCountsCandidates(kagurabachiCountsDoc());
    const fixture = kagurabachiEdition5072Fixture();
    fixture.volumesByEdition[5072] = [
      { number: 7, year: 2025, month: 12, day: 1, isbn13: '9783551740913', specialType: null },
    ];
    const checked = await checkCandidateSource(candidate, {
      sources,
      aliasMap,
      policy: { minDelayMs: 0, timeoutMs: 1000 },
      checkedAt: '2026-08-16T00:00:00.000Z',
      fetchJson: makeFakeFetchJson(fixture),
    });

    assert.strictEqual(checked.sourceResult, 'volume-not-found');
    const evaluation = evaluateReleaseCandidate(checked, { sources, aliasMap });
    assert.notStrictEqual(evaluation.confidence, 'high',
      'volume-not-found darf nie high-confidence erreichen');
  });

  console.log(`test-release-cache-volume-counts-bridge: ok (${passed} checks)`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
