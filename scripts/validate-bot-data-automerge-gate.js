#!/usr/bin/env node
'use strict';

/**
 * Phase 83 auto-merge gate for bot data PRs.
 *
 * Ein Validator, zwei Domains (`series-publication-status`, `tmdb-series-catalog`).
 * Beide Gates sind strukturell identisch (Pfad-Allowlist → Schema-Validator →
 * Privacy-Scan → Diff-Regeln → Default-Deny); nur Dateiliste, Schema-Validator
 * und die Diff-Prädikate unterscheiden sich. Zwei kopierte Skripte würden
 * auseinanderdriften — genau das Muster, aus dem Audit-Befund 6 entstanden ist.
 *
 * Aufbau, Flags und Exit-Code spiegeln bewusst das Phase-43-Vorbild
 * scripts/validate-release-volume-counts-automerge-gate.js.
 *
 * Aufruf:
 *   node scripts/validate-bot-data-automerge-gate.js --domain <name> --base origin/main --json
 *
 * Jeder unklare Zustand bleibt Default-Deny.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateSeriesPublicationStatus } = require('./validate-series-publication-status');
const { validateTmdbSeriesCatalog } = require('./validate-tmdb-series-catalog');

const repoRoot = path.resolve(__dirname, '..');

const BLOCKED_PREFIXES = ['src/', 'scripts/', '.github/', 'supabase/', 'docs/', 'vendor/'];

// Datenartefakte, die keiner der beiden Domains gehören. Jede Domain ergänzt
// zusätzlich die Artefakte der jeweils anderen Domain (siehe blockedExactFor()).
const BLOCKED_EXACT_COMMON = new Set([
  'index.html',
  'data/release-cache.json',
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
  'data/release-watchlist.json',
  'data/release-sources.json',
  'data/release-volume-counts.json',
  'data/release-volume-counts-report.json',
  'data/tmdb-watchlist.json',
  'data/series-status-overrides.json',
]);

// Rekursiv verbotene Keys (Analogie zu collectPrivateFields in
// validate-release-cache-automerge-gate.js). Bewusst OHNE die generischen Namen
// `status`/`notes`: beide sind in diesen zwei Schemas legitime öffentliche Felder.
const FORBIDDEN_KEYS = new Set([
  'owner', 'ownerId', 'owner_token', 'ownerToken', 'userId', 'email', 'password',
  'token', 'secret', 'apiKey', 'api_key', 'accessToken', 'refreshToken',
  'supabaseKey', 'jwt', 'session', 'owned', 'read', 'readStatus', 'rating',
  'personalNotes', 'privateNotes', 'viewToken', 'view_token',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const STATUS_UPDATABLE_FIELDS = new Set([
  'ongoing', 'sourceStatus', 'editionId', 'source', 'sourceUrl', 'reason', 'checkedAt',
]);
const TMDB_UPDATABLE_FIELDS = new Set([
  'total', 'seasonCount', 'ongoing', 'seasons', 'genres', 'overview', 'cover',
  'network', 'streamingProviders',
]);

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}
function deny(reason, extra = {}) { return { allowed: false, class: 'manual-review-required', reason, ...extra }; }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')); }
function isPlainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function hasText(value) { return typeof value === 'string' && value.trim().length > 0; }
function isValidIso(value) { return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value)); }
function gitLines(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).map(normalizePath).filter(Boolean);
}
function getChangedFiles(baseRef = 'main') { return [...new Set(gitLines(['diff', '--name-only', `${baseRef}...HEAD`]))]; }

// Basisdokument über `git show <base>:<pfad>` (wie readJsonFromGit in
// validate-release-cache-automerge-gate.js). Fehler beim Lesen/Parsen → null → deny.
function readJsonFromGit(ref, relativePath) {
  try {
    const output = execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(output);
  } catch (_) {
    return null;
  }
}

function collectForbiddenKeys(value, pathParts = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenKeys(item, [...pathParts, String(index)], found));
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) found.push([...pathParts, key].join('.'));
    collectForbiddenKeys(child, [...pathParts, key], found);
  }
  return found;
}

function itemsOf(doc) { return doc && Array.isArray(doc.items) ? doc.items : []; }

function mapItems(doc, itemKey) {
  const map = new Map();
  for (const item of itemsOf(doc)) map.set(itemKey(item), item);
  return map;
}

function changedFieldNames(beforeItem, afterItem) {
  const keys = new Set([...Object.keys(beforeItem || {}), ...Object.keys(afterItem || {})]);
  return [...keys].filter(key => JSON.stringify((beforeItem || {})[key]) !== JSON.stringify((afterItem || {})[key]));
}

// Monotonie-Regel wie bei den Volume-Counts (.github/workflows/update-release-cache.yml:64-69):
// null → Zahl ist erlaubt, Zahl → null oder sinkende Zahl nicht.
function isMonotoneNumber(beforeValue, afterValue) {
  if (beforeValue === null || beforeValue === undefined) return true;
  if (afterValue === null || afterValue === undefined) return false;
  if (typeof beforeValue !== 'number' || typeof afterValue !== 'number') return false;
  return afterValue >= beforeValue;
}

const DOMAINS = {
  'series-publication-status': {
    label: 'Series Publication Status',
    allowClass: 'series-publication-status-only',
    dataFile: 'data/series-publication-status.json',
    allowlist: new Set(['data/series-publication-status.json', 'data/series-publication-status-report.json']),
    allowedTopLevelKeys: new Set(['schemaVersion', 'generatedAt', 'items']),
    // Ändert sich die Statusdatei, muss der Report im selben PR liegen (analog
    // validate-release-cache-automerge-gate.js:649-651).
    companions: [{ file: 'data/series-publication-status.json', requires: 'data/series-publication-status-report.json' }],
    validateSchema: doc => validateSeriesPublicationStatus(doc),
    itemKey: item => `${String(item && item.seriesTitle).toLowerCase()}|${String(item && item.publisher).toLowerCase()}`,
    // Reine Frische-Felder: der Runner schreibt checkedAt in JEDES geprüfte Item,
    // ein Lauf erzeugt damit ~45 von 47 Updates ohne inhaltliche Änderung
    // (gemessen an PR #306). Sie zählen deshalb nicht gegen die Mengenbremse —
    // sonst wäre genau diese Domain dauerhaft blockiert (Deadlock wie Befund 2).
    // Gegen die Feld-Allowlist werden sie weiterhin geprüft.
    freshnessFields: new Set(['checkedAt']),
    loadExtraDocs: () => ({ reportDoc: readJson('data/series-publication-status-report.json') }),
    checkAddition(item) {
      if (!isPlainObject(item)) return 'addition is not an object';
      if (item.confidence !== 'high') return 'addition without confidence=high';
      const isOverride = item.source === 'override' && hasText(item.reason);
      const isSourced = hasText(item.sourceUrl) && item.sourceUrl.startsWith('https://')
        && [1, 2].includes(Number(item.sourceStatus));
      if (!isOverride && !isSourced) return 'addition needs either an override with a reason or an https source with sourceStatus 1/2';
      return null;
    },
    checkUpdate(beforeItem, afterItem) {
      if (beforeItem.seriesTitle !== afterItem.seriesTitle || beforeItem.publisher !== afterItem.publisher) {
        return 'seriesTitle/publisher are the item identity and must not change';
      }
      if (afterItem.confidence !== 'high') return 'update must keep confidence=high';
      const illegal = changedFieldNames(beforeItem, afterItem).filter(field => !STATUS_UPDATABLE_FIELDS.has(field));
      if (illegal.length) return `update changes fields that are not auto-mergeable: ${illegal.join(', ')}`;
      return null;
    },
    checkDomain({ reportDoc, diff }) {
      if (!isPlainObject(reportDoc)) return 'series-publication-status report is missing or not a JSON object';
      if (reportDoc.schemaVersion !== 1) return 'series-publication-status report schemaVersion must be 1';
      if (reportDoc.source !== 'run-series-publication-status.js') return 'series-publication-status report source is unexpected';
      const summary = isPlainObject(reportDoc.summary) ? reportDoc.summary : null;
      if (!summary) return 'series-publication-status report summary is missing';
      // blockedOrUnmapped DARF > 0 sein — sonst entsteht derselbe Deadlock wie in Befund 2.
      if (!Number.isInteger(summary.blockedOrUnmapped) || summary.blockedOrUnmapped < 0) {
        return 'series-publication-status report summary.blockedOrUnmapped must be an integer >= 0';
      }
      if (!Number.isInteger(summary.appliedChanges) || summary.appliedChanges < 0) {
        return 'series-publication-status report summary.appliedChanges must be an integer >= 0';
      }
      // Anti-Tamper: der Report darf nicht massiv mehr Änderungen behaupten, als im
      // Diff stehen. Zulässiger Aufschlag: 2 Einträge je angewandtem Override — ein
      // Override kann denselben Titel zweimal zählen (API-Wert kippt ihn, der
      // Override kippt ihn zurück) ohne jede Netto-Änderung an der Datei. Genau so
      // sieht der reale Lauf aus (PR #306: appliedChanges 2, netto 0 Änderungen).
      const overridesApplied = Number.isInteger(summary.overridesApplied) ? summary.overridesApplied : 0;
      const itemChanges = diff.additions.length + diff.updates.length;
      const allowedClaim = itemChanges + 2 * overridesApplied;
      if (summary.appliedChanges > allowedClaim) {
        return `series-publication-status report claims ${summary.appliedChanges} applied changes but only ${itemChanges} item change(s) (+${2 * overridesApplied} tolerated for ${overridesApplied} override(s)) are in the diff`;
      }
      return null;
    },
  },

  'tmdb-series-catalog': {
    label: 'TMDB Series Catalog',
    allowClass: 'tmdb-series-catalog-only',
    dataFile: 'data/tmdb-series-catalog.json',
    allowlist: new Set(['data/tmdb-series-catalog.json']),
    allowedTopLevelKeys: new Set(['schemaVersion', 'generatedAt', 'source', 'items']),
    companions: [],
    validateSchema: doc => validateTmdbSeriesCatalog(doc),
    itemKey: item => String(item && item.tmdbId),
    // data/tmdb-watchlist.json ist NICHT Teil der Allowlist; sie wird vom PR-Head
    // gelesen und ist dort identisch zur Basis (der Bot darf sie nicht ändern).
    loadExtraDocs: () => ({ watchlistDoc: readJson('data/tmdb-watchlist.json') }),
    checkAddition(item, { watchlistDoc }) {
      if (!isPlainObject(item)) return 'addition is not an object';
      const enabledIds = new Set(itemsOf(watchlistDoc)
        .filter(entry => entry && entry.enabled !== false)
        .map(entry => String(entry.tmdbId)));
      if (!enabledIds.has(String(item.tmdbId))) {
        return `new tmdbId ${item.tmdbId} has no enabled entry in data/tmdb-watchlist.json`;
      }
      return null;
    },
    checkUpdate(beforeItem, afterItem) {
      if (beforeItem.title !== afterItem.title) return 'title changed (possible mismatched TMDB series)';
      const illegal = changedFieldNames(beforeItem, afterItem).filter(field => !TMDB_UPDATABLE_FIELDS.has(field));
      if (illegal.length) return `update changes fields that are not auto-mergeable: ${illegal.join(', ')}`;
      if (!isMonotoneNumber(beforeItem.seasonCount, afterItem.seasonCount)) return 'seasonCount must not decrease';
      if (!isMonotoneNumber(beforeItem.total, afterItem.total)) return 'total must not decrease';
      return null;
    },
    checkDomain() { return null; },
  },
};

function blockedExactFor(domainName) {
  const blocked = new Set(BLOCKED_EXACT_COMMON);
  for (const [name, domain] of Object.entries(DOMAINS)) {
    if (name === domainName) continue;
    for (const file of domain.allowlist) blocked.add(file);
  }
  return blocked;
}

/**
 * Reine Funktion: bekommt alle Dokumente injiziert (kein Git, kein Netz).
 * `beforeDoc` ist das Basisdokument der Hauptdatei, `afterDoc` das des PR-Heads.
 */
