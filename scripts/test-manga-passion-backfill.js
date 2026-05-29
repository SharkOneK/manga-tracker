#!/usr/bin/env node
'use strict';

/**
 * Phase 48 — Manga-Passion API hits get normalised to high-confidence editions.
 *
 * Covers:
 *  - Manga-Passion provider always emits the concrete /editions/<id> source URL.
 *  - High-confidence is only reached when title, publisher, volume number, real
 *    release date, edition id, and an allowed concrete editions URL line up.
 *  - The generic www.manga-passion.de URL alone is not enough for high.
 *  - run-release-cache-pipeline.js detects legacy MP cache entries that still
 *    carry the generic URL plus a recoverable "Edition <id>" note and routes
 *    them as backfill candidates for revalidation, without auto-promoting them.
 */

const assert = require('assert');
const {
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
} = require('./release-confidence');
const mangaPassionProvider = require('./release-providers/manga-passion-provider');
const { editionCanContainVolume } = mangaPassionProvider._private;
const {
  isLegacyMpBackfillTarget,
  loadLegacyMpBackfillCandidates,
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
    {
      id: 'carlsen',
      name: 'Carlsen Manga',
      publisherAliases: ['Carlsen', 'Carlsen Manga'],
      baseUrl: 'https://www.carlsen.de',
      allowedUrls: ['https://www.carlsen.de'],
      enabled: true,
      type: 'provider',
    },
  ],
};
const aliasMap = buildPublisherAliasMap(sources);

function fairyTailEdition960Volume17Fixture() {
  return {
    searchHits: [
      {
        id: 960,
        title: 'Fairy Tail',
        print: true,
        digital: false,
        publishers: [{ name: 'Carlsen Manga' }],
        numVolumes: 63,
        cover: 'https://media.manga-passion.de/edition/cover/960.jpg',
      },
    ],
    volumesByEdition: {
      960: [
        {
          number: 17,
          year: 2011,
          month: 12,
          day: 16,
          isbn13: '9783551796172',
          specialType: null,
          cover: 'https://media.manga-passion.de/volume/cover/2021/0805/1955/063556015cae346d09.jpg',
        },
      ],
    },
  };
}

// Phase 48 follow-up: the real Manga-Passion search for "Fairy Tail" also
// returns the spin-off edition "Fairy Tail +" (edition 959, numVolumes 1).
// Its title normalises to the same value ("fairy tail") and the publisher
// matches, so before the fix it counted as a second exact match and tripped
// the ambiguous-edition guard for volume 17 — even though a 1-volume edition
// can never contain volume 17.
function fairyTailWithPlusSpinoffFixture() {
  const fixture = fairyTailEdition960Volume17Fixture();
  fixture.searchHits = [
    fixture.searchHits[0],
    {
      id: 959,
      title: 'Fairy Tail +',
      print: true,
      digital: false,
      publishers: [{ name: 'Carlsen Manga' }],
      numVolumes: 1,
      cover: 'https://media.manga-passion.de/edition/cover/959.jpg',
    },
  ];
  return fixture;
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

async function testMpProviderBuildsConcreteEditionUrl() {
  const fixture = fairyTailEdition960Volume17Fixture();
  const result = await mangaPassionProvider.findRelease({
    origin: 'cache-backfill',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-28T00:00:00.000Z',
    fetchJson: makeFakeFetchJson(fixture),
  });

  assert.strictEqual(result.providerId, 'manga-passion');
  assert.strictEqual(result.sourceEditionId, 960);
  assert.strictEqual(result.sourceUrl, 'https://www.manga-passion.de/editions/960');
  assert.strictEqual(result.releaseDate, '2011-12-16');
  assert.strictEqual(result.sourceVolumeNumber, 17);
  assert.strictEqual(result.sourcePublisher, 'Carlsen Manga');

  const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
  assert.strictEqual(evaluation.confidence, 'high',
    `expected high, got ${evaluation.confidence} (${evaluation.reasonCodes.join(', ')})`);
}

async function testMpProviderKeepsEditionUrlWhenVolumeMissing() {
  const fixture = fairyTailEdition960Volume17Fixture();
  // Pretend the band we want is not listed: returns volume-not-found but with
  // a concrete editions URL, so review logs point to the actual edition page.
  fixture.volumesByEdition[960] = [
    { number: 1, year: 2000, month: 1, day: 1, specialType: null },
  ];
  const result = await mangaPassionProvider.findRelease({
    origin: 'cache-backfill',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-28T00:00:00.000Z',
    fetchJson: makeFakeFetchJson(fixture),
  });

  assert.strictEqual(result.sourceResult, 'volume-not-found');
  assert.strictEqual(result.sourceUrl, 'https://www.manga-passion.de/editions/960');
  const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high',
    'volume-not-found must never reach high confidence');
}

