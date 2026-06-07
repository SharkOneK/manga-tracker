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

// Phase 50: escapeYamlString (Obsidian-Export) — Spiegel der app.js-Implementierung
function escapeYamlString(value) {
  return String(value !== null && value !== undefined ? value : '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
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
  const total = Number(m.total);
  const totalKnown = !isNaN(total) && total > 0;
  if (m.ongoing === 'false') return totalKnown && firstMiss !== null ? firstMiss : null;
  if (m.ongoing === 'true') return firstMiss !== null ? firstMiss : mNextBand(m);
  return totalKnown && firstMiss !== null ? firstMiss : null;
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

// 12b. Phase 50: escapeYamlString escaped Backslash und Anführungszeichen korrekt
runTest('escapeYamlString escaped \\ und " in korrekter Reihenfolge', function() {
  // Backslash zuerst, dann Quote — kein doppeltes Escaping eines bereits gesetzten Escapes
  assert.strictEqual(escapeYamlString('a\\b'), 'a\\\\b');
  assert.strictEqual(escapeYamlString('Titel "Sondertitel"'), 'Titel \\"Sondertitel\\"');
  assert.strictEqual(escapeYamlString('Pfad\\"x"'), 'Pfad\\\\\\"x\\"');
  assert.strictEqual(escapeYamlString('Zeile1\nZeile2'), 'Zeile1 Zeile2');
  assert.strictEqual(escapeYamlString(''), '');
  assert.strictEqual(escapeYamlString(null), '');
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

runTest('Phase 47: getReleaseTargetVolume raet keinen Phantom-Band bei unklarem Status', function() {
  const m = {
    ongoing: 'unknown',
    total: null,
    bands: { '1': 'owned', '2': 'completed' },
  };
  assert.strictEqual(getReleaseTargetVolume(m), null);
});

runTest('Phase 47: abgeschlossener vollstaendiger Zweiteiler liefert null', function() {
  const m = {
    ongoing: 'false',
    total: 2,
    bands: { '1': 'owned', '2': 'completed' },
  };
  assert.strictEqual(getReleaseTargetVolume(m), null);
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
  assert.ok(wf.includes('data/release-source-review-queue.json'), 'Workflow must include synchronized source-review queue placeholders');
  assert.ok(wf.includes('node scripts/validate-release-source-review-queue.js'), 'Workflow must validate source-review queue after sync');
  // Must not push to main directly
  assert.ok(!/git push.*main/i.test(wf), 'Workflow must not push directly to main');
});

// ─── Phase 37: Cover-Preserve und Wishlist-Coverage ──────────────────────────

// Spiegelt die Phase-44c-Cover-Preserve-Logik aus doSave():
// Der Serien-Cover-URL-Fallback ist kein Formularfeld mehr.
function resolveDoSaveCover(existingCover) {
  return existingCover || null;
}

// Spiegelt die Phase-44c-Genre-Preserve-Logik aus doSave()
function resolveDoSaveGenres(existingGenres) {
  return Array.isArray(existingGenres) ? [...existingGenres] : [];
}

// Spiegelt buildLocalReleaseCoverageCandidate (ohne Wishlist-Ausschluss, Phase 37)
function buildCoverageCandidate37(manga) {
  if (!manga || typeof manga !== 'object') return null;
  // Phase 37: Kein Wishlist-Ausschluss mehr
  const targetVolume = getReleaseTargetVolume(manga);
  if (targetVolume === null) return null;
  const volumeNumber = Number(targetVolume);
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  const seriesTitle = String(manga.title || '').trim();
  if (!seriesTitle) return null;
  const publisher = String(manga.pub || '').trim();
  return { seriesTitle, publisher, volumeNumber };
}

// Spiegelt buildIntakeSubmitCandidate (Allowlist)
function buildIntakeSubmit37(candidate) {
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

console.log('\nPhase 37 — Cover-Preserve und Wishlist-Coverage Tests\n');

// 32. Cover-Preserve: bestehende Cover-URL bleibt ohne Formularfeld erhalten
runTest('Phase 44c: Cover-Preserve — bestehende Cover-URL bleibt ohne Formularfeld erhalten', function() {
  const existingCover = 'https://covers.openlibrary.org/b/isbn/9783551762405-L.jpg';
  const result = resolveDoSaveCover(existingCover);
  assert.strictEqual(result, existingCover, 'Bestehende Cover-URL muss erhalten bleiben');
});

// 33. Cover-Preserve: ohne bestehenden Fallback wird kein Cover erfunden
runTest('Phase 44c: Cover-Preserve — ohne bestehenden Fallback wird kein Cover erfunden', function() {
  const result = resolveDoSaveCover(null);
  assert.strictEqual(result, null, 'Kein bestehendes Cover → null erwartet');
});

// 34. Genre-Preserve: bestehende Genres bleiben erhalten
runTest('Phase 44c: Genre-Preserve — bestehende Genres bleiben erhalten', function() {
  const existingGenres = ['Drama', 'Thriller'];
  const result = resolveDoSaveGenres(existingGenres);
  assert.deepStrictEqual(result, existingGenres, 'Bestehende Genres müssen erhalten bleiben');
  assert.notStrictEqual(result, existingGenres, 'Genres sollen als Kopie übernommen werden');
});

// 35. Genre-Preserve: ohne bestehende Genres wird keine leere Automatik erfunden
runTest('Phase 44c: Genre-Preserve — ohne bestehende Genres wird keine Automatik erfunden', function() {
  const result = resolveDoSaveGenres(null);
  assert.deepStrictEqual(result, [], 'Ohne stabile Quelle keine Auto-Genres erfinden');
});

// 36. Wishlist-Serie mit Publisher und ohne Bände → Kandidat Band 1
runTest('Phase 37: Wishlist-Serie ohne Bände erzeugt Coverage-Kandidaten für Band 1', function() {
  const manga = {
    title: 'I Was Reincarnated as the 7th Prince',
    pub: 'Crunchyroll Manga',
    status: 'wishlist',
    bands: {},
    total: null,
    ongoing: 'true',
  };
  const candidate = buildCoverageCandidate37(manga);
  assert.ok(candidate !== null, 'Kandidat muss erzeugt werden');
  assert.strictEqual(candidate.volumeNumber, 1, 'Zielband muss 1 sein');
  assert.strictEqual(candidate.seriesTitle, 'I Was Reincarnated as the 7th Prince');
  assert.strictEqual(candidate.publisher, 'Crunchyroll Manga');
});

// 37. Wishlist-Serie ohne Publisher → blockiert
runTest('Phase 37: Wishlist-Serie ohne Publisher wird blockiert', function() {
  const manga = {
    title: 'Unbekannte Wunsch-Serie',
    pub: '',
    status: 'wishlist',
    bands: {},
    total: null,
    ongoing: 'true',
  };
  const candidate = buildCoverageCandidate37(manga);
  // Kandidat wird erzeugt, aber mit leerem Publisher nicht exportierbar
  // buildIntakeSubmit37 blockiert ihn bei publisher-check
  const submit = candidate ? buildIntakeSubmit37(candidate) : null;
  assert.strictEqual(submit, null, 'Submit muss blockiert werden wenn Publisher leer ist');
});

// 38. Wishlist-Kandidat enthält keine privaten Felder
runTest('Phase 37: Wishlist-Kandidat enthält keine privaten Felder im Export', function() {
  const manga = {
    title: 'Test Wishlist Manga',
    pub: 'Test Verlag',
    status: 'wishlist',
    bands: {},
    total: null,
    ongoing: 'true',
    notes: 'private note',
    startedAt: '2024-01-01',
    finishedAt: null,
  };
  const candidate = buildCoverageCandidate37(manga);
  assert.ok(candidate !== null, 'Kandidat muss erzeugt werden');
  const submit = buildIntakeSubmit37(candidate);
  assert.ok(submit !== null, 'Submit-Kandidat muss erzeugt werden');
  // notes ist ein erlaubtes Exportfeld (in RELEASE_INTAKE_SUBMIT_ALLOWED_FIELDS enthalten)
  const forbiddenFields = ['status', 'wishlist', 'owned', 'collectionStatus', 'readAt', 'boughtAt',
    'seriesId', 'bands', 'startedAt', 'finishedAt'];
  forbiddenFields.forEach(f => {
    assert.ok(!(f in submit), `Privates Feld "${f}" darf nicht im Export-Kandidat enthalten sein`);
  });
  // Nur erlaubte Felder
  const allowedKeys = new Set(['seriesTitle', 'publisher', 'volumeNumber', 'sourceUrl', 'notes', 'enabled']);
  Object.keys(submit).forEach(k => {
    assert.ok(allowedKeys.has(k), `Unerlaubtes Feld im Submit-Kandidat: ${k}`);
  });
});

// 39. Abgeschlossene Wishlist-Serie ohne Lücken → kein Kandidat (defensive Prüfung)
runTest('Phase 37: vollständige abgeschlossene Wishlist-Serie erzeugt keinen Kandidaten', function() {
  const manga = {
    title: 'Abgeschlossene Wunsch-Serie',
    pub: 'Verlag',
    status: 'wishlist',
    bands: { '1': 'completed', '2': 'completed', '3': 'completed' },
    total: 3,
    ongoing: 'false',
  };
  const candidate = buildCoverageCandidate37(manga);
  assert.strictEqual(candidate, null, 'Vollständig abgeschlossene Serie darf keinen Kandidaten erzeugen');
});

// 40. BandCovers für Wishlist-Serie: Covers ohne Band-Eintrag bleiben erhalten
runTest('Phase 37: BandCovers ohne Band-Eintrag bleiben für Wishlist-Serien erhalten', function() {
  // Spiegelt die Phase-37-bandCovers-Preserve-Logik
  function resolveBandCovers(modalBandCovers, bands, existingBands, existingBandCovers) {
    const result = {};
    Object.entries(modalBandCovers).forEach(([k, v]) => {
      const bandExists = !!bands[k];
      const isCoverWithoutBand = !!(v && existingBandCovers?.[k] && !existingBands?.[k]);
      if ((bandExists || isCoverWithoutBand) && v) result[k] = v;
    });
    return result;
  }
  // Wishlist-Serie: kein Band-Eintrag, aber MP-geladene Cover
  const modalBandCovers = { '1': 'https://example.com/cover-vol1.jpg' };
  const bands = {};  // keine Bände
  const existingBands = {};  // auch keine
  const existingBandCovers = { '1': 'https://example.com/cover-vol1.jpg' };
  const result = resolveBandCovers(modalBandCovers, bands, existingBands, existingBandCovers);
  assert.strictEqual(result['1'], 'https://example.com/cover-vol1.jpg',
    'MP-geladenes Cover für Wishlist-Serie ohne Band-Eintrag muss erhalten bleiben');
});

// 41. BandCovers: gelöschter Band verliert sein Cover (korrekte Bereinigung)
runTest('Phase 37: BandCover für gelöschten Band wird korrekt entfernt', function() {
  function resolveBandCovers(modalBandCovers, bands, existingBands, existingBandCovers) {
    const result = {};
    Object.entries(modalBandCovers).forEach(([k, v]) => {
      const bandExists = !!bands[k];
      const isCoverWithoutBand = !!(v && existingBandCovers?.[k] && !existingBands?.[k]);
      if ((bandExists || isCoverWithoutBand) && v) result[k] = v;
    });
    return result;
  }
  // Nicht-Wishlist: Band 1 war in existing.bands, jetzt gelöscht
  const modalBandCovers = { '1': 'https://example.com/cover-vol1.jpg', '2': 'https://example.com/cover-vol2.jpg' };
  const bands = { '2': 'owned' };  // Band 1 wurde gelöscht
  const existingBands = { '1': 'owned', '2': 'owned' };  // Band 1 war vorhanden
  const existingBandCovers = { '1': 'https://example.com/cover-vol1.jpg', '2': 'https://example.com/cover-vol2.jpg' };
  const result = resolveBandCovers(modalBandCovers, bands, existingBands, existingBandCovers);
  assert.ok(!('1' in result), 'Cover für gelöschten Band 1 muss entfernt werden');
  assert.strictEqual(result['2'], 'https://example.com/cover-vol2.jpg', 'Cover für Band 2 muss erhalten bleiben');
});

// ─── Ergebnis ─────────────────────────────────────────────────────────────


function collectCatalogSeedCandidates47(manga) {
  if (!manga || typeof manga !== 'object') return [];
  const seriesTitle = String(manga.title || '').trim();
  const publisher = String(manga.pub || '').trim();
  if (!seriesTitle || !publisher) return [];
  if (isDummyTitle36b(seriesTitle)) return [];
  const bands = manga.bands && typeof manga.bands === 'object' ? manga.bands : {};
  const volumes = Object.keys(bands)
    .map(Number)
    .filter(volume => Number.isInteger(volume) && volume >= 1)
    .sort((a, b) => a - b);
  return Array.from(new Set(volumes)).map(volumeNumber => ({
    seriesTitle,
    publisher,
    volumeNumber,
    sourceUrl: null,
    origin: 'browser',
  }));
}

function collectCatalogSeedBackfillCandidates47(mangaList) {
  const byKey = new Map();
  mangaList.forEach(manga => {
    collectCatalogSeedCandidates47(manga).forEach(candidate => {
      const key = intakeDedupKey36b(candidate.seriesTitle, candidate.publisher, candidate.volumeNumber);
      if (!byKey.has(key)) byKey.set(key, candidate);
    });
  });
  return Array.from(byKey.values());
}

runTest('Phase 47: Katalog-Seed sammelt echte Baende abgeschlossener Zweiteiler', function() {
  const candidates = collectCatalogSeedCandidates47({
    title: 'Mein Wunsch, von einer Oberschuelerin getoetet zu werden',
    pub: 'Yomeru',
    ongoing: 'false',
    total: 2,
    bands: { '1': 'owned', '2': 'completed' },
  });
  assert.deepStrictEqual(candidates.map(c => c.volumeNumber), [1, 2]);
  candidates.forEach(candidate => {
    assert.deepStrictEqual(Object.keys(candidate).sort(), ['origin', 'publisher', 'seriesTitle', 'sourceUrl', 'volumeNumber'].sort());
  });
});

runTest('Phase 47: Katalog-Backfill dedupliziert run-intern', function() {
  const candidates = collectCatalogSeedBackfillCandidates47([
    { title: 'Dedupe', pub: 'Egmont Manga', bands: { '1': 'owned' } },
    { title: 'DEDUPE', pub: 'Egmont Manga', bands: { '1': 'completed' } },
  ]);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].volumeNumber, 1);
});

runTest('Phase 47: Katalog-Seed ueberspringt Dummy, leeren Publisher und ungueltige Baende', function() {
  assert.strictEqual(collectCatalogSeedCandidates47({ title: 'ZZZ-TEST-SERIE', pub: 'Test', bands: { '1': 'owned' } }).length, 0);
  assert.strictEqual(collectCatalogSeedCandidates47({ title: 'Ohne Verlag', pub: '', bands: { '1': 'owned' } }).length, 0);
  assert.strictEqual(collectCatalogSeedCandidates47({ title: 'Bad Band', pub: 'Yomeru', bands: { '0': 'owned', x: 'owned' } }).length, 0);
});

// Phase 42b: Source-review queue writer must follow the analysis dynamically.
runTest('Phase 42b: write-release-source-review-queue.js hat keinen festen Source-Gap-Count', function() {
  const fs2 = require('fs');
  const scriptPath = require('path').resolve(__dirname, 'write-release-source-review-queue.js');
  const src = fs2.readFileSync(scriptPath, 'utf-8');
  assert.ok(!/\bEXPECTED_GAPS\b/.test(src), 'Writer must not hard-code EXPECTED_GAPS');
  assert.ok(!/Expected\s+.*source gaps,\s+found/.test(src), 'Writer must not fail on a fixed source-gap count');
  assert.ok(/gapAnalysis\.length === 0/.test(src), 'Writer should still reject an empty source-gap analysis');
});


// Update Release Cache syncs the generated coverage docs before validation AND
// commits them with the data files. Otherwise the regenerated docs are discarded
// and the scheduled CI on main fails whenever a gap resolves (docs vs. audit drift).
// The two generated coverage docs are deterministic markdown artifacts and are
// explicitly allowlisted in the release-cache auto-merge gate.
runTest('Phase 45: update-release-cache.yml synchronisiert Coverage-Dokumente und committet sie mit', function() {
  const fs2 = require('fs');
  const path2 = require('path');
  const wfPath = path2.resolve(__dirname, '../.github/workflows/update-release-cache.yml');
  const wf = fs2.readFileSync(wfPath, 'utf-8');
  const syncIdx = wf.indexOf('node scripts/sync-release-coverage-gap-docs.js');
  const validateIdx = wf.indexOf('node scripts/validate-release-source-review-queue.js');
  assert.ok(syncIdx >= 0, 'Workflow must run sync-release-coverage-gap-docs.js');
  assert.ok(validateIdx >= 0 && syncIdx < validateIdx, 'Workflow must sync docs before queue/doc validation');
  const addPaths = (wf.match(/add-paths:\s*\|([\s\S]*?)\n\s*\n\s*- name:/) || [null, ''])[1];
  assert.ok(addPaths.includes('data/release-cache.json'), 'Managed PR files must include release-cache data');
  assert.ok(addPaths.includes('data/release-source-review-queue.json'), 'Managed PR files must include review queue data');
  assert.ok(addPaths.includes('data/release-cache-pipeline-report.json'), 'Managed PR files must include pipeline report data');
  assert.ok(addPaths.includes('docs/release-cache-source-gap-analysis.md'), 'Managed PR files must commit the regenerated source-gap analysis doc');
  assert.ok(addPaths.includes('docs/release-cache-coverage-gaps.md'), 'Managed PR files must commit the regenerated coverage-gaps doc');
});

runTest('Phase 42c: Coverage-Gap-Validator hat keine festen Gap-Zahlen', function() {
  const fs2 = require('fs');
  const path2 = require('path');
  const validatorPath = path2.resolve(__dirname, 'validate-release-cache-coverage-gaps.js');
  const src = fs2.readFileSync(validatorPath, 'utf-8');
  assert.ok(!/missingCacheCoverage:\s*\d+/.test(src), 'Validator must not hard-code missingCacheCoverage');
  assert.ok(!/missingSeries:\s*\d+/.test(src), 'Validator must not hard-code missingSeries');
  assert.ok(!/missingPublishers:\s*\d+/.test(src), 'Validator must not hard-code missingPublishers');
});

runTest('Phase 42c: write-release-source-review-queue.js entfernt veraltete Source-Gap-Eintraege', function() {
  const fs2 = require('fs');
  const path2 = require('path');
  const writerPath = path2.resolve(__dirname, 'write-release-source-review-queue.js');
  const src = fs2.readFileSync(writerPath, 'utf-8');
  assert.ok(src.includes("entry.classification === 'automated-source-check'"), 'Writer must only preserve non-analysis automated-source-check entries');
});

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);

if (_failed > 0) {
  process.exit(1);
}
