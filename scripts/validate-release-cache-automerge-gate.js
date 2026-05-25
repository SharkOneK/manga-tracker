#!/usr/bin/env node
'use strict';

/**
 * Phase 32a auto-merge gate for automated release-cache PRs.
 *
 * This intentionally allows only report/queue-only updates. Cache patches,
 * code/workflow/script changes, source/watchlist changes, and every unclear
 * state are denied by default.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

const ALLOWLIST = new Set([
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
]);

const BLOCKED_EXACT = new Set([
  'data/release-cache.json',
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

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function evaluateAutoMergeGate({ changedFiles, pipelineReport, beforeQueue = [], afterQueue = [] }) {
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
        return deny(`Blocked because ${blockedPrefix} changes are not allowed in Phase 32a.`, base);
      }
      if (!ALLOWLIST.has(file)) {
        return deny(`Blocked because ${file} is not in the Phase 32a allowlist.`, base);
      }
    }

    const report = parseJsonInput(pipelineReport, 'Pipeline report');
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      return deny('Blocked because pipeline report is not a JSON object.', base);
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
  if (typeof result.safeToPatchBefore === 'number') lines.push(`safeToPatch before: ${result.safeToPatchBefore}`);
  if (typeof result.safeToPatchAfter === 'number') lines.push(`safeToPatch after: ${result.safeToPatchAfter}`);
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
  BLOCKED_EXACT,
  BLOCKED_PREFIXES,
  ALLOWED_REVIEW_STATUS,
  evaluateAutoMergeGate,
  getChangedFiles,
};
