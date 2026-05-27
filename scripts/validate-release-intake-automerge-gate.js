#!/usr/bin/env node
'use strict';

/**
 * Release-Intake auto-merge gate — Phase 46g.
 *
 * Holt die in Phase 36c zurückgestellte Auto-Merge-Stufe für den
 * Release-Intake nach. Spiegelt das Phase-45-Vorgehen (gate-first, default-deny)
 * für den fachlich risikoärmeren Watchlist-Intake.
 *
 * Auto-merge-fähig ist NUR ein eng geschnittenes "generated bundle":
 *   - data/release-watchlist.json            (additive Watchlist-Adds)
 *   - data/release-source-review-queue.json  (additive pending-Einträge)
 *   - docs/release-cache-coverage-gaps.md        (deterministisch aus Audit)
 *   - docs/release-cache-source-gap-analysis.md  (deterministisch aus Audit)
 *
 * Die beiden Coverage-Docs sind über das Live-Audit (validate-release-cache-
 * coverage-gaps.js) fest an die Watchlist gekoppelt: Eine Watchlist-Ergänzung
 * erzeugt zwangsläufig Doc-Drift. Deshalb werden die generierten Docs als
 * verifizierbares Daten-Bundle mit aufgenommen — aber nur, wenn sie EXAKT dem
 * deterministischen Audit-Stand entsprechen (coverageDocsConsistent). Jeder
 * andere Pfad (scripts/*, src/*, .github/*, supabase/*, vendor/*, andere docs,
 * release-cache.json, release-sources.json) bleibt hart blockiert.
 *
 * Jeder unklare Zustand ist default-deny.
 *
 * Nutzung:
 *   node scripts/validate-release-intake-automerge-gate.js [--base <ref>] [--json]
 *   node scripts/validate-release-intake-automerge-gate.js --changed-files a,b,c
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

const WATCHLIST_PATH = 'data/release-watchlist.json';
const REVIEW_QUEUE_PATH = 'data/release-source-review-queue.json';
const COVERAGE_GAPS_DOC = 'docs/release-cache-coverage-gaps.md';
const SOURCE_GAP_ANALYSIS_DOC = 'docs/release-cache-source-gap-analysis.md';

const ALLOWLIST = new Set([
  WATCHLIST_PATH,
  REVIEW_QUEUE_PATH,
  COVERAGE_GAPS_DOC,
  SOURCE_GAP_ANALYSIS_DOC,
]);

const ALLOWED_DOCS = new Set([COVERAGE_GAPS_DOC, SOURCE_GAP_ANALYSIS_DOC]);

const BLOCKED_EXACT = new Set([
  'data/release-cache.json',
  'data/release-sources.json',
  'data/release-cache-pipeline-report.json',
  'data/release-volume-counts.json',
  'index.html',
]);

const BLOCKED_PREFIXES = [
  'scripts/',
  'src/',
  'supabase/',
  '.github/',
  'vendor/',
];

// Erlaubte Allowlist-Felder eines Watchlist-Eintrags (Phase 22-Schema).
const ALLOWED_WATCHLIST_FIELDS = new Set([
  'seriesTitle',
  'publisher',
  'volumeNumber',
  'volumeNumbers',
  'sourceUrl',
  'notes',
  'enabled',
]);

// Niemals in einer öffentlichen Watchlist erlaubt (PII / private Sammlungsdaten).
const PRIVATE_FIELD_NAMES = new Set([
  'owner', 'ownerId', 'owner_token', 'view_token', 'userId', 'collectionId',
  'collection_id', 'email', 'mail', 'password', 'token', 'secret', 'apikey',
  'apiKey', 'accessToken', 'refreshToken', 'supabaseKey', 'jwt', 'session',
  'owned', 'total', 'read', 'readStatus', 'readAt', 'boughtAt', 'collectionStatus',
  'status', 'rating', 'personalNotes', 'privateNotes', 'isbn13', 'mpEditionId',
  'bands', 'data',
]);

// reviewStatus-Werte, die für neu hinzugefügte Queue-Einträge erlaubt sind.
// safeToPatch=true wird separat hart blockiert (kein Auto-Patch-Pfad via Intake).
const ALLOWED_NEW_QUEUE_REVIEW_STATUS = new Set([
  'pending',
  'needs-source',
  'needs-second-source',
  'in-review',
  'deferred',
]);

const SPECIAL_EDITION_RE = /\b(box|boxset|box-set|sammelband|sonderausgabe|sonderband|artbook|art book|novel|light novel|variant|limited|collector|deluxe|neuauflage|neuausgabe|new edition|master edition|perfect edition|massiv|doppelband|doppelband-edition)\b/i;

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function deny(reason, extra = {}) {
  return { allowed: false, class: 'manual-review-required', reason, ...extra };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJsonInput(value, label) {
  if (value === undefined || value === null) throw new Error(`${label} fehlt`);
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function watchlistItems(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.items)) return doc.items;
  return [];
}

function queueItems(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.queue)) return doc.queue;
  if (doc && Array.isArray(doc.items)) return doc.items;
  return [];
}

// Kanonische, schlüssel-sortierte JSON-Signatur eines Eintrags. So erkennen wir
// jede inhaltliche Änderung (Edit) und jede Löschung eines bestehenden Eintrags
// als "verschwundene Signatur" → default-deny.
function canonicalSignature(entry) {
  return JSON.stringify(canonicalize(entry));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function multisetCounts(signatures) {
  const counts = new Map();
  for (const sig of signatures) counts.set(sig, (counts.get(sig) || 0) + 1);
  return counts;
}

/**
 * Liefert { removed, added } als Listen von Einträgen, wobei "removed" alle
 * Vorher-Einträge sind, die im Nachher fehlen (Löschung ODER Edit), und "added"
 * alle echten Neuzugänge.
 */