function evaluateBotDataAutoMergeGate({
  domain: domainName,
  changedFiles,
  beforeDoc,
  afterDoc,
  reportDoc = null,
  watchlistDoc = null,
}) {
  const normalizedChangedFiles = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))].sort();
  const base = { domain: domainName || null, changedFiles: normalizedChangedFiles };

  const domain = DOMAINS[domainName];
  if (!domain) {
    return deny(`Blocked because --domain "${domainName || ''}" is unknown (known: ${Object.keys(DOMAINS).join(', ')}).`, base);
  }

  if (!normalizedChangedFiles.length) return deny('Blocked because no changed files were provided.', base);

  const blockedExact = blockedExactFor(domainName);
  for (const file of normalizedChangedFiles) {
    if (blockedExact.has(file)) return deny(`Blocked because ${file} changed.`, base);
    const blockedPrefix = BLOCKED_PREFIXES.find(prefix => file.startsWith(prefix));
    if (blockedPrefix) return deny(`Blocked because ${blockedPrefix} changes are not allowed in Phase 83 bot PRs.`, base);
    if (!domain.allowlist.has(file)) return deny(`Blocked because ${file} is not in the ${domainName} allowlist.`, base);
  }

  for (const companion of domain.companions) {
    if (normalizedChangedFiles.includes(companion.file) && !normalizedChangedFiles.includes(companion.requires)) {
      return deny(`Blocked because ${companion.file} changes require ${companion.requires} in the PR.`, base);
    }
  }

  if (!isPlainObject(beforeDoc)) return deny(`Blocked because the base version of ${domain.dataFile} could not be read.`, base);
  if (!isPlainObject(afterDoc)) return deny(`Blocked because ${domain.dataFile} could not be read from the PR head.`, base);

  const schema = domain.validateSchema(afterDoc);
  if (!schema.ok) {
    return deny(`Blocked because ${domain.dataFile} failed schema validation.`, { ...base, errors: schema.errors.slice(0, 20) });
  }

  const forbidden = collectForbiddenKeys(afterDoc);
  if (forbidden.length) {
    return deny(`Blocked because ${domain.dataFile} contains forbidden key(s): ${forbidden.slice(0, 10).join(', ')}.`, base);
  }

  const unknownTopLevel = Object.keys(afterDoc).filter(key => !domain.allowedTopLevelKeys.has(key));
  if (unknownTopLevel.length) {
    return deny(`Blocked because ${domain.dataFile} has unexpected top-level key(s): ${unknownTopLevel.join(', ')}.`, base);
  }

  if (!isValidIso(afterDoc.generatedAt)) return deny('Blocked because generatedAt is not a valid ISO timestamp.', base);
  if (isValidIso(beforeDoc.generatedAt) && Date.parse(afterDoc.generatedAt) < Date.parse(beforeDoc.generatedAt)) {
    return deny('Blocked because generatedAt moved backwards relative to the base.', base);
  }

  const beforeItems = mapItems(beforeDoc, domain.itemKey);
  const afterItems = mapItems(afterDoc, domain.itemKey);
  const additions = [];
  const updates = [];
  const deletions = [];
  for (const [key, afterItem] of afterItems.entries()) {
    const beforeItem = beforeItems.get(key);
    if (!beforeItem) additions.push({ key, item: afterItem });
    else if (JSON.stringify(beforeItem) !== JSON.stringify(afterItem)) updates.push({ key, beforeItem, item: afterItem });
  }
  for (const [key, beforeItem] of beforeItems.entries()) {
    if (!afterItems.has(key)) deletions.push({ key, item: beforeItem });
  }
  const diff = { additions, updates, deletions };

  // Inhaltliche Updates: Updates, die mehr als die reinen Frische-Felder der Domain
  // ändern (z. B. checkedAt). Nur sie zählen gegen die Mengenbremse.
  const freshnessFields = domain.freshnessFields || new Set();
  const contentUpdates = updates.filter(update =>
    changedFieldNames(update.beforeItem, update.item).some(field => !freshnessFields.has(field)));

  const withCounts = {
    ...base,
    baseItems: beforeItems.size,
    headItems: afterItems.size,
    additions: additions.length,
    updates: updates.length,
    contentUpdates: contentUpdates.length,
    deletions: deletions.length,
  };

  // Mengenbremse: schützt vor Massen-Umschreibung durch einen Parser-/API-Ausfall.
  const changeBudget = Math.max(5, Math.ceil(0.2 * beforeItems.size));
  const totalChanges = additions.length + contentUpdates.length + deletions.length;
  if (totalChanges > changeBudget) {
    return deny(`Blocked because ${totalChanges} content change(s) exceed the change budget of ${changeBudget}.`, withCounts);
  }

  // Löschungen sind nie auto-mergebar; der manuelle Merge bleibt möglich.
  if (deletions.length) {
    return deny(`Blocked because item deletions are not auto-mergeable: ${deletions.slice(0, 10).map(d => d.key).join(', ')}.`, withCounts);
  }

  for (const addition of additions) {
    const error = domain.checkAddition(addition.item, { watchlistDoc, reportDoc });
    if (error) return deny(`Blocked because addition ${addition.key} is not auto-mergeable: ${error}.`, withCounts);
  }
  for (const update of updates) {
    const error = domain.checkUpdate(update.beforeItem, update.item, { watchlistDoc, reportDoc });
    if (error) return deny(`Blocked because update ${update.key} is not auto-mergeable: ${error}.`, withCounts);
  }

  const domainError = domain.checkDomain({ reportDoc, watchlistDoc, diff, afterDoc, beforeDoc });
  if (domainError) return deny(`Blocked because ${domainError}.`, withCounts);

  return {
    allowed: true,
    class: domain.allowClass,
    reason: `Only public ${domainName} artifacts changed; schema, privacy scan and diff rules passed.`,
    ...withCounts,
  };
}

