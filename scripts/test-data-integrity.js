#!/usr/bin/env node
// scripts/test-data-integrity.js — Phase 20: Datenintegritäts-Tests
// Läuft direkt mit Node, kein Test-Framework nötig.
'use strict';

const assert = require('assert');

// ─── Testrahmen (gleich wie test-stats.js) ────────────────────────────────

let _passed = 0;
let _failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    _failed++;
  }
}

// ─── Aus app.js gespiegelte Hilfsfunktionen ───────────────────────────────

// App-Modus-Logik (ohne DOM/localStorage)
function getAppMode(_viewColl, _collId, _ownerToken) {
  if (_viewColl) return 'public-readonly';
  if (_collId && _ownerToken) return 'cloud-owner-edit';
  return 'local-edit';
}
function isPublicReadOnly(_viewColl, _collId, _ownerToken) {
  return getAppMode(_viewColl, _collId, _ownerToken) === 'public-readonly';
}
function canEditLocal(_viewColl, _collId, _ownerToken) {
  return !isPublicReadOnly(_viewColl, _collId, _ownerToken);
}
function canWriteCloud(_viewColl, _collId, _ownerToken) {
  return getAppMode(_viewColl, _collId, _ownerToken) === 'cloud-owner-edit';
}

// UUID-Validator
function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// mergePreservedFields
function mergePreservedFields(existing, entry) {
  if (!existing) return entry;
  const keys = [
    'isbn13', 'editionFingerprint', 'coverManuallySet', 'mpEditionId', 'mpVerifiedAt',
    'releaseSource', 'releaseCheckedAt', 'releaseConfidence', 'externalIds', 'volumeMeta',
  ];
  keys.forEach(function(k) {
    if (existing[k] !== undefined && entry[k] === undefined) entry[k] = existing[k];
  });
  return entry;
}

