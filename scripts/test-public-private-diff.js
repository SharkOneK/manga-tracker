#!/usr/bin/env node
'use strict';

/** Phase 43 mandatory public/private separation gate. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateReleaseVolumeCounts } = require('./validate-release-volume-counts');

const repoRoot = path.resolve(__dirname, '..');
const PRIVATE_KEYS = [
  'notes', 'startedAt', 'finishedAt', 'owner_token', 'ownerToken', 'owner_hash', 'ownerHash',
  'owner_token_hash', 'isbn13', 'mpEditionId', 'bands', 'owned', 'current', 'readStatus',
  'collectionStatus', 'boughtAt', 'readAt', 'privateNotes', 'supabaseId',
];
const PRIVATE_VALUES = ['private owner note', 'secret-owner-token', 'Lesestatus', 'Besitzstatus'];

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')); }
function stringify(value) { return JSON.stringify(value); }

function buildPublicReleaseVolumeCountFromPrivate(privateSeries) {
  return {
    seriesTitle: privateSeries.title,
    publisher: privateSeries.pub,
    publishedVolumesDE: privateSeries.publicRelease.publishedVolumesDE,
    source: privateSeries.publicRelease.source,
    sourceUrl: privateSeries.publicRelease.sourceUrl,
    confidence: 'high',
    checkedAt: privateSeries.publicRelease.checkedAt,
  };
}

function assertNoPrivateLeak(label, value) {
  const text = stringify(value);
  for (const key of PRIVATE_KEYS) {
    assert.ok(!new RegExp(`"${key}"\\s*:`).test(text), `${label} leaks private key ${key}`);
  }
  for (const privateValue of PRIVATE_VALUES) {
    assert.ok(!text.includes(privateValue), `${label} leaks private value ${privateValue}`);
  }
}

const syntheticPrivateSeries = {
  id: 'private-series-id',
  title: 'Demon Slave',
  pub: 'Crunchyroll Manga',
  bands: { 1: 'owned' },
  owned: 1,
  notes: 'private owner note',
  startedAt: '2026-01-01',
  finishedAt: null,
  owner_token: 'secret-owner-token',
  isbn13: '9780000000000',
  mpEditionId: 'private-mp-id',
  readStatus: 'Lesestatus',
  collectionStatus: 'Besitzstatus',
  publicRelease: {
    publishedVolumesDE: 2,
    source: 'manga-passion',
    sourceUrl: 'https://www.manga-passion.de/editions/1',
    checkedAt: '2026-05-26T00:00:00.000Z',
  },
};

const publicDoc = {
  schemaVersion: 1,
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [buildPublicReleaseVolumeCountFromPrivate(syntheticPrivateSeries)],
};
const validation = validateReleaseVolumeCounts(publicDoc, { sources: { sources: [{ enabled: true, allowedUrls: ['https://www.manga-passion.de'] }] } });
assert.strictEqual(validation.ok, true, validation.errors.join('; '));
assertNoPrivateLeak('synthetic public projection', publicDoc);

const currentCounts = readJson('data/release-volume-counts.json');
assertNoPrivateLeak('data/release-volume-counts.json', currentCounts);
const currentValidation = validateReleaseVolumeCounts(currentCounts, { sources: readJson('data/release-sources.json') });
assert.strictEqual(currentValidation.ok, true, currentValidation.errors.join('; '));

const report = readJson('data/release-volume-counts-report.json');
assertNoPrivateLeak('data/release-volume-counts-report.json', report);
assert.strictEqual(report.privacyGateRequired, true, 'report must mark privacyGateRequired=true');

const appJs = fs.readFileSync(path.join(repoRoot, 'src/app.js'), 'utf8');
const loadStart = appJs.indexOf('async function loadReleaseVolumeCounts');
const factsEnd = appJs.indexOf('async function loadReleaseCoverageKnownData', loadStart);
assert.ok(loadStart >= 0 && factsEnd > loadStart, 'Phase 43 app read-only block must exist');
const phase43Block = appJs.slice(loadStart, factsEnd);
assert.ok(!/pushCloud\s*\(|persist\s*\(|patchCollectionPayload|localStorage\.setItem|supabase\.(from|rpc)|api\.github\.com/i.test(phase43Block), 'Phase 43 app block must be read-only');

console.log('ok - Phase 43 synthetic public/private projection contains no private fields');
console.log('ok - Phase 43 release-volume-counts artifacts contain no private fields');
console.log('ok - Phase 43 app integration is read-only');
console.log('\nPublic/private diff tests passed: 3/3');