function testGenericMpUrlAloneIsNotHighConfidence() {
  const candidate = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    releaseDate: '2011-12-16',
    sourceUrl: 'https://www.manga-passion.de', // generic landing page
    sourceName: 'Manga Passion',
    sourceEditionTitle: 'Fairy Tail',
    sourcePublisher: 'Carlsen Manga',
    sourceVolumeNumber: 17,
  };
  const evaluation = evaluateReleaseCandidate(candidate, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high',
    'generic MP URL alone must not reach high confidence');
}

function testHighConfidenceNeedsConcreteEditionUrl() {
  const candidate = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    releaseDate: '2011-12-16',
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    sourceName: 'Manga Passion',
    sourceEditionTitle: 'Fairy Tail',
    sourcePublisher: 'Carlsen Manga',
    sourceVolumeNumber: 17,
  };
  const evaluation = evaluateReleaseCandidate(candidate, { sources, aliasMap });
  assert.strictEqual(evaluation.confidence, 'high',
    `expected high, got ${evaluation.confidence} (${evaluation.reasonCodes.join(', ')})`);
}

function testHighConfidenceRejectsVolumeMismatch() {
  const candidate = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    releaseDate: '2011-12-16',
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    sourceName: 'Manga Passion',
    sourceEditionTitle: 'Fairy Tail',
    sourcePublisher: 'Carlsen Manga',
    sourceVolumeNumber: 18, // mismatch
  };
  const evaluation = evaluateReleaseCandidate(candidate, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high');
  assert.ok(evaluation.reasonCodes.includes('volume-number-conflict'),
    `expected volume-number-conflict, got ${evaluation.reasonCodes.join(', ')}`);
}

function testHighConfidenceRejectsPublisherMismatch() {
  const candidate = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    releaseDate: '2011-12-16',
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    sourceName: 'Manga Passion',
    sourceEditionTitle: 'Fairy Tail',
    sourcePublisher: 'Tokyopop', // wrong publisher
    sourceVolumeNumber: 17,
  };
  const evaluation = evaluateReleaseCandidate(candidate, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high');
  assert.ok(evaluation.reasonCodes.includes('publisher-conflict'),
    `expected publisher-conflict, got ${evaluation.reasonCodes.join(', ')}`);
}

function testHighConfidenceRejectsMissingReleaseDate() {
  const candidate = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    releaseDate: null,
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    sourceName: 'Manga Passion',
    sourceEditionTitle: 'Fairy Tail',
    sourcePublisher: 'Carlsen Manga',
    sourceVolumeNumber: 17,
  };
  const evaluation = evaluateReleaseCandidate(candidate, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high');
  assert.ok(evaluation.reasonCodes.includes('missing-release-date'),
    `expected missing-release-date, got ${evaluation.reasonCodes.join(', ')}`);
}