function parseArgs(argv) {
  const args = { json: false, base: process.env.AUTO_MERGE_GATE_BASE || 'main', domain: null, changedFiles: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--domain') args.domain = argv[++i];
    else if (arg === '--changed-file') { args.changedFiles = args.changedFiles || []; args.changedFiles.push(argv[++i]); }
    else if (arg === '--changed-files') args.changedFiles = argv[++i].split(',').map(normalizePath).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function formatText(result) {
  return [
    'Bot Data Auto-Merge Gate',
    '',
    `Domain: ${result.domain || '(none)'}`,
    `Decision: ${result.allowed ? 'AUTO-MERGE ALLOWED' : 'MANUAL REVIEW REQUIRED'}`,
    `PR class: ${result.class}`,
    `Reason: ${result.reason}`,
    '',
    'PR changed files:',
    ...(result.changedFiles || []).map(file => `- ${file}`),
    '',
    ...(Array.isArray(result.errors) && result.errors.length ? ['Errors:', ...result.errors.map(error => `- ${error}`), ''] : []),
  ].join('\n');
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    const domain = DOMAINS[args.domain];
    if (!domain) {
      result = deny(`Blocked because --domain "${args.domain || ''}" is unknown (known: ${Object.keys(DOMAINS).join(', ')}).`, {
        domain: args.domain || null,
        changedFiles: [],
      });
    } else {
      result = evaluateBotDataAutoMergeGate({
        domain: args.domain,
        changedFiles: args.changedFiles || getChangedFiles(args.base),
        beforeDoc: readJsonFromGit(args.base, domain.dataFile),
        afterDoc: readJson(domain.dataFile),
        ...domain.loadExtraDocs(),
      });
    }
  } catch (error) {
    result = deny(`Blocked because gate setup failed: ${error.message}`, { changedFiles: [] });
  }

  process.stdout.write(args && args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatText(result)}\n`);
  process.exitCode = result.allowed ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  DOMAINS,
  BLOCKED_PREFIXES,
  BLOCKED_EXACT_COMMON,
  FORBIDDEN_KEYS,
  evaluateBotDataAutoMergeGate,
  getChangedFiles,
};
