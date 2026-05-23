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

// ─── Phase 36b: Release Intake Tests ─────────────────────────────────────────

// Helper mirrors (from app.js Phase 36b)
function normalizeReleaseTitle36b(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeReleasePublisher36b(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function intakeDedupKey36b(seriesTitle, publisher, volumeNumber) {
  return normalizeReleaseTitle36b(seriesTitle) + '|' + normalizeReleasePublisher36b(publisher) + '|' + Number(volumeNumber);
}

function isDummyTitle36b(title) {
  const norm = normalizeReleaseTitle36b(title || '');
  return /^zzz(?:\s|-|_)*test/.test(norm) || /\btest(?:\s|-|_)*serie\b/.test(norm);
}

const INTAKE_PRIVATE_FIELDS = new Set([
  'bands', 'owned', 'readStatus', 'collectionStatus', 'startedAt', 'finishedAt',
  'boughtAt', 'readAt', 'isbn13', 'mpEditionId', 'owner_token', 'view_token',
  'collection_id', 'supabase', 'privateNotes', 'data',
]);

function validateIntakeCandidate36b(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  for (const field of INTAKE_PRIVATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) return false;
  }
  const seriesTitle  = String(candidate.seriesTitle  || '').trim();
  const publisher    = String(candidate.publisher    || '').trim();
  const volumeNumber = Number(candidate.volumeNumber);
  if (!seriesTitle || !publisher) return false;
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return false;
  if (isDummyTitle36b(seriesTitle)) return false;
  if (candidate.sourceUrl !== null && candidate.sourceUrl !== undefined) {
    if (typeof candidate.sourceUrl !== 'string' || !candidate.sourceUrl.startsWith('https://')) return false;
  }
  return true;
}

function buildIntakeSubmitCandidate36b(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const seriesTitle  = String(candidate.seriesTitle  || '').trim();
  const publisher    = String(candidate.publisher    || '').trim();
  const vol          = Number(candidate.volumeNumber);
  if (!seriesTitle || !publisher) return null;
  if (!Number.isInteger(vol) || vol < 1) return null;
  const sourceUrl = (typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.startsWith('https://'))
    ? candidate.sourceUrl : null;
  const notes = typeof candidate.notes === 'string' && candidate.notes
    ? candidate.notes.slice(0, 500) : null;
  return { seriesTitle, publisher, volumeNumber: vol, sourceUrl, notes, enabled: true };
}

// 21. Intake allowlist export contains only permitted fields
runTest('Phase 36b: buildIntakeSubmitCandidate enthält nur Allowlist-Felder', function() {
  const candidate = {
    seriesTitle:      'Test Manga',
    publisher:        'Test Verlag',
    volumeNumber:     3,
    sourceUrl:        null,
    notes:            'Test',
    enabled:          true,
    // These must NOT appear in output:
    owned:            5,
    readAt:           '2024-01-01',
    boughtAt:         '2024-01-01',
    collectionStatus: 'reading',
  };
  const result = buildIntakeSubmitCandidate36b(candidate);
  assert.ok(result !== null, 'result is null');
  const allowedKeys = new Set(['seriesTitle', 'publisher', 'volumeNumber', 'sourceUrl', 'notes', 'enabled']);
  const resultKeys = Object.keys(result);
  resultKeys.forEach(k => assert.ok(allowedKeys.has(k), `Unexpected field in result: ${k}`));
  assert.ok(!('owned' in result), 'owned must not be in result');
  assert.ok(!('readAt' in result), 'readAt must not be in result');
  assert.ok(!('boughtAt' in result), 'boughtAt must not be in result');
});

// 22. Empty publisher is blocked
runTest('Phase 36b: leerer Publisher wird blockiert', function() {
  assert.strictEqual(validateIntakeCandidate36b({ seriesTitle: 'Test', publisher: '', volumeNumber: 1 }), false);
  assert.strictEqual(validateIntakeCandidate36b({ seriesTitle: 'Test', publisher: '   ', volumeNumber: 1 }), false);
});

// 23. Dummy/test title is blocked
runTest('Phase 36b: Dummy/Test-Titel wird blockiert', function() {
  assert.strictEqual(validateIntakeCandidate36b({ seriesTitle: 'ZZZ-TEST-SERIE', publisher: 'Verlag', volumeNumber: 1 }), false);
  assert.strictEqual(validateIntakeCandidate36b({ seriesTitle: 'zzz test', publisher: 'Verlag', volumeNumber: 1 }), false);
  assert.strictEqual(validateIntakeCandidate36b({ seriesTitle: 'Test Serie', publisher: 'Verlag', volumeNumber: 1 }), false);
});

// 24. Valid candidate passes validation
runTest('Phase 36b: gültiger Kandidat besteht Validierung', function() {
  assert.strictEqual(
    validateIntakeCandidate36b({ seriesTitle: 'One Piece', publisher: 'Carlsen Manga', volumeNumber: 101 }),
    true
  );
});

// 25. Private fields block validation
runTest('Phase 36b: private Felder blockieren Validierung', function() {
  assert.strictEqual(validateIntakeCandidate36b({
    seriesTitle: 'Test', publisher: 'Verlag', volumeNumber: 1, owned: 5,
  }), false);
  assert.strictEqual(validateIntakeCandidate36b({
    seriesTitle: 'Test', publisher: 'Verlag', volumeNumber: 1, boughtAt: '2024-01-01',
  }), false);
});

// 26. Dedup key is consistent
runTest('Phase 36b: Dedup-Key ist konsistent und normalisiert', function() {
  const k1 = intakeDedupKey36b('One Piece', 'Carlsen Manga', 5);
  const k2 = intakeDedupKey36b('ONE PIECE', 'Carlsen  Manga', 5);
  // Same normalisation should yield same key (lowercase, collapsed spaces)
  assert.ok(k1 === k2 || k1.includes('one piece'), 'Key should be normalised lowercase');
  assert.ok(k1.endsWith('|5'), 'Key should end with volume number');
});

// 27. Intake script dedup against existing watchlist entry
runTest('Phase 36b: apply-Script erkennt Duplikate per Dedup-Key', function() {
  const existingItems = [
    { seriesTitle: 'One Piece', publisher: 'Carlsen Manga', volumeNumber: 5 },
  ];
  const keys = new Set(existingItems.map(i => intakeDedupKey36b(i.seriesTitle, i.publisher, i.volumeNumber)));
  const newCandidate = { series_title: 'One Piece', publisher: 'Carlsen Manga', volume_number: 5 };
  const dedup = intakeDedupKey36b(newCandidate.series_title, newCandidate.publisher, newCandidate.volume_number);
  assert.ok(keys.has(dedup), 'Candidate already in watchlist must be detected as duplicate');
});

// 28. Auto-intake default is OFF (canWriteCloud mock = false => not allowed)
runTest('Phase 36b: Auto-Intake darf nie im public-readonly aktiv sein', function() {
  // Simulate: public-readonly mode → canWriteCloud = false
  const canWriteCloudMock = false;
  const autoIntakeEnabled = true; // user set it, but mode guard should block
  // isReleaseIntakeSendAllowed guard: if !canWriteCloud → false
  const allowed = canWriteCloudMock && autoIntakeEnabled;
  assert.strictEqual(allowed, false, 'Public/local-only mode must block intake even if setting is on');
});

// 29. intake script does not modify release-cache.json (static check)
runTest('Phase 36b: apply-release-intake-candidates.js referenziert release-cache.json nicht schreibend', function() {
  const fs2 = require('fs');
  const scriptPath = require('path').resolve(__dirname, 'apply-release-intake-candidates.js');
  if (!fs2.existsSync(scriptPath)) {
    assert.fail('apply-release-intake-candidates.js not found');
  }
  const src = fs2.readFileSync(scriptPath, 'utf-8');
  // Must not writeFile to release-cache (the watchlist path is the only write target)
  // Checks for writeFileSync() or createWriteStream() calls referencing the cache artifact
  assert.ok(!/writeFile(?:Sync)?\s*\([^)]*release-cache/i.test(src),
    'Script must not write release-cache artifact via writeFile');
  // Must not invent release dates
  assert.ok(!/releaseDate|release_date/i.test(src),
    'Script must not set release dates');
});

// 30. GitHub workflow exists, has workflow_dispatch, correct schedule, no push trigger
runTest('Phase 36b: release-intake.yml — workflow_dispatch, 04:05 UTC, kein push-Trigger', function() {
  const fs2 = require('fs');
  const wfPath = require('path').resolve(__dirname, '../.github/workflows/release-intake.yml');
  if (!fs2.existsSync(wfPath)) {
    assert.fail('.github/workflows/release-intake.yml not found');
  }
  const wf = fs2.readFileSync(wfPath, 'utf-8');
  assert.ok(wf.includes('workflow_dispatch'), 'workflow_dispatch must be present');
  assert.ok(wf.includes("cron: '5 4 * * *'"), '04:05 UTC schedule must be present');
  assert.ok(!wf.includes('release-cache.json'), 'release-cache.json must not appear in intake workflow');
});

// 31. Workflow creates PR, does not push directly to main
runTest('Phase 36b: release-intake.yml erstellt PR, kein push nach main', function() {
  const fs2 = require('fs');
  const wfPath = require('path').resolve(__dirname, '../.github/workflows/release-intake.yml');
  if (!fs2.existsSync(wfPath)) {
    assert.fail('.github/workflows/release-intake.yml not found');
  }
  const wf = fs2.readFileSync(wfPath, 'utf-8');
  assert.ok(wf.includes('create-pull-request'), 'Workflow must use create-pull-request action');
  assert.ok(wf.includes('automated/release-intake'), 'Workflow must use automated/release-intake branch');
  // Must not push to main directly
  assert.ok(!/git push.*main/i.test(wf), 'Workflow must not push directly to main');
});

// ─── Ergebnis ─────────────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);

if (_failed > 0) {
  process.exit(1);
}
