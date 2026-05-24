#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildPublisherAliasMap, evaluateReleaseCandidate } = require('./release-confidence');
const { getEnabledReleaseProviders } = require('./release-providers');
const carlsenProvider = require('./release-providers/carlsen-provider');
const altraverseProvider = require('./release-providers/altraverse-provider');

const repoRoot = path.resolve(__dirname, '..');
const carlsenFixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'release-providers', 'carlsen');
const altraverseFixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'release-providers', 'altraverse');

function carlsenFixture(name) {
  return fs.readFileSync(path.join(carlsenFixtureDir, name), 'utf8');
}

function altraverseFixture(name) {
  return fs.readFileSync(path.join(altraverseFixtureDir, name), 'utf8');
}

const sources = {
  schemaVersion: 1,
  requestPolicy: { minDelayMs: 0, timeoutMs: 1000, userAgent: 'MangaTrackerReleaseBot/1.0 test' },
  sources: [
    {
      id: 'carlsen',
      name: 'Carlsen Manga',
      publisherAliases: ['Carlsen', 'Hayabusa', 'Carlsen Manga'],
      baseUrl: 'https://www.carlsen.de',
      allowedUrls: ['https://www.carlsen.de'],
      enabled: true,
      type: 'provider',
    },
    {
      id: 'altraverse',
      name: 'Altraverse',
      publisherAliases: ['Altraverse'],
      baseUrl: 'https://altraverse.de',
      allowedUrls: ['https://altraverse.de'],
      enabled: true,
      type: 'provider',
    },
  ],
};
const aliasMap = buildPublisherAliasMap(sources);

async function testCarlsenFixtureHighConfidence() {
  const calls = [];
  const result = await carlsenProvider.findRelease({
    origin: 'test',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga',
    volumeNumber: 16,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-24T00:00:00.000Z',
    fetchHtml: async url => {
      calls.push(url);
      if (url.startsWith('https://www.carlsen.de/suche?')) return carlsenFixture('search-fairy-tail-16.html');
      if (url === 'https://www.carlsen.de/manga/fairy-tail/fairy-tail-16/9783551796160') return carlsenFixture('product-fairy-tail-16.html');
      throw new Error(`unexpected fixture URL ${url}`);
    },
  });

  assert.strictEqual(result.providerId, 'carlsen');
  assert.strictEqual(result.releaseDate, '2012-11-27');
  assert.strictEqual(result.isbn13, '9783551796160');
  assert.strictEqual(result.sourceEditionTitle, 'Fairy Tail');
  assert.strictEqual(result.sourcePublisher, 'Carlsen Manga');
  assert.strictEqual(result.sourceVolumeNumber, 16);
  assert.strictEqual(result.sourceFetchFailed, undefined);
  assert.ok(calls.length >= 2, 'search and product fixtures should be requested');

  const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
  assert.strictEqual(evaluation.confidence, 'high');
}

async function testHayabusaAliasParsesProduct() {
  const result = await carlsenProvider._private.carlsenParseProduct({
    url: 'https://www.carlsen.de/manga/our-dining-table/our-dining-table-1/9783551620052',
    html: carlsenFixture('product-hayabusa-1.html'),
  }, {
    seriesTitle: 'Our Dining Table',
    publisher: 'Hayabusa',
    volumeNumber: 1,
  }, { policy: { minDelayMs: 0 } });

  assert.ok(result, 'Hayabusa product should parse through Carlsen provider');
  assert.strictEqual(result.releaseDate, '2020-04-28');
  assert.strictEqual(result.sourcePublisher, 'Hayabusa');
  assert.strictEqual(result.sourceEditionTitle, 'Our Dining Table');
}

async function testGenericPublisherFixtureHighConfidence() {
  const result = await altraverseProvider.findRelease({
    origin: 'test',
    seriesTitle: 'Adou',
    publisher: 'Altraverse',
    volumeNumber: 10,
  }, {
    sources,
    aliasMap,
    policy: { minDelayMs: 0, timeoutMs: 1000 },
    checkedAt: '2026-05-24T00:00:00.000Z',
    fetchHtml: async url => {
      if (url.startsWith('https://altraverse.de/search?')) return altraverseFixture('search-adou-10.html');
      if (url === 'https://altraverse.de/detail/index/sArticle/9999') return altraverseFixture('product-adou-10.html');
      throw new Error(`unexpected fixture URL ${url}`);
    },
  });

  assert.strictEqual(result.providerId, 'altraverse');
  assert.strictEqual(result.releaseDate, '2026-09-15');
  assert.strictEqual(result.isbn13, '9783753912345');
  assert.strictEqual(result.sourceEditionTitle, 'Adou');
  assert.strictEqual(result.sourcePublisher, 'Altraverse');
  assert.strictEqual(result.sourceVolumeNumber, 10);
  assert.strictEqual(evaluateReleaseCandidate(result, { sources, aliasMap }).confidence, 'high');
}

function testAllPublisherProvidersRegistered() {
  const enabled = getEnabledReleaseProviders(require('../data/release-sources.json')).map(provider => provider.id).sort();
  for (const id of ['altraverse', 'carlsen', 'crunchyroll-manga', 'dani-books', 'dokico', 'egmont', 'hayabusa', 'manga-cult', 'mangamoon', 'panini', 'tokyopop', 'yomeru']) {
    assert.ok(enabled.includes(id), `${id} should be registered and enabled`);
  }
}

async function main() {
  await testCarlsenFixtureHighConfidence();
  await testHayabusaAliasParsesProduct();
  await testGenericPublisherFixtureHighConfidence();
  testAllPublisherProvidersRegistered();
  console.log('test-publisher-providers: ok');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
