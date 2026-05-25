#!/usr/bin/env node
'use strict';

/**
 * validate-release-source-review-queue.js - Phase 24
 *
 * Validates the manual source-review queue for known release-cache source gaps.
 * The queue is allowed to mark a gap safeToPatch only after a reviewer records
 * sourceUrl, releaseDate, checkedAt, and evidence. Placeholder dates remain
 * invalid. This script does not read or write data/release-cache.json.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const analysisPath = path.join(repoRoot, 'docs', 'release-cache-source-gap-analysis.md');
const queuePath = path.join(repoRoot, 'data', 'release-source-review-queue.json');

const SOURCE_BLOCK_RE = /<!-- source-gap-analysis-json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- source-gap-analysis-json:end -->/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_OR_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const PLACEHOLDER_RELEASE_DATES = new Set([
  '2999-12-31',
  '9999-12-31',
  '2099-12-31',
  '0000-00-00',
]);
const ALLOWED_REVIEW_STATUS = new Set([
  'pending',
  'in-review',
  'needs-second-source',
  'ready-to-patch',
  'rejected',
  'auto-blocked',
  'auto-source-missing',
  'auto-not-yet-released',
  'auto-medium-confidence',
  'auto-low-confidence',
  'auto-ready-to-patch',
  'patched',
  'verified',
  'deferred',
  'needs-source',
]);

const REQUIRED_ENTRY_FIELDS = [
  'seriesTitle',
  'publisher',
  'volumeNumber',
  'suspectedCause',
  'priority',
  'recommendedFix',
  'manualSourceReviewNeeded',
  'safeToPatch',
  'reviewStatus',
  'sourceUrl',
  'releaseDate',
  'checkedAt',
  'evidence',
  'notes',
];

let totalErrors = 0;
function pass(message) { console.log('  OK  ' + message); }
function fail(message) { console.error('  ERR ' + message); totalErrors++; }

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function queueKey(item) {
  return [
    String(item.seriesTitle || '').trim(),
    String(item.publisher || '').trim(),
    String(item.volumeNumber || '').trim(),
  ].join('|');
}

function readSourceGapAnalysis() {
  const doc = fs.readFileSync(analysisPath, 'utf8');
  const match = doc.match(SOURCE_BLOCK_RE);
  if (!match) throw new Error('source-gap-analysis-json block fehlt');
  return JSON.parse(match[1]);
}

function validateDateString(value, label, required) {
  if (value === null || value === '') {
    if (required) fail(`${label} muss gesetzt sein`);
    return;
  }
  if (!hasText(value)) {
    fail(`${label} muss null oder ein String sein`);
    return;
  }
  if (!ISO_DATE_RE.test(value)) {
    fail(`${label} muss im Format YYYY-MM-DD vorliegen`);
    return;
  }
  if (PLACEHOLDER_RELEASE_DATES.has(value)) {
    fail(`${label} darf kein Platzhalterdatum sein: ${value}`);
    return;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail(`${label} ist kein valides Datum: ${value}`);
  }
}

function validateCheckedAt(value, label, required) {
  if (value === null || value === '') {
    if (required) fail(`${label} muss gesetzt sein`);
    return;
  }
  if (!hasText(value)) {
    fail(`${label} muss null oder ein String sein`);
    return;
  }
  if (!ISO_DATE_OR_DATETIME_RE.test(value)) {
    fail(`${label} muss ISO-aehnlich sein (YYYY-MM-DD oder ISO-Zeitstempel)`);
  }
}

function validateUrl(value, label, required) {
  if (value === null || value === '') {
    if (required) fail(`${label} muss gesetzt sein`);
    return;
  }
  if (!hasText(value)) {
    fail(`${label} muss null oder ein String sein`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    fail(`${label} ist keine valide URL`);
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`${label} muss http(s) verwenden`);
  }
}

function validateAnalysis(analysis) {
  if (!isPlainObject(analysis)) {
    fail('Source-Gap-Analyse muss ein JSON-Objekt sein');
    return [];
  }
  if (analysis.schemaVersion !== 1) fail('Source-Gap-Analyse schemaVersion muss 1 sein');
  if (!Array.isArray(analysis.gapAnalysis)) {
    fail('Source-Gap-Analyse muss gapAnalysis als Array enthalten');
    return [];
  }
  if (analysis.gapAnalysis.length === 0) {
    fail('Source-Gap-Analyse muss mindestens einen bekannten Gap enthalten');
  }
  return analysis.gapAnalysis;
}

function validateQueueDocument(doc, expectedGapCount) {
  if (!isPlainObject(doc)) {
    fail('Review-Queue muss ein JSON-Objekt sein');
    return [];
  }
  if (doc.schemaVersion !== 1) fail('Review-Queue schemaVersion muss 1 sein');
  if (!Array.isArray(doc.queue)) {
    fail('Review-Queue muss queue als Array enthalten');
    return [];
  }
  if (doc.queue.length < expectedGapCount) {
    fail(`Review-Queue muss mindestens ${expectedGapCount} bekannte Gaps enthalten, gefunden ${doc.queue.length}`);
  }
  if (!doc.summary || typeof doc.summary !== 'object') fail('Review-Queue summary fehlt');
  else {
    if (doc.summary.totalGaps !== doc.queue.length) fail('summary.totalGaps passt nicht zu queue.length');
    if (doc.summary.knownSourceGaps !== undefined && doc.summary.knownSourceGaps !== expectedGapCount) {
      fail(`summary.knownSourceGaps muss ${expectedGapCount} sein`);
    }
  }
  return doc.queue;
}

function validateEntry(entry, idx, expectedKeys, seenKeys) {
  const label = `queue[${idx}]`;
  if (!isPlainObject(entry)) {
    fail(`${label} muss ein Objekt sein`);
    return;
  }

  REQUIRED_ENTRY_FIELDS.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) fail(`${label}.${field} fehlt`);
  });

  const key = queueKey(entry);
  if (seenKeys.has(key)) fail(`${label} ist doppelt vorhanden: ${key}`);
  seenKeys.add(key);
  if (!expectedKeys.has(key) && entry.classification !== 'automated-source-check') {
    fail(`${label} gehoert nicht zu den bekannten Source-Gaps oder automatischen Checks: ${key}`);
  }

  if (!hasText(entry.seriesTitle)) fail(`${label}.seriesTitle muss ein nicht-leerer String sein`);
  if (!hasText(entry.publisher)) fail(`${label}.publisher muss ein nicht-leerer String sein`);
  if (!Number.isInteger(entry.volumeNumber) || entry.volumeNumber < 1) fail(`${label}.volumeNumber muss ein positiver Integer sein`);
  if (!hasText(entry.suspectedCause)) fail(`${label}.suspectedCause muss gesetzt sein`);
  if (!hasText(entry.priority)) fail(`${label}.priority muss gesetzt sein`);
  if (entry.recommendedFix !== 'manual-source-review') fail(`${label}.recommendedFix muss manual-source-review sein`);
  if (entry.manualSourceReviewNeeded !== true) fail(`${label}.manualSourceReviewNeeded muss true sein`);
  if (typeof entry.safeToPatch !== 'boolean') fail(`${label}.safeToPatch muss boolean sein`);
  if (!ALLOWED_REVIEW_STATUS.has(entry.reviewStatus)) fail(`${label}.reviewStatus ist ungueltig: ${entry.reviewStatus}`);

  const safe = entry.safeToPatch === true;
  validateUrl(entry.sourceUrl, `${label}.sourceUrl`, safe);
  validateDateString(entry.releaseDate, `${label}.releaseDate`, safe);
  validateCheckedAt(entry.checkedAt, `${label}.checkedAt`, safe);

  if (entry.evidence !== null && typeof entry.evidence !== 'string') fail(`${label}.evidence muss ein String sein`);
  if (entry.notes !== null && typeof entry.notes !== 'string') fail(`${label}.notes muss ein String sein`);

  if (safe) {
    if (!hasText(entry.sourceUrl)) fail(`${label}.safeToPatch=true verlangt sourceUrl`);
    if (!hasText(entry.releaseDate)) fail(`${label}.safeToPatch=true verlangt releaseDate`);
    if (!hasText(entry.checkedAt)) fail(`${label}.safeToPatch=true verlangt checkedAt`);
    if (!hasText(entry.evidence)) fail(`${label}.safeToPatch=true verlangt evidence`);
    if (
      entry.reviewStatus !== 'ready-to-patch' &&
      entry.reviewStatus !== 'auto-ready-to-patch' &&
      entry.reviewStatus !== 'patched' &&
      entry.reviewStatus !== 'verified'
    ) {
      fail(`${label}.safeToPatch=true verlangt reviewStatus ready-to-patch, auto-ready-to-patch, verified oder patched`);
    }
  }
}

console.log('\nPruefe: Release-Cache Manual Source Review Queue (Phase 24)\n');

let analysisItems = [];
try {
  analysisItems = validateAnalysis(readSourceGapAnalysis());
  if (totalErrors === 0) pass('Source-Gap-Analyse ist parsebar');
} catch (e) {
  fail(`Source-Gap-Analyse kann nicht gelesen werden: ${e.message}`);
}

let queueItems = [];
try {
  const queueDoc = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  queueItems = validateQueueDocument(queueDoc, analysisItems.length);
  if (totalErrors === 0) pass('Review-Queue JSON ist parsebar');
} catch (e) {
  fail(`Review-Queue kann nicht gelesen werden: ${e.message}`);
}

const expectedKeys = new Set(analysisItems.map(queueKey));
const seenKeys = new Set();
queueItems.forEach((entry, idx) => validateEntry(entry, idx, expectedKeys, seenKeys));
expectedKeys.forEach(key => {
  if (!seenKeys.has(key)) fail(`Review-Queue fehlt bekannter Gap: ${key}`);
});

const safeToPatchCount = queueItems.filter(entry => entry && entry.safeToPatch === true).length;
if (safeToPatchCount > 0) {
  pass(`${safeToPatchCount} Eintraege sind nach manueller Quellenpruefung als safeToPatch markiert`);
} else if (totalErrors === 0) {
  pass('Alle bekannten Gaps bleiben bis zur manuellen Quellenpruefung safeToPatch=false');
}

console.log('');
if (totalErrors > 0) {
  console.error(`Release Source Review Queue Validierung fehlgeschlagen - ${totalErrors} Fehler\n`);
  process.exit(1);
}

console.log('Release Source Review Queue Validierung bestanden\n');
process.exit(0);
