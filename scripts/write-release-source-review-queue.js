#!/usr/bin/env node
'use strict';

/**
 * write-release-source-review-queue.js - Phase 24
 *
 * Builds/updates data/release-source-review-queue.json from the machine-readable
 * Phase-23 source-gap analysis. The script intentionally does not read or write
 * data/release-cache.json and never invents release dates.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const analysisPath = path.join(repoRoot, 'docs', 'release-cache-source-gap-analysis.md');
const queuePath = path.join(repoRoot, 'data', 'release-source-review-queue.json');

const SOURCE_BLOCK_RE = /<!-- source-gap-analysis-json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- source-gap-analysis-json:end -->/;

const ANALYSIS_MANAGED_ENTRY_FIELDS = new Set([
  'queueKey',
  'seriesTitle',
  'publisher',
  'volumeNumber',
  'classification',
  'suspectedCause',
  'priority',
  'recommendedFix',
  'manualSourceReviewNeeded',
  'checkedSources',
  'sourceAnalysisEvidence',
]);

const DEFAULT_MANUAL_FIELDS = {
  safeToPatch: false,
  reviewStatus: 'pending',
  sourceUrl: null,
  releaseDate: null,
  checkedAt: null,
  evidence: '',
  notes: '',
};

const PRIORITY_ORDER = new Map([
  ['sehr hoch', 0],
  ['hoch', 1],
  ['mittel', 2],
  ['niedrig', 3],
]);

function readJsonBlock(markdownPath) {
  const doc = fs.readFileSync(markdownPath, 'utf8');
  const match = doc.match(SOURCE_BLOCK_RE);
  if (!match) {
    throw new Error(`Missing machine-readable source-gap-analysis-json block in ${path.relative(repoRoot, markdownPath)}`);
  }

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`Could not parse source-gap-analysis-json block: ${e.message}`);
  }
}

function queueKey(item) {
  return [
    String(item.seriesTitle || '').trim(),
    String(item.publisher || '').trim(),
    String(item.volumeNumber || '').trim(),
  ].join('|');
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateGapAnalysis(analysis) {
  if (!analysis || !Array.isArray(analysis.gapAnalysis)) {
    throw new Error('Source-gap analysis must contain gapAnalysis array');
  }
  if (analysis.gapAnalysis.length === 0) {
    throw new Error('Source-gap analysis must contain at least one source gap');
  }

  const seenKeys = new Set();
  analysis.gapAnalysis.forEach((item, idx) => {
    const label = `gapAnalysis[${idx}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} must be an object`);
    }
    if (!hasText(item.seriesTitle)) {
      throw new Error(`${label}.seriesTitle must be a non-empty string`);
    }
    if (!hasText(item.publisher)) {
      throw new Error(`${label}.publisher must be a non-empty string`);
    }
    if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) {
      throw new Error(`${label}.volumeNumber must be a positive integer`);
    }

    const key = queueKey(item);
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate source gap in analysis: ${key}`);
    }
    seenKeys.add(key);
  });

  return analysis.gapAnalysis;
}

function sortQueueEntries(a, b) {
  const pa = PRIORITY_ORDER.has(a.priority) ? PRIORITY_ORDER.get(a.priority) : 99;
  const pb = PRIORITY_ORDER.has(b.priority) ? PRIORITY_ORDER.get(b.priority) : 99;
  if (pa !== pb) return pa - pb;

  const titleCompare = String(a.seriesTitle).localeCompare(String(b.seriesTitle), 'de', { sensitivity: 'base' });
  if (titleCompare !== 0) return titleCompare;

  const publisherCompare = String(a.publisher).localeCompare(String(b.publisher), 'de', { sensitivity: 'base' });
  if (publisherCompare !== 0) return publisherCompare;

  return Number(a.volumeNumber) - Number(b.volumeNumber);
}

function loadExistingQueue() {
  if (!fs.existsSync(queuePath)) return { byKey: new Map(), entries: [] };

  const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const queue = Array.isArray(parsed) ? parsed : parsed.queue;
  if (!Array.isArray(queue)) {
    throw new Error('Existing release-source-review-queue JSON must contain a queue array');
  }

  const byKey = new Map();
  queue.forEach(entry => {
    byKey.set(queueKey(entry), entry);
  });
  return { byKey, entries: queue };
}

function buildEntryFromAnalysis(item, existingByKey) {
  const key = queueKey(item);
  const existing = existingByKey.get(key) || {};
  const entry = {
    queueKey: key,
    seriesTitle: item.seriesTitle,
    publisher: item.publisher,
    volumeNumber: item.volumeNumber,
    classification: item.classification,
    suspectedCause: item.suspectedCause,
    priority: item.priority,
    recommendedFix: item.recommendedFix,
    manualSourceReviewNeeded: item.manualSourceReviewNeeded,
    checkedSources: Array.isArray(item.checkedSources) ? item.checkedSources : [],
    sourceAnalysisEvidence: item.evidence || '',
    ...DEFAULT_MANUAL_FIELDS,
  };

  Object.entries(existing).forEach(([field, value]) => {
    if (!ANALYSIS_MANAGED_ENTRY_FIELDS.has(field)) {
      entry[field] = value;
    }
  });

  return entry;
}

function buildQueue() {
  const analysis = readJsonBlock(analysisPath);
  const gapAnalysis = validateGapAnalysis(analysis);

  const existing = loadExistingQueue();
  const analysisKeys = new Set(gapAnalysis.map(queueKey));
  const analysisEntries = gapAnalysis
    .map(item => buildEntryFromAnalysis(item, existing.byKey));
  const automatedEntries = existing.entries
    .filter(entry => entry && !analysisKeys.has(queueKey(entry)));
  const queue = [...analysisEntries, ...automatedEntries].sort(sortQueueEntries);

  const safeToPatchCount = queue.filter(item => item.safeToPatch === true).length;
  const pendingManualReviewCount = queue.filter(item => item.manualSourceReviewNeeded === true && item.safeToPatch !== true).length;
  const autoReviewedCount = queue.filter(item => typeof item.reviewStatus === 'string' && item.reviewStatus.startsWith('auto-')).length;
  const patchedCount = queue.filter(item => item.reviewStatus === 'patched').length;

  return {
    schemaVersion: 1,
    generatedAt: analysis.generatedAt || null,
    generatedFrom: 'docs/release-cache-source-gap-analysis.md',
    reviewPolicy: 'docs/release-cache-manual-source-review.md',
    summary: {
      knownSourceGaps: gapAnalysis.length,
      totalGaps: queue.length,
      safeToPatch: safeToPatchCount,
      pendingManualReview: pendingManualReviewCount,
      autoReviewed: autoReviewedCount,
      patched: patchedCount,
    },
    sortOrder: 'priority(sehr hoch, hoch, mittel, niedrig), seriesTitle, publisher, volumeNumber',
    queue,
  };
}

function writeJsonStable(filePath, value) {
  const json = JSON.stringify(value, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, json, 'utf8');
}

try {
  const queue = buildQueue();
  writeJsonStable(queuePath, queue);
  console.log(`Wrote ${queue.queue.length} release source review queue entries to ${path.relative(repoRoot, queuePath)}`);
} catch (e) {
  console.error(`Failed to write release source review queue: ${e.message}`);
  process.exit(1);
}