function diffEntries(beforeEntries, afterEntries) {
  const beforeSig = beforeEntries.map(canonicalSignature);
  const afterSig = afterEntries.map(canonicalSignature);
  const beforeCounts = multisetCounts(beforeSig);
  const afterCounts = multisetCounts(afterSig);

  // Pro-Instanz-Matching: jede Vorher-Signatur, für die im Nachher keine
  // Instanz mehr übrig ist, gilt als entfernt (Löschung ODER Feld-Edit).
  const removed = [];
  const afterRemaining = new Map(afterCounts);
  beforeEntries.forEach((entry, i) => {
    const sig = beforeSig[i];
    const remaining = afterRemaining.get(sig) || 0;
    if (remaining > 0) {
      afterRemaining.set(sig, remaining - 1);
    } else {
      removed.push(entry);
    }
  });

  const beforeRemaining = new Map(beforeCounts);
  const added = [];
  afterEntries.forEach((entry, i) => {
    const sig = afterSig[i];
    const remaining = beforeRemaining.get(sig) || 0;
    if (remaining > 0) {
      beforeRemaining.set(sig, remaining - 1);
    } else {
      added.push(entry);
    }
  });

  return { removed, added };
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

function validateNewWatchlistEntry(entry, label) {
  const errors = [];
  if (!isPlainObject(entry)) return [`${label} ist kein Objekt.`];

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_WATCHLIST_FIELDS.has(key)) {
      errors.push(`${label}.${key} ist kein erlaubtes Watchlist-Feld.`);
    }
  }

  const privateFields = collectPrivateFields(entry);
  if (privateFields.length) errors.push(`${label} enthält private Felder: ${privateFields.join(', ')}.`);

  if (!hasText(entry.seriesTitle)) errors.push(`${label}.seriesTitle fehlt oder ist leer.`);
  if (!hasText(entry.publisher)) errors.push(`${label}.publisher fehlt oder ist leer.`);

  const hasVolumeNumber = Object.prototype.hasOwnProperty.call(entry, 'volumeNumber');
  const hasVolumeNumbers = Object.prototype.hasOwnProperty.call(entry, 'volumeNumbers');
  if (hasVolumeNumber && hasVolumeNumbers) {
    errors.push(`${label} darf nicht volumeNumber UND volumeNumbers setzen.`);
  } else if (hasVolumeNumber) {
    if (!Number.isInteger(entry.volumeNumber) || entry.volumeNumber < 1) {
      errors.push(`${label}.volumeNumber muss ein positiver Integer sein.`);
    }
  } else if (hasVolumeNumbers) {
    if (!Array.isArray(entry.volumeNumbers) || entry.volumeNumbers.length === 0) {
      errors.push(`${label}.volumeNumbers muss ein nicht-leeres Array sein.`);
    } else if (!entry.volumeNumbers.every(v => Number.isInteger(v) && v >= 1)) {
      errors.push(`${label}.volumeNumbers muss positive Integer enthalten.`);
    }
  } else {
    errors.push(`${label} muss volumeNumber oder volumeNumbers enthalten.`);
  }

  if (typeof entry.enabled !== 'boolean') errors.push(`${label}.enabled muss boolean sein.`);

  if (entry.sourceUrl !== null && entry.sourceUrl !== undefined) {
    if (typeof entry.sourceUrl !== 'string' || !/^https:\/\//.test(entry.sourceUrl)) {
      errors.push(`${label}.sourceUrl muss null oder eine https-URL sein.`);
    }
  }

  if (entry.notes !== undefined && entry.notes !== null && typeof entry.notes !== 'string') {
    errors.push(`${label}.notes muss ein String sein.`);
  }

  if (hasText(entry.seriesTitle) && SPECIAL_EDITION_RE.test(entry.seriesTitle)) {
    errors.push(`${label}.seriesTitle sieht nach Sonderausgabe/Sammelband/Neuauflage aus.`);
  }

  return errors;
}