function testBackfillDetectsLegacyFairyTailEntry() {
  const legacy = {
    seriesTitle: 'Fairy Tail',
    normalizedSeriesTitle: 'fairy tail',
    publisher: 'Carlsen Manga!',
    normalizedPublisher: 'carlsen manga',
    volumeNumber: 17,
    releaseDate: '2011-12-16',
    isbn13: null,
    coverUrl: 'https://media.manga-passion.de/volume/cover/2021/0805/1955/063556015cae346d09.jpg',
    sourceUrl: 'https://www.manga-passion.de',
    sourceName: 'Manga Passion',
    confidence: 'medium',
    notes: 'Serverseitig via Manga-Passion-API bestätigt (Edition 960, Band 17, Score 105). Ursprung: app-seed.',
    checkedAt: '2026-05-19T10:35:20.068Z',
  };
  assert.strictEqual(isLegacyMpBackfillTarget(legacy), true,
    'legacy Fairy Tail entry should be detected as backfill target');
}

function testBackfillIgnoresHighConfidenceEntries() {
  const item = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    sourceUrl: 'https://www.manga-passion.de',
    sourceName: 'Manga Passion',
    confidence: 'high',
    notes: 'Edition 960, Band 17',
  };
  assert.strictEqual(isLegacyMpBackfillTarget(item), false,
    'high-confidence entries must not be re-queued');
}

function testBackfillIgnoresConcreteEditionUrl() {
  const item = {
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
    sourceUrl: 'https://www.manga-passion.de/editions/960',
    sourceName: 'Manga Passion',
    confidence: 'medium',
    notes: 'Edition 960, Band 17',
  };
  assert.strictEqual(isLegacyMpBackfillTarget(item), false,
    'entries that already point to a concrete editions URL must not be re-queued');
}

function testBackfillIgnoresEntriesWithoutEditionId() {
  const item = {
    seriesTitle: 'Some Series',
    publisher: 'Some Pub',
    volumeNumber: 1,
    sourceUrl: 'https://www.manga-passion.de',
    sourceName: 'Manga Passion',
    confidence: 'medium',
    notes: 'No edition id here.',
  };
  assert.strictEqual(isLegacyMpBackfillTarget(item), false,
    'entries without an extractable edition id are not safe to revalidate automatically');
}

function testLoadLegacyMpBackfillCandidatesYieldsFairyTailVolume17() {
  const items = [
    {
      seriesTitle: 'Fairy Tail',
      publisher: 'Carlsen Manga!',
      volumeNumber: 17,
      sourceUrl: 'https://www.manga-passion.de',
      sourceName: 'Manga Passion',
      confidence: 'medium',
      notes: 'Edition 960, Band 17, Score 105.',
    },
    {
      seriesTitle: 'Other',
      publisher: 'Other',
      volumeNumber: 1,
      sourceUrl: 'https://www.manga-passion.de/editions/123',
      sourceName: 'Manga Passion',
      confidence: 'high',
      notes: 'Edition 123, Band 1.',
    },
  ];
  const candidates = loadLegacyMpBackfillCandidates(items);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].origin, 'cache-backfill');
  assert.strictEqual(candidates[0].seriesTitle, 'Fairy Tail');
  assert.strictEqual(candidates[0].volumeNumber, 17);
}

// --- Phase 48 follow-up: edition-volume plausibility in ambiguity detection ---

function testEditionCanContainVolumeHelper() {
  // Known capacity at or above the requested volume => plausible competitor.
  assert.strictEqual(editionCanContainVolume({ numVolumes: 63 }, 17), true);
  assert.strictEqual(editionCanContainVolume({ numVolumes: 17 }, 17), true);
  // Known capacity below the requested volume => cannot be the right edition.
  assert.strictEqual(editionCanContainVolume({ numVolumes: 1 }, 17), false);
  // Unknown / invalid capacity => stay conservative (treat as competitor).
  assert.strictEqual(editionCanContainVolume({}, 17), true);
  assert.strictEqual(editionCanContainVolume({ numVolumes: null }, 17), true);
  assert.strictEqual(editionCanContainVolume({ numVolumes: 'foo' }, 17), true);
  // Invalid requested volume number => never plausible.
  assert.strictEqual(editionCanContainVolume({ numVolumes: 63 }, 0), false);
}

