#!/usr/bin/env node
'use strict';

/**
 * Release-cache auto-merge gate.
 *
 * Phase 32a allowed report/queue-only bot PRs.
 * Phase 45 extends that gate to tightly validated high-confidence
 * data/release-cache.json patches. Every unclear state remains default-deny.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildPublisherAliasMap,
  isAllowedSourceUrl,
  isRealReleaseDate,
  isValidHttpUrl,
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');

const repoRoot = path.resolve(__dirname, '..');

const ALLOWLIST = new Set([
  'data/release-cache.json',
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
]);

const REPORT_QUEUE_ONLY_ALLOWLIST = new Set([
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
]);

const BLOCKED_EXACT = new Set([
  'data/release-watchlist.json',
  'data/release-sources.json',
  'index.html',
]);

const BLOCKED_PREFIXES = [
  'scripts/',
  'src/',
  'supabase/',
  '.github/',
  'vendor/',
  'docs/',
];

const WORKTREE_DIAGNOSTIC_IGNORED_PATHS = [
  'artifacts',
  '.tmp.driveupload',
];

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

const ALLOWED_CACHE_ITEM_FIELDS = new Set([
  'seriesTitle',
  'normalizedSeriesTitle',
  'publisher',
  'normalizedPublisher',
  'volumeNumber',
  'releaseDate',
  'isbn13',
  'coverUrl',
  'sourceUrl',
  'sourceName',
  'providerId',
  'evidence',
  'confidence',
  'notes',
  'checkedAt',
]);

const PRIVATE_FIELD_NAMES = new Set([
  'owner',
  'ownerId',
  'userId',
  'email',
  'mail',
  'password',
  'token',
  'secret',
  'apikey',
  'apiKey',
  'accessToken',
  'refreshToken',
  'supabaseKey',
  'jwt',
  'session',
  'owned',
  'read',
  'readStatus',
  'status',
  'rating',
  'personalNotes',
  'privateNotes',
  'notePrivate',
]);

const SPECIAL_EDITION_RE = /\b(box|boxset|box-set|sammelband|sonderausgabe|sonderband|artbook|art book|novel|light novel|variant|limited|collector|deluxe|neuauflage|neuausgabe|new edition|master edition|perfect edition|massiv|doppelband|doppelband-edition)\b/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function deny(reason, extra = {}) {
  return {
    allowed: false,
    class: 'manual-review-required',
    reason,
    ...extra,
  };
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

function parseJsonInput(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`${label} fehlt`);
  }
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

function asQueueArray(queue) {
  if (Array.isArray(queue)) return queue;
  if (queue && Array.isArray(queue.queue)) return queue.queue;
  if (queue && Array.isArray(queue.items)) return queue.items;
  if (queue && Array.isArray(queue.entries)) return queue.entries;
  return [];
}

function entryKey(entry, index) {
  return [
    entry.queueKey,
    entry.key,
    entry.seriesTitle,
    entry.publisher,
    entry.volumeNumber,
    index,
  ]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join('|');
}

function safeToPatchKeys(queue) {
  const entries = asQueueArray(queue);
  return new Set(
    entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry && entry.safeToPatch === true)
      .map(({ entry, index }) => entryKey(entry, index)),
  );
}

function safeToPatchCount(queue) {
  return safeToPatchKeys(queue).size;
}

function findNewSafeToPatch(beforeQueue, afterQueue) {
  const before = safeToPatchKeys(beforeQueue);
  return [...safeToPatchKeys(afterQueue)].filter((key) => !before.has(key));
}

function releaseDateChangedToValue(beforeEntry, afterEntry) {
  return (
    hasText(afterEntry.releaseDate) &&
    (!beforeEntry || beforeEntry.releaseDate !== afterEntry.releaseDate)
  );
}

function mapQueueByKey(queue) {
  const map = new Map();
  asQueueArray(queue).forEach((entry, index) => {
    map.set(entryKey(entry, index), entry);
  });
  return map;
}

function findReleaseDatesWithoutEvidence(beforeQueue, afterQueue) {
  const beforeByKey = mapQueueByKey(beforeQueue);
  return asQueueArray(afterQueue)
    .map((entry, index) => ({ entry, key: entryKey(entry, index) }))
    .filter(({ entry, key }) => releaseDateChangedToValue(beforeByKey.get(key), entry))
    .filter(({ entry }) => !hasText(entry.sourceUrl) || !hasText(entry.checkedAt) || !hasText(entry.evidence))
    .map(({ key }) => key);
}

function findUnknownReviewStatuses(queue) {
  return asQueueArray(queue)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !ALLOWED_REVIEW_STATUS.has(entry.reviewStatus))
    .map(({ entry, index }) => `${entryKey(entry, index)}:${entry.reviewStatus}`);
}

function getCachePatchCount(report) {
  if (report && report.summary && Number.isInteger(report.summary.cachePatches)) {
    return report.summary.cachePatches;
  }
  if (Number.isInteger(report && report.cachePatches)) return report.cachePatches;
  if (Array.isArray(report && report.cachePatches)) return report.cachePatches.length;
  return null;
}

function sourceIdSet(sources) {
  return new Set(((sources && sources.sources) || [])
    .filter(source => source && source.enabled !== false)
    .map(source => source.id)
    .filter(Boolean));
}

function findSourceById(sources, providerId) {
  return ((sources && sources.sources) || [])
    .find(source => source && source.enabled !== false && source.id === providerId) || null;
}

function sourceAllowsUrl(source, sourceUrl) {
  if (!source || !isValidHttpUrl(sourceUrl)) return false;
  const allowedUrls = Array.isArray(source.allowedUrls) && source.allowedUrls.length
    ? source.allowedUrls
    : [source.baseUrl].filter(Boolean);
  return allowedUrls.some(prefix => typeof prefix === 'string' && sourceUrl.startsWith(prefix));
}

function stableCacheKey(item, aliasMap) {
  return [
    normalizeTitle(item && item.seriesTitle),
    normalizePublisher(item && item.publisher, aliasMap),
    Number(item && item.volumeNumber),
  ].join('|');
}

function cacheItems(doc) {
  return doc && Array.isArray(doc.items) ? doc.items : [];
}

function mapCache(doc, aliasMap) {
  const map = new Map();
  for (const item of cacheItems(doc)) {
    map.set(stableCacheKey(item, aliasMap), item);
  }
  return map;
}

function collectPrivateFields(value, pathParts = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPrivateFields(item, [...pathParts, String(index)], found));
    return found;
  }
  if (!isPlainObject(value)) return found;

  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(key)) found.push([...pathParts, key].join('.'));
    collectPrivateFields(child, [...pathParts, key], found);
  }
  return found;
}

function findCacheChanges(beforeCache, afterCache, aliasMap) {
  const before = mapCache(beforeCache, aliasMap);
  const after = mapCache(afterCache, aliasMap);
  const additions = [];
  const updates = [];
  const deletions = [];

  for (const [key, afterItem] of after.entries()) {
    const beforeItem = before.get(key);
    if (!beforeItem) additions.push({ key, item: afterItem });
    else if (JSON.stringify(beforeItem) !== JSON.stringify(afterItem)) updates.push({ key, beforeItem, item: afterItem });
  }
  for (const [key, beforeItem] of before.entries()) {
    if (!after.has(key)) deletions.push({ key, item: beforeItem });
  }

  return { additions, updates, deletions, changedItems: [...additions, ...updates] };
}

function validateCacheItemShape(item, label, sources, aliasMap) {
  const errors = [];
  if (!isPlainObject(item)) return [`${label} is not an object.`];

  for (const key of Object.keys(item)) {
    if (!ALLOWED_CACHE_ITEM_FIELDS.has(key)) errors.push(`${label}.${key} is not an allowed public release-cache field.`);
  }

  const privateFields = collectPrivateFields(item);
  if (privateFields.length) errors.push(`${label} contains private field(s): ${privateFields.join(', ')}.`);

  if (!hasText(item.seriesTitle)) errors.push(`${label}.seriesTitle is missing.`);
  if (!hasText(item.normalizedSeriesTitle)) errors.push(`${label}.normalizedSeriesTitle is missing.`);
  if (!hasText(item.publisher)) errors.push(`${label}.publisher is missing.`);
  if (!hasText(item.normalizedPublisher)) errors.push(`${label}.normalizedPublisher is missing.`);
  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) errors.push(`${label}.volumeNumber is not a positive integer.`);
  if (!isRealReleaseDate(item.releaseDate)) errors.push(`${label}.releaseDate is not a real YYYY-MM-DD release date.`);
  if (item.confidence !== 'high') errors.push(`${label}.confidence must be high.`);
  if (!isValidIso(item.checkedAt)) errors.push(`${label}.checkedAt must be a valid ISO timestamp.`);
  if (!hasText(item.sourceUrl) || !isAllowedSourceUrl(item.sourceUrl, sources)) errors.push(`${label}.sourceUrl must be an allowed https source URL.`);
  if (!hasText(item.sourceName)) errors.push(`${label}.sourceName is missing.`);
  if (!hasText(item.providerId)) errors.push(`${label}.providerId is required for Phase 45 auto-merge.`);
  if (!hasText(item.evidence)) errors.push(`${label}.evidence is required for Phase 45 auto-merge.`);

  if (hasText(item.seriesTitle) && item.normalizedSeriesTitle !== normalizeTitle(item.seriesTitle)) {
    errors.push(`${label}.normalizedSeriesTitle does not match seriesTitle.`);
  }
  if (hasText(item.publisher) && item.normalizedPublisher !== normalizePublisher(item.publisher, aliasMap)) {
    errors.push(`${label}.normalizedPublisher does not match publisher aliases.`);
  }
  if (hasText(item.seriesTitle) && SPECIAL_EDITION_RE.test(item.seriesTitle)) {
    errors.push(`${label}.seriesTitle looks like a special edition or re-release.`);
  }

  const source = findSourceById(sources, item.providerId);
  if (hasText(item.providerId) && !source) {
    errors.push(`${label}.providerId is not enabled in release-sources.json.`);
  }
  if (source && !sourceAllowsUrl(source, item.sourceUrl)) {
    errors.push(`${label}.sourceUrl is not allowed for providerId ${item.providerId}.`);
  }
  if (source && item.sourceName !== source.name) {
    errors.push(`${label}.sourceName does not match providerId ${item.providerId}.`);
  }

  return errors;
}

function validateReleaseCachePatches({ report, beforeCache, afterCache, sources }) {
  const aliasMap = buildPublisherAliasMap(sources);
  const errors = [];
  const cachePatchCount = getCachePatchCount(report);

  if (!Array.isArray(report.cachePatches)) errors.push('report.cachePatches must be an array.');
  if (!report.autoMergeEligible) errors.push('report.autoMergeEligible must be true for release-cache auto-merge.');
  if (cachePatchCount === null || cachePatchCount <= 0) errors.push('cachePatches must be > 0 for release-cache auto-merge.');
  if (Array.isArray(report.reviewQueueWrites) && report.reviewQueueWrites.length !== 0) errors.push('reviewQueueWrites must be empty for release-cache auto-merge.');
  if (Array.isArray(report.blockedCandidates) && report.blockedCandidates.length !== 0) errors.push('blockedCandidates must be empty for release-cache auto-merge.');
  if (report.summary && Number(report.summary.invalidExistingCache || 0) !== 0) errors.push('invalidExistingCache must be 0.');

  const enabledSourceIds = sourceIdSet(sources);
  if (enabledSourceIds.size === 0) errors.push('No enabled sources found in release-sources.json.');

  if (beforeCache && afterCache) {
    const beforePrivate = collectPrivateFields(beforeCache);
    const afterPrivate = collectPrivateFields(afterCache);
    if (afterPrivate.length > beforePrivate.length) errors.push(`New private field(s) found in release-cache: ${afterPrivate.join(', ')}.`);
  }

  const diff = findCacheChanges(beforeCache, afterCache, aliasMap);
  if (diff.deletions.length) errors.push(`release-cache deletions are not auto-mergeable: ${diff.deletions.map(item => item.key).join(', ')}.`);
  if (cachePatchCount !== null && diff.changedItems.length !== cachePatchCount) {
    errors.push(`Changed release-cache item count (${diff.changedItems.length}) does not match report cachePatches (${cachePatchCount}).`);
  }

  const reportPatchByKey = new Map();
  for (const [index, patch] of (report.cachePatches || []).entries()) {
    if (!isPlainObject(patch)) {
      errors.push(`report.cachePatches[${index}] is not an object.`);
      continue;
    }
    if (patch.confidence !== 'high') errors.push(`report.cachePatches[${index}].confidence must be high.`);
    if (!hasText(patch.key)) errors.push(`report.cachePatches[${index}].key is missing.`);
    if (!hasText(patch.sourceUrl) || !isAllowedSourceUrl(patch.sourceUrl, sources)) errors.push(`report.cachePatches[${index}].sourceUrl must be allowed.`);
    if (!hasText(patch.sourceName)) errors.push(`report.cachePatches[${index}].sourceName is missing.`);
    if (!hasText(patch.providerId) || !enabledSourceIds.has(patch.providerId)) errors.push(`report.cachePatches[${index}].providerId must be enabled.`);
    if (hasText(patch.seriesTitle) && SPECIAL_EDITION_RE.test(patch.seriesTitle)) errors.push(`report.cachePatches[${index}].seriesTitle looks like a special edition or re-release.`);
    if (hasText(patch.key)) reportPatchByKey.set(patch.key, patch);
  }

  for (const [index, changed] of diff.changedItems.entries()) {
    const label = `changed release-cache item ${index + 1} (${changed.key})`;
    errors.push(...validateCacheItemShape(changed.item, label, sources, aliasMap));

    const patch = reportPatchByKey.get(changed.key);
    if (!patch) {
      errors.push(`${label} is missing from report.cachePatches.`);
      continue;
    }
    const comparableFields = ['seriesTitle', 'publisher', 'volumeNumber', 'releaseDate', 'sourceName', 'providerId', 'sourceUrl', 'confidence'];
    for (const field of comparableFields) {
      if (patch[field] !== changed.item[field]) errors.push(`${label}.${field} does not match report cache patch.`);
    }
  }

  return { ok: errors.length === 0, errors, diff };
}

function evaluateReportQueueOnlyGate({ normalizedChangedFiles, report, beforeQueue, afterQueue, base }) {
  for (const file of normalizedChangedFiles) {
    if (!REPORT_QUEUE_ONLY_ALLOWLIST.has(file)) {
      return deny(`Blocked because ${file} is not in the report/queue-only allowlist.`, base);
    }
  }

  const cachePatches = getCachePatchCount(report);
  if (cachePatches === null) {
    return deny('Blocked because cachePatches could not be determined from the pipeline report.', base);
  }

  const safeToPatchBefore = safeToPatchCount(beforeQueue);
  const safeToPatchAfter = safeToPatchCount(afterQueue);
  const withCounts = { ...base, cachePatches, safeToPatchBefore, safeToPatchAfter };

  if (cachePatches !== 0) {
    return deny(`Blocked because cachePatches is ${cachePatches}.`, withCounts);
  }

  if (safeToPatchAfter > safeToPatchBefore) {
    return deny('Blocked because safeToPatch=true count increased.', withCounts);
  }

  const newSafeToPatch = findNewSafeToPatch(beforeQueue, afterQueue);
  if (newSafeToPatch.length > 0) {
    return deny('Blocked because new safeToPatch=true entries were added.', {
      ...withCounts,
      newSafeToPatch,
    });
  }

  const releaseDatesWithoutEvidence = findReleaseDatesWithoutEvidence(beforeQueue, afterQueue);
  if (releaseDatesWithoutEvidence.length > 0) {
    return deny('Blocked because new releaseDate values require sourceUrl, checkedAt, and evidence.', {
      ...withCounts,
      releaseDatesWithoutEvidence,
    });
  }

  const unknownReviewStatuses = findUnknownReviewStatuses(afterQueue);
  if (unknownReviewStatuses.length > 0) {
    return deny('Blocked because the review queue contains unknown reviewStatus values.', {
      ...withCounts,
      unknownReviewStatuses,
    });
  }

  const reportOnly =
    normalizedChangedFiles.length === 1 &&
    normalizedChangedFiles[0] === 'data/release-cache-pipeline-report.json';

  return {
    allowed: true,
    class: reportOnly ? 'report-only' : 'report-queue-only',
    reason: reportOnly
      ? 'Only release cache pipeline report changed; cachePatches is 0.'
      : 'Only release cache pipeline report and review queue changed; cachePatches is 0; no new safeToPatch entries.',
    ...withCounts,
  };
}

function evaluateAutoMergeGate({
  changedFiles,
  pipelineReport,
  beforeQueue = [],
  afterQueue = [],
  beforeCache = { items: [] },
  afterCache = { items: [] },
  sources = { sources: [] },
}) {
  const normalizedChangedFiles = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))].sort();
  const base = { changedFiles: normalizedChangedFiles };

  try {
    if (normalizedChangedFiles.length === 0) {
      return deny('Blocked because no changed files were provided.', base);
    }

    for (const file of normalizedChangedFiles) {
      if (BLOCKED_EXACT.has(file)) {
        return deny(`Blocked because ${file} changed.`, base);
      }
      const blockedPrefix = BLOCKED_PREFIXES.find((prefix) => file.startsWith(prefix));
      if (blockedPrefix) {
        return deny(`Blocked because ${blockedPrefix} changes are not allowed in Phase 45.`, base);
      }
      if (!ALLOWLIST.has(file)) {
        return deny(`Blocked because ${file} is not in the Phase 45 allowlist.`, base);
      }
    }

    const report = parseJsonInput(pipelineReport, 'Pipeline report');
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      return deny('Blocked because pipeline report is not a JSON object.', base);
    }

    const releaseCacheChanged = normalizedChangedFiles.includes('data/release-cache.json');
    if (!releaseCacheChanged) {
      return evaluateReportQueueOnlyGate({ normalizedChangedFiles, report, beforeQueue, afterQueue, base });
    }

    if (!normalizedChangedFiles.includes('data/release-cache-pipeline-report.json')) {
      return deny('Blocked because release-cache changes require data/release-cache-pipeline-report.json in the PR.', base);
    }

    const queueUnknownStatuses = findUnknownReviewStatuses(afterQueue);
    if (queueUnknownStatuses.length > 0) {
      return deny('Blocked because the review queue contains unknown reviewStatus values.', {
        ...base,
        unknownReviewStatuses: queueUnknownStatuses,
      });
    }

    const releaseCacheValidation = validateReleaseCachePatches({
      report,
      beforeCache: parseJsonInput(beforeCache, 'Before release cache'),
      afterCache: parseJsonInput(afterCache, 'After release cache'),
      sources: parseJsonInput(sources, 'Release sources'),
    });

    const cachePatches = getCachePatchCount(report);
    const withCounts = {
      ...base,
      cachePatches,
      changedCacheItems: releaseCacheValidation.diff.changedItems.length,
      deletedCacheItems: releaseCacheValidation.diff.deletions.length,
    };

    if (!releaseCacheValidation.ok) {
      return deny('Blocked because release-cache Phase 45 data gate failed.', {
        ...withCounts,
        errors: releaseCacheValidation.errors,
      });
    }

    return {
      allowed: true,
      class: 'release-cache-high-confidence-only',
      reason: 'Only allowed release-cache data files changed; every cache patch is high-confidence, source-backed, and matches the pipeline report.',
      ...withCounts,
    };
  } catch (error) {
    return deny(`Blocked because auto-merge gate could not evaluate safely: ${error.message}`, base);
  }
}

function readJsonFile(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readJsonFromGit(ref, relativePath) {
  const output = execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(output);
}

function gitLines(args, cwd = repoRoot) {
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.split(/\r?\n/).map(normalizePath).filter(Boolean);
}

function getChangedFiles(baseRef = 'main', { includeWorktree = false, cwd = repoRoot } = {}) {
  const committed = gitLines(['diff', '--name-only', `${baseRef}...HEAD`], cwd);

  if (!includeWorktree) {
    return [...new Set(committed)];
  }

  const worktree = gitLines(['diff', '--name-only'], cwd);
  const staged = gitLines(['diff', '--cached', '--name-only'], cwd);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'], cwd);

  const ignoredDiagnostics = gitLines(
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...WORKTREE_DIAGNOSTIC_IGNORED_PATHS,
    ],
    cwd,
  );

  return [...new Set([...committed, ...worktree, ...staged, ...untracked, ...ignoredDiagnostics])];
}

function parseArgs(argv) {
  const args = {
    json: false,
    base: process.env.AUTO_MERGE_GATE_BASE || 'main',
    changedFiles: null,
    includeWorktree: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--include-worktree') args.includeWorktree = true;
    else if (arg === '--changed-file') {
      args.changedFiles = args.changedFiles || [];
      args.changedFiles.push(argv[++i]);
    } else if (arg === '--changed-files') {
      args.changedFiles = argv[++i].split(',').map(normalizePath).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function formatText(result) {
  const lines = [];
  lines.push('Release-Cache Auto-Merge Gate');
  lines.push('');
  lines.push(`Decision: ${result.allowed ? 'AUTO-MERGE ALLOWED' : 'MANUAL REVIEW REQUIRED'}`);
  lines.push(`PR class: ${result.class}`);
  lines.push(`Reason: ${result.reason}`);
  lines.push('');
  lines.push('PR changed files:');
  for (const file of result.changedFiles || []) lines.push(`- ${file}`);
  if (typeof result.cachePatches === 'number') lines.push(`Cache patches: ${result.cachePatches}`);
  if (typeof result.changedCacheItems === 'number') lines.push(`Changed cache items: ${result.changedCacheItems}`);
  if (typeof result.safeToPatchBefore === 'number') lines.push(`safeToPatch before: ${result.safeToPatchBefore}`);
  if (typeof result.safeToPatchAfter === 'number') lines.push(`safeToPatch after: ${result.safeToPatchAfter}`);
  if (Array.isArray(result.errors) && result.errors.length) {
    lines.push('');
    lines.push('Errors:');
    for (const error of result.errors) lines.push(`- ${error}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    const changedFiles = args.changedFiles || getChangedFiles(args.base, { includeWorktree: args.includeWorktree });
    result = evaluateAutoMergeGate({
      changedFiles,
      pipelineReport: readJsonFile('data/release-cache-pipeline-report.json'),
      beforeQueue: readJsonFromGit(args.base, 'data/release-source-review-queue.json'),
      afterQueue: readJsonFile('data/release-source-review-queue.json'),
      beforeCache: readJsonFromGit(args.base, 'data/release-cache.json'),
      afterCache: readJsonFile('data/release-cache.json'),
      sources: readJsonFile('data/release-sources.json'),
    });
  } catch (error) {
    result = deny(`Blocked because auto-merge gate setup failed: ${error.message}`, {
      changedFiles: [],
    });
  }

  if (args && args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatText(result));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWLIST,
  REPORT_QUEUE_ONLY_ALLOWLIST,
  BLOCKED_EXACT,
  BLOCKED_PREFIXES,
  ALLOWED_REVIEW_STATUS,
  ALLOWED_CACHE_ITEM_FIELDS,
  evaluateAutoMergeGate,
  getChangedFiles,
  validateReleaseCachePatches,
};
