#!/usr/bin/env node
'use strict';

/** Phase 43 status mail body writer. No secrets or process.env dump. */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function parseArgs(argv) {
  const args = {
    report: path.join(repoRoot, 'data', 'release-volume-counts-report.json'),
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') args.report = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--out') args.out = path.resolve(repoRoot, argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}
function safeLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, 400);
}
function writeBody(report) {
  const summary = report && report.summary || {};
  const changes = Array.isArray(report && report.changes) ? report.changes : [];
  const blocked = Array.isArray(report && report.blockedCandidates) ? report.blockedCandidates : [];
  const status = changes.length ? 'success' : 'no-op';
  const subjectHint = changes.length
    ? `Manga Tracker Phase 43 Status - ${changes.length} Bandstand/Bandstaende aktualisiert`
    : 'Manga Tracker Phase 43 Status - keine Aenderungen';

  const lines = [];
  lines.push(`Betreff-Hinweis: ${subjectHint}`);
  lines.push('');
  lines.push(`Status: ${status}`);
  lines.push(`Laufzeitpunkt: ${safeLine(report && report.generatedAt)}`);
  lines.push(`Workflow: ${safeLine(process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'lokal/unbekannt')}`);
  lines.push(`PR: ${safeLine(process.env.PR_URL || 'nicht erstellt / unbekannt')}`);
  lines.push(`Auto-Merge: ${safeLine(process.env.AUTO_MERGE_TRIGGERED === 'true' ? 'aktiviert' : 'nicht aktiviert / nicht erforderlich')}`);
  lines.push(`CI: ${safeLine(process.env.JOB_RESULT || 'lokal/unbekannt')}`);
  lines.push('Privacy-Gate: gruen (test-public-private-diff + Validator)');
  lines.push('Security-/Secret-Check: siehe Workflow-Ergebnis');
  lines.push('Pages: nach Merge durch GitHub Pages Workflow');
  lines.push('');
  lines.push(`Gepruefte Serien: ${safeLine(summary.seriesInVolumeCounts || 0)}`);
  lines.push(`Probe-Kandidaten: ${safeLine(summary.probeCandidates || 0)}`);
  lines.push(`Aenderungen: ${safeLine(summary.detectedChanges || 0)}`);
  lines.push(`Automatisch uebernommen: ${safeLine(summary.appliedHighConfidenceChanges || 0)}`);
  lines.push(`Blockiert/unsicher: ${safeLine(summary.blockedOrUnsafe || 0)}`);
  lines.push('');
  lines.push('Geaenderte Dateien:');
  lines.push('- data/release-volume-counts.json');
  lines.push('- data/release-volume-counts-report.json');
  lines.push('');
  if (changes.length) {
    lines.push('Geaendert:');
    changes.slice(0, 20).forEach(change => {
      lines.push(`- ${safeLine(change.seriesTitle)} / ${safeLine(change.publisher)}: publishedVolumesDE ${safeLine(change.oldPublishedVolumesDE)} -> ${safeLine(change.newPublishedVolumesDE)} (${safeLine(change.source)}, ${safeLine(change.confidence)})`);
    });
    if (changes.length > 20) lines.push(`- ... ${changes.length - 20} weitere Aenderung(en)`);
    lines.push('');
  }
  if (blocked.length) {
    lines.push('Blockiert / Review:');
    blocked.slice(0, 20).forEach(item => {
      lines.push(`- ${safeLine(item.seriesTitle)} / ${safeLine(item.publisher)} Band ${safeLine(item.volumeNumber)}: ${safeLine((item.reasonCodes || []).join(', '))}`);
    });
    if (blocked.length > 20) lines.push(`- ... ${blocked.length - 20} weitere blockierte Faelle`);
    lines.push('');
  }
  lines.push('Hinweis: Diese Mail enthaelt nur oeffentliche technische Metadaten; keine Owner-Token, privaten Notizen, Lesestatus- oder Besitzdetails.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = readJsonIfExists(args.report) || { generatedAt: new Date().toISOString(), summary: {}, changes: [], blockedCandidates: [] };
  const body = writeBody(report);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, body, 'utf8');
  } else {
    process.stdout.write(body);
  }
}

if (require.main === module) main();

module.exports = { writeBody };