function validateNewQueueEntry(entry, label) {
  const errors = [];
  if (!isPlainObject(entry)) return [`${label} ist kein Objekt.`];

  const privateFields = collectPrivateFields(entry);
  if (privateFields.length) errors.push(`${label} enthält private Felder: ${privateFields.join(', ')}.`);

  if (entry.safeToPatch === true) {
    errors.push(`${label}.safeToPatch=true ist im Intake-Auto-Merge nicht erlaubt (kein Auto-Patch-Pfad).`);
  }
  if (!ALLOWED_NEW_QUEUE_REVIEW_STATUS.has(entry.reviewStatus)) {
    errors.push(`${label}.reviewStatus ${JSON.stringify(entry.reviewStatus)} ist für neue Queue-Einträge nicht erlaubt.`);
  }
  if (hasText(entry.releaseDate)) {
    errors.push(`${label} darf für neue pending-Einträge kein releaseDate behaupten.`);
  }
  if (!hasText(entry.seriesTitle)) errors.push(`${label}.seriesTitle fehlt.`);
  if (!hasText(entry.publisher)) errors.push(`${label}.publisher fehlt.`);

  return errors;
}

/**
 * Reine Gate-Logik (testbar, ohne I/O).
 */
function evaluateIntakeAutoMergeGate({
  changedFiles,
  beforeWatchlist = { items: [] },
  afterWatchlist = { items: [] },
  beforeQueue = { queue: [] },
  afterQueue = { queue: [] },
  coverageDocsConsistent,
}) {
  const normalizedChangedFiles = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))].sort();
  const base = { changedFiles: normalizedChangedFiles };

  try {
    if (normalizedChangedFiles.length === 0) {
      return deny('Blockiert: keine geänderten Dateien übergeben.', base);
    }

    // 1) Datei-Allowlist strikt durchsetzen.
    for (const file of normalizedChangedFiles) {
      if (BLOCKED_EXACT.has(file)) {
        return deny(`Blockiert: ${file} darf nicht im Intake-Auto-Merge geändert werden.`, base);
      }
      const blockedPrefix = BLOCKED_PREFIXES.find(prefix => file.startsWith(prefix));
      if (blockedPrefix) {
        return deny(`Blockiert: ${blockedPrefix}-Änderungen sind im Intake-Auto-Merge nicht erlaubt.`, base);
      }
      if (file.startsWith('docs/') && !ALLOWED_DOCS.has(file)) {
        return deny(`Blockiert: ${file} ist kein erlaubtes generiertes Coverage-Doc.`, base);
      }
      if (!ALLOWLIST.has(file)) {
        return deny(`Blockiert: ${file} ist nicht in der Phase-46g-Allowlist.`, base);
      }
    }

    const beforeWl = watchlistItems(parseJsonInput(beforeWatchlist, 'Vorher-Watchlist'));
    const afterWl = watchlistItems(parseJsonInput(afterWatchlist, 'Nachher-Watchlist'));
    const beforeQ = queueItems(parseJsonInput(beforeQueue, 'Vorher-Queue'));
    const afterQ = queueItems(parseJsonInput(afterQueue, 'Nachher-Queue'));

    // 2) Privacy-Regression in der gesamten Watchlist verhindern.
    const beforeWlPrivate = collectPrivateFields(parseJsonInput(beforeWatchlist, 'Vorher-Watchlist'));
    const afterWlPrivate = collectPrivateFields(parseJsonInput(afterWatchlist, 'Nachher-Watchlist'));
    if (afterWlPrivate.length > beforeWlPrivate.length) {
      return deny(`Blockiert: neue private Felder in der Watchlist: ${afterWlPrivate.join(', ')}.`, base);
    }

    // 3) Watchlist additiv: keine Löschung/keine Feldänderung bestehender Einträge.
    const wlDiff = diffEntries(beforeWl, afterWl);
    if (wlDiff.removed.length > 0) {
      return deny('Blockiert: bestehende Watchlist-Einträge wurden gelöscht oder verändert (nur additive Adds sind auto-merge-fähig).', {
        ...base,
        removedWatchlistEntries: wlDiff.removed.length,
      });
    }

    const errors = [];
    wlDiff.added.forEach((entry, index) => {
      errors.push(...validateNewWatchlistEntry(entry, `neuer Watchlist-Eintrag ${index + 1}`));
    });

    // 4) Review-Queue additiv: keine Löschung/Edit; neue Einträge nur pending, kein safeToPatch.
    const qDiff = diffEntries(beforeQ, afterQ);
    if (qDiff.removed.length > 0) {
      return deny('Blockiert: bestehende Review-Queue-Einträge wurden gelöscht oder verändert.', {
        ...base,
        removedQueueEntries: qDiff.removed.length,
      });
    }
    qDiff.added.forEach((entry, index) => {
      errors.push(...validateNewQueueEntry(entry, `neuer Review-Queue-Eintrag ${index + 1}`));
    });

    if (errors.length) {
      return deny('Blockiert: Phase-46g-Datengate fehlgeschlagen.', {
        ...base,
        addedWatchlistEntries: wlDiff.added.length,
        addedQueueEntries: qDiff.added.length,
        errors,
      });
    }

    // 5) Coverage-Docs müssen exakt dem Live-Audit entsprechen (sonst Doc/Watchlist-Drift).
    if (coverageDocsConsistent !== true) {
      return deny('Blockiert: Coverage-Docs sind nicht synchron zum Live-Audit (validate-release-cache-coverage-gaps).', {
        ...base,
        addedWatchlistEntries: wlDiff.added.length,
        addedQueueEntries: qDiff.added.length,
      });
    }

    // 6) Mindestens eine echte additive Änderung muss vorliegen (sonst kein PR-Grund).
    if (wlDiff.added.length === 0 && qDiff.added.length === 0) {
      return deny('Blockiert: keine additive Watchlist-/Queue-Änderung gefunden.', base);
    }

    const affectedSeries = [...new Set(wlDiff.added.map(e => e && e.seriesTitle).filter(Boolean))];

    return {
      allowed: true,
      class: 'intake-watchlist-additive-only',
      reason: 'Nur erlaubte generierte Daten/Doc-Dateien geändert; Watchlist- und Queue-Änderungen sind rein additiv mit Allowlist-Feldern, und die Coverage-Docs entsprechen exakt dem Live-Audit.',
      ...base,
      addedWatchlistEntries: wlDiff.added.length,
      addedQueueEntries: qDiff.added.length,
      affectedSeries,
    };
  } catch (error) {
    return deny(`Blockiert: Intake-Auto-Merge-Gate konnte nicht sicher auswerten: ${error.message}`, base);
  }
}

