#!/usr/bin/env node
'use strict';

/**
 * Phase 43 validator for public German release volume counts.
 *
 * The file is intentionally public-only. It may contain the technical German
 * publication count for a series, but never private collection/owner fields.
 */

const fs = require('fs');
const path = require('path');
const { isAllowedSourceUrl, isValidHttpUrl } = require('./release-confidence');

const repoRoot = path.resolve(__dirname, '..');
const defaultFile = path.join(repoRoot, 'data', 'release-volume-counts.json');
const sourcesFile = path.join(repoRoot, 'data', 'release-sources.json');

const ALLOWED_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'generatedAt', 'items']);
const ALLOWED_ITEM_KEYS = new Set([
  'seriesTitle',
  'publisher',
  'publishedVolumesDE',
  'source',
  'sourceUrl',
  'confidence',
  'checkedAt',
]);
const FORBIDDEN_KEYS = new Set([
  'notes',
  'startedAt',
  'finishedAt',
  'owner_token',
  'ownerToken',
  'owner_hash',
  'ownerHash',
  'owner_token_hash',
  'ownerTokenHash',
  'view_token',
  'viewToken',
  'view_token_hash',
  'isbn13',
  'mpEditionId',
  'bands',
  'owned',
  'current',
  'status',
  'readStatus',
  'collectionStatus',
  'boughtAt',
  'readAt',
  'privateNotes',
  'supabaseId',
]);
const FORBIDDEN_VALUE_PATTERNS = [
  /owner[_-]?token/i,
  /supabase[_-]?(?:service[_-]?role|owner)/i,
  /private\s+data/i,
  /lesestatus/i,
  /besitzstatus/i,
  /lokale\s+notizen/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isIsoDateTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function fail(errors, message) {
  errors.push(message);
}

function walkForbidden(value, errors, pathLabel = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForbidden(item, errors, `${pathLabel}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail(errors, `${pathLabel}.${key}: forbidden private key`);
      walkForbidden(nested, errors, `${pathLabel}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) fail(errors, `${pathLabel}: forbidden private/secret-looking value`);
    }
  }
}

function validateReleaseVolumeCounts(doc, { sources = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['document must be a JSON object'], warnings };
  }

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) fail(errors, `top-level key not allowed: ${key}`);
  }
  walkForbidden(doc, errors);

  if (doc.schemaVersion !== 1) fail(errors, 'schemaVersion must be 1');
  if (!isIsoDateTime(doc.generatedAt)) fail(errors, 'generatedAt must be an ISO timestamp');
  if (!Array.isArray(doc.items)) fail(errors, 'items must be an array');

  const seen = new Set();
  const items = Array.isArray(doc.items) ? doc.items : [];
  items.forEach((item, index) => {
    const prefix = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(errors, `${prefix} must be an object`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) fail(errors, `${prefix}.${key}: key is not allowlisted`);
    }
    if (typeof item.seriesTitle !== 'string' || !item.seriesTitle.trim()) fail(errors, `${prefix}.seriesTitle must be non-empty string`);
    if (typeof item.publisher !== 'string' || !item.publisher.trim()) fail(errors, `${prefix}.publisher must be non-empty string`);
    if (!Number.isInteger(item.publishedVolumesDE) || item.publishedVolumesDE < 0 || item.publishedVolumesDE > 300) {
      fail(errors, `${prefix}.publishedVolumesDE must be integer 0..300`);
    }
    if (typeof item.source !== 'string' || !item.source.trim()) fail(errors, `${prefix}.source must be non-empty string`);
    if (!isValidHttpUrl(item.sourceUrl)) fail(errors, `${prefix}.sourceUrl must be HTTPS URL`);
    else if (sources && !isAllowedSourceUrl(item.sourceUrl, sources)) fail(errors, `${prefix}.sourceUrl is not allowed by data/release-sources.json`);
    if (item.confidence !== 'high') fail(errors, `${prefix}.confidence must be high`);
    if (!isIsoDateTime(item.checkedAt)) fail(errors, `${prefix}.checkedAt must be an ISO timestamp`);

    const key = `${String(item.seriesTitle || '').trim().toLowerCase()}|${String(item.publisher || '').trim().toLowerCase()}`;
    if (seen.has(key)) fail(errors, `${prefix}: duplicate seriesTitle/publisher pair`);
    seen.add(key);
  });

  return { ok: errors.length === 0, errors, warnings };
}

function parseArgs(argv) {
  const args = { file: defaultFile, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    const doc = readJson(args.file);
    const sources = fs.existsSync(sourcesFile) ? readJson(sourcesFile) : null;
    result = validateReleaseVolumeCounts(doc, { sources });
  } catch (error) {
    result = { ok: false, errors: [error.message], warnings: [] };
  }

  if (args && args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    console.log(`✅ release-volume-counts valid (${path.relative(repoRoot, args.file)})`);
  } else {
    console.error('❌ release-volume-counts invalid:');
    result.errors.forEach(error => console.error(`- ${error}`));
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  ALLOWED_ITEM_KEYS,
  ALLOWED_TOP_LEVEL_KEYS,
  FORBIDDEN_KEYS,
  validateReleaseVolumeCounts,
};