async function testFairyTailPlusSpinoffDoesNotTriggerAmbiguity() {
  const fixture = fairyTailWithPlusSpinoffFixture();
  const result = await mangaPassionProvider.findRelease({
    origin: 'cache-backfill',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-29T00:00:00.000Z',
    fetchJson: makeFakeFetchJson(fixture),
  });

  assert.strictEqual(result.sourceResult, 'volume-found');
  assert.strictEqual(result.sourceEditionId, 960);
  assert.strictEqual(result.ambiguousEdition, false,
    'a 1-volume "Fairy Tail +" edition must not count as an ambiguity competitor for volume 17');
  assert.strictEqual(result.sourceUrl, 'https://www.manga-passion.de/editions/960');

  const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
  assert.strictEqual(evaluation.confidence, 'high',
    `expected high, got ${evaluation.confidence} (${evaluation.reasonCodes.join(', ')})`);
  assert.ok(!evaluation.reasonCodes.includes('ambiguous-edition'),
    'ambiguous-edition must not be reported once the spin-off is filtered out');
}

async function testGenuineAmbiguityStillBlocks() {
  // Two plausible print editions: same normalised title, same publisher, both
  // with numVolumes >= requested volume. This must remain blocked.
  const fixture = fairyTailEdition960Volume17Fixture();
  fixture.searchHits = [
    fixture.searchHits[0],
    {
      id: 961,
      title: 'Fairy Tail',
      print: true,
      digital: false,
      publishers: [{ name: 'Carlsen Manga' }],
      numVolumes: 30,
      cover: 'https://media.manga-passion.de/edition/cover/961.jpg',
    },
  ];
  const result = await mangaPassionProvider.findRelease({
    origin: 'cache-backfill',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-29T00:00:00.000Z',
    fetchJson: makeFakeFetchJson(fixture),
  });

  assert.strictEqual(result.ambiguousEdition, true,
    'two plausible same-title/same-publisher print editions must stay ambiguous');
  const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
  assert.notStrictEqual(evaluation.confidence, 'high');
  assert.ok(evaluation.reasonCodes.includes('ambiguous-edition'),
    `expected ambiguous-edition, got ${evaluation.reasonCodes.join(', ')}`);
}

async function testMissingNumVolumesKeepsAmbiguity() {
  // A competing edition without numVolumes must stay conservative => ambiguous.
  const fixture = fairyTailEdition960Volume17Fixture();
  fixture.searchHits = [
    fixture.searchHits[0],
    {
      id: 962,
      title: 'Fairy Tail',
      print: true,
      digital: false,
      publishers: [{ name: 'Carlsen Manga' }],
      // numVolumes intentionally omitted
      cover: 'https://media.manga-passion.de/edition/cover/962.jpg',
    },
  ];
  const result = await mangaPassionProvider.findRelease({
    origin: 'cache-backfill',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga!',
    volumeNumber: 17,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-29T00:00:00.000Z',
    fetchJson: makeFakeFetchJson(fixture),
  });

  assert.strictEqual(result.ambiguousEdition, true,
    'a competing edition with unknown numVolumes must keep the ambiguity for safety');
}

async function main() {
  await testMpProviderBuildsConcreteEditionUrl();
  await testMpProviderKeepsEditionUrlWhenVolumeMissing();
  testGenericMpUrlAloneIsNotHighConfidence();
  testHighConfidenceNeedsConcreteEditionUrl();
  testHighConfidenceRejectsVolumeMismatch();
  testHighConfidenceRejectsPublisherMismatch();
  testHighConfidenceRejectsMissingReleaseDate();
  testBackfillDetectsLegacyFairyTailEntry();
  testBackfillIgnoresHighConfidenceEntries();
  testBackfillIgnoresConcreteEditionUrl();
  testBackfillIgnoresEntriesWithoutEditionId();
  testLoadLegacyMpBackfillCandidatesYieldsFairyTailVolume17();
  testEditionCanContainVolumeHelper();
  await testFairyTailPlusSpinoffDoesNotTriggerAmbiguity();
  await testGenuineAmbiguityStillBlocks();
  await testMissingNumVolumesKeepsAmbiguity();
  console.log('test-manga-passion-backfill: ok (16 checks)');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