// ── CLI / I/O-Schicht ─────────────────────────────────────────────────────────

function readJsonFile(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readJsonFromGit(ref, relativePath) {
  try {
    const output = execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(output);
  } catch (_) {
    // Datei existierte in der Basis nicht → als leer behandeln.
    return relativePath === REVIEW_QUEUE_PATH ? { queue: [] } : { items: [] };
  }
}

function gitLines(args) {
  const output = execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.split(/\r?\n/).map(normalizePath).filter(Boolean);
}

function getChangedFiles(baseRef = 'main') {
  return [...new Set(gitLines(['diff', '--name-only', `${baseRef}...HEAD`]))];
}

function checkCoverageDocsConsistent() {
  try {
    execFileSync('node', ['scripts/validate-release-cache-coverage-gaps.js'], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function parseArgs(argv) {
  const args = { json: false, base: process.env.AUTO_MERGE_GATE_BASE || 'main', changedFiles: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--changed-file') {
      args.changedFiles = args.changedFiles || [];
      args.changedFiles.push(argv[++i]);
    } else if (arg === '--changed-files') {
      args.changedFiles = argv[++i].split(',').map(normalizePath).filter(Boolean);
    } else {
      throw new Error(`Unbekanntes Argument: ${arg}`);
    }
  }
  return args;
}

function formatText(result) {
  const lines = [];
  lines.push('Release-Intake Auto-Merge Gate (Phase 46g)');
  lines.push('');
  lines.push(`Decision: ${result.allowed ? 'AUTO-MERGE ALLOWED' : 'MANUAL REVIEW REQUIRED'}`);
  lines.push(`PR class: ${result.class}`);
  lines.push(`Reason: ${result.reason}`);
  lines.push('');
  lines.push('PR changed files:');
  for (const file of result.changedFiles || []) lines.push(`- ${file}`);
  if (typeof result.addedWatchlistEntries === 'number') lines.push(`Added watchlist entries: ${result.addedWatchlistEntries}`);
  if (typeof result.addedQueueEntries === 'number') lines.push(`Added review-queue entries: ${result.addedQueueEntries}`);
  if (Array.isArray(result.affectedSeries) && result.affectedSeries.length) {
    lines.push(`Affected series: ${result.affectedSeries.join(', ')}`);
  }
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
    const changedFiles = args.changedFiles || getChangedFiles(args.base);
    result = evaluateIntakeAutoMergeGate({
      changedFiles,
      beforeWatchlist: readJsonFromGit(args.base, WATCHLIST_PATH),
      afterWatchlist: readJsonFile(WATCHLIST_PATH),
      beforeQueue: readJsonFromGit(args.base, REVIEW_QUEUE_PATH),
      afterQueue: readJsonFile(REVIEW_QUEUE_PATH),
      coverageDocsConsistent: checkCoverageDocsConsistent(),
    });
  } catch (error) {
    result = deny(`Blockiert: Intake-Auto-Merge-Gate-Setup fehlgeschlagen: ${error.message}`, { changedFiles: [] });
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
  ALLOWED_DOCS,
  BLOCKED_EXACT,
  BLOCKED_PREFIXES,
  ALLOWED_WATCHLIST_FIELDS,
  ALLOWED_NEW_QUEUE_REVIEW_STATUS,
  evaluateIntakeAutoMergeGate,
  getChangedFiles,
};
