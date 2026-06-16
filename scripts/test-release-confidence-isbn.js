#!/usr/bin/env node
'use strict';

/**
 * test-release-confidence-isbn.js — Backlog 3.x
 *
 * Unit-Tests für den ISBN-13-Eingriff im Release-Confidence-Verdikt sowie für
 * den Validator scripts/validate-isbn-lookup-cache.js. Framework-frei (Node-assert),
 * kein Netz. Stil analog zu scripts/test-publisher-providers.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
  isbnMatch,
  normalizeIsbn13,
} = require('./release-confidence');

const repoRoot = path.resolve(__dirname, '..');
const validatorPath = path.join(repoRoot, 'scripts', 'validate-isbn-lookup-cache.js');

const sources = {
  schemaVersion: 1,
  requestPolicy: { minDelayMs: 0, timeoutMs: 1000, userAgent: 'MangaTrackerReleaseBot/1.0 test' },
  sources: [
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

const ISBN = '9783551796160';

// Basis-Kandidat: erfüllt alle High-Kriterien außer dem exakten Titel
// (sourceEditionTitle weicht ab → edition-title-conflict). Damit lässt sich der
// ISBN-Override gezielt prüfen.
function editionConflictCandidate(extra = {}) {
  return {
    origin: 'test',
    seriesTitle: 'Fairy Tail',
    publisher: 'Carlsen Manga',
    volumeNumber: 16,
    sourceEditionTitle: 'Fairy Tail (Neuauflage)',
    sourcePublisher: 'Carlsen Manga',
    sourceVolumeNumber: 16,
    releaseDate: '2012-11-27',
    sourceUrl: 'https://www.carlsen.de/manga/fairy-tail/fairy-tail-16/9783551796160',
    sourceName: 'Carlsen Manga',
    isbn13: ISBN,
    ...extra,
  };
}

function evaluate(candidate) {
  return evaluateReleaseCandidate(candidate, { sources, aliasMap });
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log('\nBacklog 3.x — Release-Confidence ISBN-Eingriff\n');

// 1) high-ISBN + Provider-ISBN gleich + nur edition-title-conflict → high
test('Szenario 1: ISBN-Match hebt reinen edition-title-conflict auf → high', () => {
  const evaluation = evaluate(editionConflictCandidate({ expectedIsbn13: ISBN }));
  assert.strictEqual(evaluation.confidence, 'high');
  assert.ok(evaluation.reasonCodes.includes('edition-title-conflict'), 'reasonCode bleibt zur Diagnose erhalten');
});

// 2) high-ISBN + Provider-ISBN gleich + ambiguous-edition als einziger Block → high
test('Szenario 2: ISBN-Match hebt ambiguous-edition auf → high', () => {
  const candidate = editionConflictCandidate({
    expectedIsbn13: ISBN,
    sourceEditionTitle: 'Fairy Tail', // kein Titel-Konflikt
    ambiguousEdition: true,
  });
  const evaluation = evaluate(candidate);
  assert.strictEqual(evaluation.confidence, 'high');
});

// 3) publisher-conflict bleibt trotz ISBN-Match blockierend
test('Szenario 3: publisher-conflict bleibt trotz ISBN-Match blocked', () => {
  const candidate = editionConflictCandidate({
    expectedIsbn13: ISBN,
    sourcePublisher: 'Egmont Manga',
  });
  const evaluation = evaluate(candidate);
  assert.strictEqual(evaluation.confidence, 'blocked');
  assert.ok(evaluation.reasonCodes.includes('publisher-conflict'));
});

// 4) volume-number-conflict bleibt trotz ISBN-Match blockierend
test('Szenario 4: volume-number-conflict bleibt trotz ISBN-Match blocked', () => {
  const candidate = editionConflictCandidate({
    expectedIsbn13: ISBN,
    sourceVolumeNumber: 17,
  });
  const evaluation = evaluate(candidate);
  assert.strictEqual(evaluation.confidence, 'blocked');
  assert.ok(evaluation.reasonCodes.includes('volume-number-conflict'));
});

// 5) high-ISBN + Provider-ISBN ungleich → blocked mit isbn-conflict
test('Szenario 5: ISBN-Mismatch erzwingt blocked mit reasonCode isbn-conflict', () => {
  const candidate = editionConflictCandidate({
    expectedIsbn13: '9783551796177', // weicht von Provider-ISBN ab
    sourceEditionTitle: 'Fairy Tail', // sonst high
  });
  const evaluation = evaluate(candidate);
  assert.strictEqual(evaluation.confidence, 'blocked');
  assert.ok(evaluation.reasonCodes.includes('isbn-conflict'));
});

// 6) high-ISBN, Provider liefert keine ISBN → identisch zu "ohne expectedIsbn13"
test('Szenario 6: keine Provider-ISBN → identisch zum Verhalten ohne expectedIsbn13', () => {
  const withExpected = evaluate(editionConflictCandidate({ expectedIsbn13: ISBN, isbn13: null }));
  const withoutExpected = evaluate(editionConflictCandidate({ isbn13: null }));
  assert.deepStrictEqual(withExpected, withoutExpected);
  assert.strictEqual(withExpected.confidence, 'blocked');
});

// 7) kein expectedIsbn13 → exakt Alt-Verhalten
test('Szenario 7: kein expectedIsbn13 → unveränderter blocked-Pfad', () => {
  const evaluation = evaluate(editionConflictCandidate());
  assert.strictEqual(evaluation.confidence, 'blocked');
  assert.ok(!evaluation.reasonCodes.includes('isbn-conflict'));
});

// 8) expectedIsbn13 mit Bindestrichen/Leerzeichen → normalisiert, Match greift
test('Szenario 8: formatierte expectedIsbn13 wird normalisiert, Match greift', () => {
  const candidate = editionConflictCandidate({ expectedIsbn13: '978-3-551-79616-0 ' });
  const evaluation = evaluate(candidate);
  assert.strictEqual(evaluation.confidence, 'high');
});

// 9) ungültige expectedIsbn13 (zu kurz) → wie "keine ISBN"
test('Szenario 9: ungültige expectedIsbn13 → wie keine ISBN (Alt-Verhalten)', () => {
  const withInvalid = evaluate(editionConflictCandidate({ expectedIsbn13: '97812345' }));
  const without = evaluate(editionConflictCandidate());
  assert.deepStrictEqual(withInvalid, without);
  assert.strictEqual(withInvalid.confidence, 'blocked');
});

// isbnMatch / normalizeIsbn13 Direktprüfungen
test('isbnMatch: match/mismatch/none korrekt', () => {
  assert.strictEqual(isbnMatch({ expectedIsbn13: ISBN, isbn13: ISBN }), 'match');
  assert.strictEqual(isbnMatch({ expectedIsbn13: ISBN, isbn13: '9783551796177' }), 'mismatch');
  assert.strictEqual(isbnMatch({ expectedIsbn13: ISBN, isbn13: null }), 'none');
  assert.strictEqual(isbnMatch({ isbn13: ISBN }), 'none');
});

test('normalizeIsbn13: gültig/ungültig', () => {
  assert.strictEqual(normalizeIsbn13('978-3-551-79616-0'), '9783551796160');
  assert.strictEqual(normalizeIsbn13('123'), null);
  assert.strictEqual(normalizeIsbn13(null), null);
});

// ── Validator-Tests über Fixtures (kein Netz) ────────────────────────────────
console.log('\nBacklog 3.x — Validator validate-isbn-lookup-cache.js\n');

function runValidator(doc) {
  const tmp = path.join(os.tmpdir(), `isbn-cache-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2), 'utf8');
  let status = 0;
  try {
    execFileSync('node', [validatorPath, tmp], { encoding: 'utf8' });
    if (process.env.DBG) console.error('DBG status0 isbn=', JSON.parse(fs.readFileSync(tmp, 'utf8')).items.map(i => i && i.isbn13 + '/' + i.confidence).join(','));
  } catch (e) {
    status = (typeof e.status === 'number' && e.status) ? e.status : 1;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
  return status;
}

function validItem(extra = {}) {
  return {
    seriesTitle: 'Fairy Tail',
    normalizedSeriesTitle: 'fairy tail',
    publisher: 'Carlsen Manga',
    normalizedPublisher: 'carlsen manga',
    volumeNumber: 16,
    isbn13: ISBN,
    source: 'open-library',
    confidence: 'high',
    candidateCount: 1,
    evidence: 'Test-Evidence.',
    checkedAt: '2026-06-16T00:00:00.000Z',
    ...extra,
  };
}

function validDoc(items) {
  return {
    schemaVersion: 1,
    generatedAt: null,
    source: 'lookup-isbn13.js',
    itemCount: items.length,
    items,
  };
}

// 10) Gültiger Cache (leer + befüllt) → Exit 0
test('Validator 10: leerer Cache → Exit 0', () => {
  assert.strictEqual(runValidator(validDoc([])), 0);
});
test('Validator 10: befüllter gültiger Cache → Exit 0', () => {
  assert.strictEqual(runValidator(validDoc([validItem()])), 0);
});

// 11) high ohne gültige isbn13 → Exit 1
test('Validator 11: high ohne gültige isbn13 → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ isbn13: null })])), 1);
});

// 12) unsure/none mit gesetzter isbn13 → Exit 1
test('Validator 12: unsure mit gesetzter isbn13 → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ confidence: 'unsure' })])), 1);
});
test('Validator 12: none mit gesetzter isbn13 → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ confidence: 'none' })])), 1);
});
test('Validator 12: unsure mit isbn13 null → Exit 0', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ confidence: 'unsure', isbn13: null })])), 0);
});

// 13) itemCount !== items.length → Exit 1
test('Validator 13: itemCount-Mismatch → Exit 1', () => {
  const doc = validDoc([validItem()]);
  doc.itemCount = 5;
  assert.strictEqual(runValidator(doc), 1);
});

// 14) ungültige confidence / fehlende Pflichtfelder / Duplikat → Exit 1
test('Validator 14: ungültige confidence → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ confidence: 'maybe', isbn13: null })])), 1);
});
test('Validator 14: fehlender seriesTitle → Exit 1', () => {
  const item = validItem();
  delete item.seriesTitle;
  assert.strictEqual(runValidator(validDoc([item])), 1);
});
test('Validator 14: Duplikat-Key → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem(), validItem()])), 1);
});
test('Validator 14: normalizedSeriesTitle inkonsistent → Exit 1', () => {
  assert.strictEqual(runValidator(validDoc([validItem({ normalizedSeriesTitle: 'falsch' })])), 1);
});

// 15) Datei fehlt / ungültiges JSON → Exit 1
test('Validator 15: ungültiges JSON → Exit 1', () => {
  assert.strictEqual(runValidator('{ kaputt'), 1);
});
test('Validator 15: fehlende Datei → Exit 1', () => {
  let status = 0;
  try {
    execFileSync('node', [validatorPath, path.join(os.tmpdir(), `nicht-da-${process.pid}.json`)], { stdio: 'ignore' });
  } catch (e) {
    status = (typeof e.status === 'number' && e.status) ? e.status : 1;
  }
  assert.strictEqual(status, 1);
});

console.log('');
if (failed > 0) {
  console.error(`test-release-confidence-isbn: ${failed} fehlgeschlagen, ${passed} ok`);
  process.exitCode = 1;
} else {
  console.log(`test-release-confidence-isbn: ok (${passed} Tests)`);
}
