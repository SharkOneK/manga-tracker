#!/usr/bin/env node
'use strict';

/**
 * validate-release-cache-pipeline-report.js - Phase 25
 *
 * Validates data/release-cache-pipeline-report.json and enforces the safety
 * invariant: only high-confidence candidates may appear as cache patches, and
 * blocked candidates must never be represented as cache patches.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const reportPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'data', 'release-cache-pipeline-report.json');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low', 'blocked']);
let totalErrors = 0;

function fail(message) {
  console.error('  ERR ' + message);
  totalErrors++;
}

function pass(message) {
  console.log('  OK  ' + message);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateCandidateShape(item, label, requireConfidence) {
  if (!isPlainObject(item)) {
    fail(`${label} muss ein Objekt sein`);
    return;
  }
  if (!hasText(item.key)) fail(`${label}.key fehlt`);
  if (!hasText(item.seriesTitle)) fail(`${label}.seriesTitle fehlt`);
  if (!hasText(item.publisher)) fail(`${label}.publisher fehlt`);
  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) fail(`${label}.volumeNumber muss positiver Integer sein`);
  if (requireConfidence && !VALID_CONFIDENCE.has(item.confidence)) fail(`${label}.confidence ungueltig: ${item.confidence}`);
}

console.log(`\nPruefe: ${reportPath}\n`);

let report;
try {
  report = readJson(reportPath);
} catch (e) {
  fail(`Report kann nicht gelesen werden: ${e.message}`);
  process.exit(1);
}

if (!isPlainObject(report)) fail('Report muss ein JSON-Objekt sein');
else {
  if (report.schemaVersion !== 1) fail('schemaVersion muss 1 sein');
  else pass('schemaVersion: 1');

  if (!isValidIso(report.generatedAt)) fail('generatedAt muss ein valider ISO-Zeitstempel sein');
  else pass(`generatedAt: ${report.generatedAt}`);

  if (report.source !== 'run-release-cache-pipeline.js') fail('source muss run-release-cache-pipeline.js sein');

  if (!isPlainObject(report.inputs)) fail('inputs fehlt oder ist kein Objekt');
  if (!isPlainObject(report.policy)) fail('policy fehlt oder ist kein Objekt');
  if (!isPlainObject(report.summary)) fail('summary fehlt oder ist kein Objekt');
  if (!Array.isArray(report.cachePatches)) fail('cachePatches muss ein Array sein');
  if (!Array.isArray(report.reviewQueueWrites)) fail('reviewQueueWrites muss ein Array sein');
  if (!Array.isArray(report.blockedCandidates)) fail('blockedCandidates muss ein Array sein');

  if (isPlainObject(report.summary) && Array.isArray(report.cachePatches) && Array.isArray(report.reviewQueueWrites) && Array.isArray(report.blockedCandidates)) {
    const s = report.summary;
    const numericFields = [
      'candidatesDiscovered',
      'candidatesChecked',
      'skippedAlreadyCached',
      'skippedDueToLimit',
      'highConfidence',
      'mediumConfidence',
      'lowConfidence',
      'blocked',
      'cachePatches',
      'reviewQueueWrites',
      'invalidExistingCache',
    ];
    for (const field of numericFields) {
      if (!Number.isInteger(s[field]) || s[field] < 0) fail(`summary.${field} muss ein Integer >= 0 sein`);
    }

    if (s.candidatesChecked !== s.highConfidence + s.mediumConfidence + s.lowConfidence + s.blocked) {
      fail('summary.candidatesChecked passt nicht zur Summe high+medium+low+blocked');
    } else {
      pass('Confidence-Summen stimmen');
    }

    if (s.cachePatches !== report.cachePatches.length) fail('summary.cachePatches passt nicht zu cachePatches.length');
    else pass('cachePatches-Summe stimmt');

    if (s.reviewQueueWrites !== report.reviewQueueWrites.length) fail('summary.reviewQueueWrites passt nicht zu reviewQueueWrites.length');
    else pass('reviewQueueWrites-Summe stimmt');

    if (s.blocked !== report.blockedCandidates.length) fail('summary.blocked passt nicht zu blockedCandidates.length');
    else pass('blocked-Summe stimmt');

    if (s.candidatesDiscovered < s.candidatesChecked) fail('candidatesDiscovered darf nicht kleiner als candidatesChecked sein');
  }

  const blockedKeys = new Set((report.blockedCandidates || []).map(item => item && item.key).filter(Boolean));
  (report.cachePatches || []).forEach((patch, idx) => {
    const label = `cachePatches[${idx}]`;
    validateCandidateShape(patch, label, false);
    if (patch.confidence !== 'high') fail(`${label}.confidence muss high sein`);
    if (blockedKeys.has(patch.key)) fail(`${label} ist auch als blockedCandidates gelistet: ${patch.key}`);
    if (!hasText(patch.sourceUrl)) fail(`${label}.sourceUrl muss gesetzt sein`);
    if (!hasText(patch.sourceName)) fail(`${label}.sourceName muss gesetzt sein`);
  });

  (report.reviewQueueWrites || []).forEach((item, idx) => {
    const label = `reviewQueueWrites[${idx}]`;
    validateCandidateShape(item, label, true);
    if (item.confidence === 'high') fail(`${label} darf keine high-Confidence-Kandidaten enthalten`);
    if (!hasText(item.reviewStatus)) fail(`${label}.reviewStatus fehlt`);
    if (!Array.isArray(item.reasonCodes)) fail(`${label}.reasonCodes muss ein Array sein`);
  });

  (report.blockedCandidates || []).forEach((item, idx) => {
    const label = `blockedCandidates[${idx}]`;
    validateCandidateShape(item, label, true);
    if (item.confidence !== 'blocked') fail(`${label}.confidence muss blocked sein`);
  });

  if (report.autoMergeEligible === true) {
    const onlyHighPatches = (report.cachePatches || []).length > 0 && (report.cachePatches || []).every(patch => patch.confidence === 'high');
    if (!onlyHighPatches || (report.reviewQueueWrites || []).length !== 0 || (report.blockedCandidates || []).length !== 0) {
      fail('autoMergeEligible darf nur bei ausschliesslich high-Confidence Cache-Patches ohne Queue/Blocked gesetzt sein');
    } else {
      pass('autoMergeEligible ist sicher begruendet');
    }
  }
}

console.log('');
if (totalErrors > 0) {
  console.error(`Release-Cache-Pipeline-Report Validierung fehlgeschlagen - ${totalErrors} Fehler\n`);
  process.exit(1);
}

console.log('Release-Cache-Pipeline-Report Validierung bestanden\n');
process.exit(0);
