#!/usr/bin/env node
'use strict';

// Phase 57: tests for the publication-status pipeline + validator.

const assert = require('assert');
const { validateSeriesPublicationStatus, validateSeriesStatusOverrides } = require('./validate-series-publication-status');
const { editionIdFromUrl, STATUS_MAP } = require('./run-series-publication-status');

function validDoc() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-09T00:00:00.000Z',
    items: [{
      seriesTitle: 'One Piece',
      publisher: 'Carlsen Manga!',
      ongoing: 'true',
      sourceStatus: 1,
      editionId: 87,
      source: 'manga-passion',
      sourceUrl: 'https://www.manga-passion.de/editions/87',
      confidence: 'high',
      checkedAt: '2026-06-09T00:00:00.000Z',
    }],
  };
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }

test('validator accepts a valid publication-status doc', () => {
  const r = validateSeriesPublicationStatus(validDoc());
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('validator rejects ongoing values other than true/false', () => {
  const doc = validDoc();
  doc.items[0].ongoing = 'unknown';
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /ongoing/.test(e)));
});

test('validator rejects unexpected sourceStatus codes', () => {
  const doc = validDoc();
  doc.items[0].sourceStatus = 3;
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /sourceStatus/.test(e)));
});

test('validator rejects confidence other than high', () => {
  const doc = validDoc();
  doc.items[0].confidence = 'medium';
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
});

test('validator rejects non-https sourceUrl', () => {
  const doc = validDoc();
  doc.items[0].sourceUrl = 'http://www.manga-passion.de/editions/87';
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
});

test('validator rejects duplicate series/publisher', () => {
  const doc = validDoc();
  doc.items.push({ ...doc.items[0] });
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate/.test(e)));
});

test('STATUS_MAP maps only 1->true and 2->false', () => {
  assert.strictEqual(STATUS_MAP[1], 'true');
  assert.strictEqual(STATUS_MAP[2], 'false');
  assert.strictEqual(STATUS_MAP[3], undefined);
  assert.strictEqual(STATUS_MAP[0], undefined);
});

test('editionIdFromUrl extracts manga-passion edition id, null otherwise', () => {
  assert.strictEqual(editionIdFromUrl('https://www.manga-passion.de/editions/87'), 87);
  assert.strictEqual(editionIdFromUrl('https://www.carlsen.de'), null);
  assert.strictEqual(editionIdFromUrl(''), null);
  assert.strictEqual(editionIdFromUrl(null), null);
});

// ── Phase 58: overrides ────────────────────────────────────────────────────

test('status validator accepts an override item without edition/sourceStatus', () => {
  const doc = validDoc();
  doc.items[0] = {
    seriesTitle: 'Real Account',
    publisher: 'Tokyopop',
    ongoing: 'false',
    source: 'override',
    reason: 'eingestellt',
    confidence: 'high',
    checkedAt: '2026-06-09T00:00:00.000Z',
  };
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('status validator rejects an override item without reason', () => {
  const doc = validDoc();
  doc.items[0] = {
    seriesTitle: 'Real Account',
    publisher: 'Tokyopop',
    ongoing: 'false',
    source: 'override',
    confidence: 'high',
    checkedAt: '2026-06-09T00:00:00.000Z',
  };
  const r = validateSeriesPublicationStatus(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /reason/.test(e)));
});

test('overrides validator accepts a valid override file', () => {
  const r = validateSeriesStatusOverrides({
    schemaVersion: 1,
    items: [{ seriesTitle: 'Real Account', publisher: 'Tokyopop', ongoing: 'false', reason: 'eingestellt' }],
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('overrides validator rejects missing reason and bad ongoing', () => {
  const r1 = validateSeriesStatusOverrides({ schemaVersion: 1, items: [{ seriesTitle: 'X', publisher: 'Y', ongoing: 'false' }] });
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.errors.some(e => /reason/.test(e)));
  const r2 = validateSeriesStatusOverrides({ schemaVersion: 1, items: [{ seriesTitle: 'X', publisher: 'Y', ongoing: 'maybe', reason: 'r' }] });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some(e => /ongoing/.test(e)));
});

test('overrides validator rejects duplicate series/publisher', () => {
  const r = validateSeriesStatusOverrides({
    schemaVersion: 1,
    items: [
      { seriesTitle: 'X', publisher: 'Y', ongoing: 'false', reason: 'a' },
      { seriesTitle: 'x', publisher: 'y', ongoing: 'true', reason: 'b' },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate/.test(e)));
});

console.log(`\nSeries publication status tests passed: ${passed}/${passed}`);