// escapeHtml
function escapeHtml(value) {
  return String(value !== null && value !== undefined ? value : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// safeHttpsUrl
function safeHttpsUrl(v) {
  if (!v || typeof v !== 'string') return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? v : '';
  } catch { return ''; }
}

// mFirstMissingBand / mNextBand (aus app.js)
function mFirstMissingBand(m) {
  const owned = m.bands || {};
  const total = Number(m.total);
  const hasTotalKnown = !isNaN(total) && total > 0;
  const ownedNums = new Set(Object.keys(owned).map(Number));
  const maxOwned = ownedNums.size ? Math.max(...ownedNums) : 0;
  const searchUpTo = hasTotalKnown ? total : (maxOwned + 1);
  for (let i = 1; i <= searchUpTo; i++) {
    if (!ownedNums.has(i)) return i;
  }
  return null;
}
function mNextBand(m) {
  const keys = Object.keys(m.bands || {}).map(Number);
  return keys.length ? Math.max(...keys) + 1 : 1;
}

// getReleaseTargetVolume
function getReleaseTargetVolume(m) {
  const firstMiss = mFirstMissingBand(m);
  if (m.ongoing === 'false' && firstMiss === null) return null;
  return firstMiss !== null ? firstMiss : mNextBand(m);
}

// ─── Tests ────────────────────────────────────────────────────────────────

console.log('\nPhase 20 — Datenintegritäts-Tests\n');

// 1. canEditLocal() ist true im local-edit Modus
runTest('canEditLocal() ist true ohne _viewColl und ohne _collId', function() {
  assert.strictEqual(canEditLocal(null, null, null), true);
});

// 2. isPublicReadOnly() ist false ohne _viewColl
runTest('isPublicReadOnly() ist false ohne _viewColl', function() {
  assert.strictEqual(isPublicReadOnly(null, 'col123', 'tok456'), false);
});

// 3. isPublicReadOnly() ist true mit _viewColl
runTest('isPublicReadOnly() ist true wenn _viewColl gesetzt', function() {
  assert.strictEqual(isPublicReadOnly('some-uuid', null, null), true);
});

// 4. canWriteCloud() ist false ohne ownerToken
runTest('canWriteCloud() ist false ohne ownerToken (local-edit Modus)', function() {
  assert.strictEqual(canWriteCloud(null, 'col123', null), false);
});

// 5. canWriteCloud() ist true mit collId und ownerToken
runTest('canWriteCloud() ist true mit collId und ownerToken', function() {
  assert.strictEqual(canWriteCloud(null, 'col123', 'tok456'), true);
});

// 6. mergePreservedFields erhält isbn13
runTest('mergePreservedFields erhält isbn13 aus existing', function() {
  const existing = { id: '1', isbn13: '9783551762405', mpEditionId: 'abc' };
  const entry = { id: '1', title: 'Test' };
  mergePreservedFields(existing, entry);
  assert.strictEqual(entry.isbn13, '9783551762405');
});

// 7. mergePreservedFields erhält mpEditionId
runTest('mergePreservedFields erhält mpEditionId aus existing', function() {
  const existing = { id: '1', mpEditionId: 'edition-42', mpVerifiedAt: '2025-01-01' };
  const entry = { id: '1', title: 'Test' };
  mergePreservedFields(existing, entry);
  assert.strictEqual(entry.mpEditionId, 'edition-42');
  assert.strictEqual(entry.mpVerifiedAt, '2025-01-01');
});

// 8. mergePreservedFields überschreibt nicht, wenn entry-Feld schon vorhanden
runTest('mergePreservedFields überschreibt nicht, wenn entry-Feld bereits gesetzt', function() {
  const existing = { isbn13: '9783551762405' };
  const entry = { isbn13: '9780000000000' };
  mergePreservedFields(existing, entry);
  assert.strictEqual(entry.isbn13, '9780000000000');
});

// 9. mergePreservedFields: existing=null → entry unverändert zurück
runTest('mergePreservedFields gibt entry unverändert zurück wenn existing null ist', function() {
  const entry = { id: '1', title: 'Test' };
  const result = mergePreservedFields(null, entry);
  assert.deepStrictEqual(result, { id: '1', title: 'Test' });
});

// 10. isUuid validiert korrekte UUID
runTest('isUuid: korrekte UUID wird akzeptiert', function() {
  assert.strictEqual(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.strictEqual(isUuid('A987FBC9-4BED-3078-CF07-9141BA07C9F3'), true);
});

// 11. isUuid lehnt ungültige IDs ab
runTest('isUuid: ungültige Werte werden abgelehnt', function() {
  assert.strictEqual(isUuid('nicht-eine-uuid'), false);
  assert.strictEqual(isUuid(''), false);
  assert.strictEqual(isUuid(null), false);
  assert.strictEqual(isUuid(42), false);
  assert.strictEqual(isUuid('550e8400-e29b-41d4-a716'), false); // zu kurz
});

// 12. escapeHtml escaped HTML-Zeichen korrekt
runTest('escapeHtml escaped <, >, &, ", \' korrekt', function() {
  assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.strictEqual(escapeHtml("O'Brian & Co"), 'O&#39;Brian &amp; Co');
  assert.strictEqual(escapeHtml(''), '');
  assert.strictEqual(escapeHtml(null), '');
});

// 13. safeHttpsUrl akzeptiert https-URLs
runTest('safeHttpsUrl akzeptiert gültige https-URLs', function() {
  const url = 'https://covers.openlibrary.org/b/isbn/9783551762405-L.jpg';
  assert.strictEqual(safeHttpsUrl(url), url);
});

// 14. safeHttpsUrl lehnt http-URLs ab
runTest('safeHttpsUrl lehnt http-URLs ab', function() {
  assert.strictEqual(safeHttpsUrl('http://example.com/cover.jpg'), '');
});

// 15. safeHttpsUrl lehnt javascript:-URLs ab
runTest('safeHttpsUrl lehnt javascript:-URLs ab', function() {
  assert.strictEqual(safeHttpsUrl('javascript:alert(1)'), '');
});

// 16. safeHttpsUrl lehnt leere/null Werte ab
runTest('safeHttpsUrl gibt leer zurück für null/undefined/leer', function() {
  assert.strictEqual(safeHttpsUrl(null), '');
  assert.strictEqual(safeHttpsUrl(''), '');
  assert.strictEqual(safeHttpsUrl(undefined), '');
});

// 17. getReleaseTargetVolume: null für vollständige abgeschlossene Serien
runTest('getReleaseTargetVolume gibt null für vollständige abgeschlossene Serien', function() {
  const m = {
    ongoing: 'false',
    total: 3,
    bands: { '1': 'completed', '2': 'completed', '3': 'completed' },
  };
  assert.strictEqual(getReleaseTargetVolume(m), null);
});

// 18. getReleaseTargetVolume gibt firstMissing für lückenhafte Serien
runTest('getReleaseTargetVolume gibt ersten fehlenden Band für lückenhafte Serien', function() {
  const m = {
    ongoing: 'true',
    total: 5,
    bands: { '1': 'owned', '2': 'owned', '4': 'owned' },
  };
  // Band 3 fehlt
  assert.strictEqual(getReleaseTargetVolume(m), 3);
});

// 19. getReleaseTargetVolume: laufende Serie ohne Lücken gibt nextBand
runTest('getReleaseTargetVolume gibt nextBand für laufende vollständige Serien', function() {
  const m = {
    ongoing: 'true',
    total: 3,
    bands: { '1': 'owned', '2': 'owned', '3': 'owned' },
  };
  // Keine Lücke, laufend → nächster Band = 4
  assert.strictEqual(getReleaseTargetVolume(m), 4);
});

// 20. getAppMode: liefert korrekten Modus
runTest('getAppMode: liefert public-readonly wenn _viewColl gesetzt', function() {
  assert.strictEqual(getAppMode('some-view', null, null), 'public-readonly');
});
runTest('getAppMode: liefert cloud-owner-edit mit collId und ownerToken', function() {
  assert.strictEqual(getAppMode(null, 'col1', 'tok1'), 'cloud-owner-edit');
});
runTest('getAppMode: liefert local-edit ohne Cloud-Parameter', function() {
  assert.strictEqual(getAppMode(null, null, null), 'local-edit');
});

// ─── Ergebnis ─────────────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);

if (_failed > 0) {
  process.exit(1);
}
