'use strict';

/**
 * write-release-cache-status-mail.js — Phase 28
 *
 * Erstellt den Text-Inhalt der Status-Mail für den Notify-Job nach dem
 * Update-Release-Cache-Workflow.
 *
 * CLI:
 *   --report <path>   Pfad zum Pipeline-Report
 *                     (default: artifacts/release-cache-pipeline-report.json)
 *   --out <path>      Pfad zur Ausgabedatei
 *                     (default: $RUNNER_TEMP/release-cache-status-mail.txt oder /tmp/...)
 *
 * Erlaubte Report-Felder (explizite Whitelist):
 *   generatedAt, summary.candidatesDiscovered, summary.candidatesChecked,
 *   summary.highConfidence, summary.mediumConfidence, summary.lowConfidence,
 *   summary.blocked, summary.cachePatches, summary.reviewQueueWrites,
 *   summary.invalidExistingCache, autoMergeEligible
 *
 * Sicherheitsregeln:
 *   - Kein process.env-Dump (kein stringify aller Umgebungsvariablen)
 *   - Keine Secrets in der Ausgabe
 *   - Nur explizit benannte Env-Variablen werden gelesen
 *
 * Aufruf: node scripts/write-release-cache-status-mail.js [--report <path>] [--out <path>]
 */

const fs   = require('fs');
const path = require('path');

// ── Argumente parsen ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let reportPath = 'artifacts/release-cache-pipeline-report.json';
let outPath    = (process.env.RUNNER_TEMP || '/tmp') + '/release-cache-status-mail.txt';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report' && args[i + 1]) {
    reportPath = args[++i];
  } else if (args[i] === '--out' && args[i + 1]) {
    outPath = args[++i];
  }
}

// ── Nur explizit erlaubte Env-Variablen lesen ───────────────────────────────
// GITHUB_* sind vom Runner automatisch gesetzt; JOB_RESULT/PR_* werden vom Workflow übergeben.
const WORKFLOW   = process.env.GITHUB_WORKFLOW   || '(unknown workflow)';
const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPOSITORY = process.env.GITHUB_REPOSITORY || '(unknown repository)';
const RUN_ID     = process.env.GITHUB_RUN_ID     || '';
const REF_NAME   = process.env.GITHUB_REF_NAME   || '';
const SHA        = process.env.GITHUB_SHA        || '';

const JOB_RESULT           = process.env.JOB_RESULT            || 'unknown';
const PR_NUMBER            = process.env.PR_NUMBER             || '';  // eslint-disable-line no-unused-vars
const PR_URL               = process.env.PR_URL                || '';
const AUTO_MERGE_TRIGGERED = process.env.AUTO_MERGE_TRIGGERED === 'true';
const AUTO_MERGE_GATE_ALLOWED = process.env.AUTO_MERGE_GATE_ALLOWED || '';
const AUTO_MERGE_GATE_CLASS = process.env.AUTO_MERGE_GATE_CLASS || '';
const AUTO_MERGE_GATE_REASON = process.env.AUTO_MERGE_GATE_REASON || '';

// ── Run-Link ────────────────────────────────────────────────────────────────
const RUN_URL = RUN_ID
  ? SERVER_URL + '/' + REPOSITORY + '/actions/runs/' + RUN_ID
  : '';

// ── Report laden (nur Whitelist-Felder) ────────────────────────────────────
let reportSection = '';
const absReportPath = path.resolve(reportPath);

