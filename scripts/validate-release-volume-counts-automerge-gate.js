#!/usr/bin/env node
'use strict';

/** Phase 43 auto-merge gate for release-volume-count bot PRs. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateReleaseVolumeCounts } = require('./validate-release-volume-counts');

const repoRoot = path.resolve(__dirname, '..');
const ALLOWLIST = new Set([
  'data/release-volume-counts.json',
  'data/release-volume-counts-report.json',
]);
const BLOCKED_PREFIXES = ['src/', 'scripts/', '.github/', 'supabase/', 'docs/', 'vendor/'];
const BLOCKED_EXACT = new Set([
  'data/release-cache.json',
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
  'data/release-watchlist.json',
  'data/release-sources.json',
  'index.html',
]);

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}
function deny(reason, extra = {}) { return { allowed: false, class: 'manual-review-required', reason, ...extra }; }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')); }
function gitLines(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).map(normalizePath).filter(Boolean);
}
function getChangedFiles(baseRef = 'main') { return [...new Set(gitLines(['diff', '--name-only', `${baseRef}...HEAD`]))]; }

function evaluateReleaseVolumeCountsGate({ changedFiles, countsDoc, reportDoc, sourcesDoc }) {
  const normalizedChangedFiles = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))].sort();
  const base = { changedFiles: normalizedChangedFiles };

  if (!normalizedChangedFiles.length) return deny('Blocked because no changed files were provided.', base);
  for (const file of normalizedChangedFiles) {
    if (BLOCKED_EXACT.has(file)) return deny(`Blocked because ${file} changed.`, base);
    const blockedPrefix = BLOCKED_PREFIXES.find(prefix => file.startsWith(prefix));
    if (blockedPrefix) return deny(`Blocked because ${blockedPrefix} changes are not allowed in Phase 43 bot PRs.`, base);
    if (!ALLOWLIST.has(file)) return deny(`Blocked because ${file} is not in the Phase 43 allowlist.`, base);
  }

  const validation = validateReleaseVolumeCounts(countsDoc, { sources: sourcesDoc });
  if (!validation.ok) return deny('Blocked because release-volume-counts validation failed.', { ...base, errors: validation.errors });

  if (!reportDoc || typeof reportDoc !== 'object' || reportDoc.schemaVersion !== 1) {
    return deny('Blocked because release-volume-counts report is missing or invalid.', base);
  }
  if (reportDoc.privacyGateRequired !== true) return deny('Blocked because privacyGateRequired is not true.', base);
  const changed = Number(reportDoc.summary && reportDoc.summary.appliedHighConfidenceChanges || 0);
  const blocked = Number(reportDoc.summary && reportDoc.summary.blockedOrUnsafe || 0);

  return {
    allowed: true,
    class: 'release-volume-counts-only',
    reason: 'Only public release volume count artifacts changed; validator and privacy gate passed.',
    ...base,
    appliedHighConfidenceChanges: changed,
    blockedOrUnsafe: blocked,
  };
}

function parseArgs(argv) {
  const args = { json: false, base: process.env.AUTO_MERGE_GATE_BASE || 'main', changedFiles: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--changed-file') { args.changedFiles = args.changedFiles || []; args.changedFiles.push(argv[++i]); }
    else if (arg === '--changed-files') args.changedFiles = argv[++i].split(',').map(normalizePath).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function formatText(result) {
  return [
    'Release Volume Counts Auto-Merge Gate',
    '',
    `Decision: ${result.allowed ? 'AUTO-MERGE ALLOWED' : 'MANUAL REVIEW REQUIRED'}`,
    `PR class: ${result.class}`,
    `Reason: ${result.reason}`,
    '',
    'PR changed files:',
    ...(result.changedFiles || []).map(file => `- ${file}`),
    '',
  ].join('\n');
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    result = evaluateReleaseVolumeCountsGate({
      changedFiles: args.changedFiles || getChangedFiles(args.base),
      countsDoc: readJson('data/release-volume-counts.json'),
      reportDoc: readJson('data/release-volume-counts-report.json'),
      sourcesDoc: readJson('data/release-sources.json'),
    });
  } catch (error) {
    result = deny(`Blocked because gate setup failed: ${error.message}`, { changedFiles: [] });
  }

  process.stdout.write(args && args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatText(result)}\n`);
  process.exitCode = result.allowed ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  ALLOWLIST,
  BLOCKED_EXACT,
  BLOCKED_PREFIXES,
  evaluateReleaseVolumeCountsGate,
  getChangedFiles,
};