if (fs.existsSync(absReportPath)) {
  let rawReport = null;
  try {
    rawReport = JSON.parse(fs.readFileSync(absReportPath, 'utf-8'));
  } catch (_) {
    rawReport = null;
  }

  if (rawReport && typeof rawReport === 'object') {
    const s = (rawReport.summary && typeof rawReport.summary === 'object')
      ? rawReport.summary : {};

    // Explizit erlaubte Felder — kein spread, kein dump
    const generatedAt          = typeof rawReport.generatedAt          === 'string' ? rawReport.generatedAt          : '(unbekannt)';
    const candidatesDiscovered = typeof s.candidatesDiscovered          === 'number' ? s.candidatesDiscovered          : '?';
    const candidatesChecked    = typeof s.candidatesChecked             === 'number' ? s.candidatesChecked             : '?';
    const highConfidence       = typeof s.highConfidence                === 'number' ? s.highConfidence                : '?';
    const mediumConfidence     = typeof s.mediumConfidence              === 'number' ? s.mediumConfidence              : '?';
    const lowConfidence        = typeof s.lowConfidence                 === 'number' ? s.lowConfidence                 : '?';
    const blocked              = typeof s.blocked                       === 'number' ? s.blocked                       : '?';
    const cachePatches         = typeof s.cachePatches                  === 'number' ? s.cachePatches                  : '?';
    const reviewQueueWrites    = typeof s.reviewQueueWrites             === 'number' ? s.reviewQueueWrites             : '?';
    const invalidExisting      = typeof s.invalidExistingCache          === 'number' ? s.invalidExistingCache          : '?';
    const autoMergeEligible    = rawReport.autoMergeEligible === true   ? 'ja'        : 'nein';

    reportSection = [
      '',
      'Generated at: '           + generatedAt,
      'Candidates checked: '     + candidatesChecked + '/' + candidatesDiscovered,
      'High confidence: '        + highConfidence,
      'Medium confidence: '      + mediumConfidence,
      'Low confidence: '         + lowConfidence,
      'Blocked: '                + blocked,
      'Cache patches: '          + cachePatches,
      'Review queue writes: '    + reviewQueueWrites,
      'Invalid existing cache: ' + invalidExisting,
      'Auto-merge eligible: '    + autoMergeEligible,
    ].join('\n');

    const needsReviewHint = (
      (typeof s.reviewQueueWrites === 'number' && s.reviewQueueWrites > 0) ||
      (typeof s.blocked           === 'number' && s.blocked           > 0)
    );
    if (needsReviewHint) {
      reportSection += [
        '',
        '',
        'Hinweis:',
        'Medium/Low/Blocked-Kandidaten wurden nicht automatisch in den öffentlichen Cache übernommen.',
        'Bitte Review-Queue prüfen, falls Review queue writes > 0 oder Blocked > 0 ist.',
      ].join('\n');
    }
  } else {
    reportSection = '\n(Pipeline-Report nicht lesbar oder kein gültiges JSON)';
  }
} else {
  reportSection = '\n(Pipeline-Report nicht gefunden — Pipeline möglicherweise vor Artifact-Schritt gescheitert)';
}

// ── PR-Status bestimmen ─────────────────────────────────────────────────────
function prLine() {
  if (PR_URL && AUTO_MERGE_TRIGGERED) {
    return 'Pull Request: ' + PR_URL + '\n(Auto-Merge aktiviert — wird gemerged sobald CI grün)';
  }
  if (PR_URL) {
    return 'Pull Request: ' + PR_URL;
  }
  if (JOB_RESULT === 'failure') {
    return 'Pull Request: keiner (Pipeline vor PR-Erstellung gescheitert)';
  }
  return 'Pull Request: keiner (keine Änderungen erkannt)';
}

// ── Mail-Body zusammenbauen ─────────────────────────────────────────────────
const SHORT_SHA = SHA.length >= 7 ? SHA.slice(0, 7) : (SHA || '(unbekannt)');

const bodyParts = [
  'Manga Tracker Release-Cache Status',
  '',
  'Workflow: '   + WORKFLOW,
  'Job-Result: ' + JOB_RESULT,
  'Branch: '     + (REF_NAME || '(unbekannt)'),
  'Commit: '     + SHORT_SHA,
  'Run: '        + (RUN_URL || '(kein Run-Link verfügbar)'),
  reportSection,
  '',
  'Gate: ' + (AUTO_MERGE_GATE_ALLOWED ? (AUTO_MERGE_GATE_ALLOWED === 'true' ? 'allowed' : 'blocked') : '(nicht ausgefuehrt)'),
  'Gate-Klasse: ' + (AUTO_MERGE_GATE_CLASS || '(unbekannt)'),
  'Gate-Grund: ' + (AUTO_MERGE_GATE_REASON || '(unbekannt)'),
  '',
  prLine(),
];

const body = bodyParts.join('\n');

// ── Ausgabe schreiben ───────────────────────────────────────────────────────
const absOutPath = path.resolve(outPath);
const outDir = path.dirname(absOutPath);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

fs.writeFileSync(absOutPath, body, 'utf-8');
console.log('Status-Mail geschrieben: ' + absOutPath);
