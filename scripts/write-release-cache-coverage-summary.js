#!/usr/bin/env node
'use strict';

/**
 * write-release-cache-coverage-summary.js - Phase 22f
 *
 * Rendert den Release-Cache-Coverage-Report als GitHub-Actions-Step-Summary.
 * Das Script liest nur den CI-Report aus Phase 22e und erzeugt Markdown fuer
 * den Actions-Run. Es ergaenzt keine Release-Daten und erzeugt keine Fake-Daten.
 *
 * Aufruf:
 *   node scripts/write-release-cache-coverage-summary.js [--report artifacts/release-cache-coverage-report.json] [--out summary.md]
 *
 * Wenn GITHUB_STEP_SUMMARY gesetzt ist, wird die Summary dort angehaengt.
 * Mit --out kann die Markdown-Ausgabe zusaetzlich in eine Datei geschrieben werden.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} benoetigt einen Pfad`);
  return path.resolve(repoRoot, value);
}

const reportPath = argValue('--report', path.join(repoRoot, 'artifacts', 'release-cache-coverage-report.json'));
const outPath = argValue('--out', null);

function rel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function escapeMarkdown(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatBool(value) {
  return value ? 'ja' : 'nein';
}

function formatVolumes(volumes) {
  if (!Array.isArray(volumes) || volumes.length === 0) return '-';
  const sorted = Array.from(new Set(volumes)).sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const value = sorted[i];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = value;
    prev = value;
  }
  return ranges.join(', ');
}

function readReport() {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report nicht gefunden: ${rel(reportPath)}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!report || report.reportType !== 'release-cache-coverage-ci-report') {
    throw new Error('Unerwarteter oder ungueltiger Coverage-Report');
  }
  return report;
}

function renderGapList(title, gaps) {
  const rows = [`### ${title}`, ''];
  if (!Array.isArray(gaps) || gaps.length === 0) {
    rows.push('_Keine._', '');
    return rows;
  }
  rows.push('| Serie | Verlag | Band | Klassifizierung |');
  rows.push('|---|---|---:|---|');
  gaps.slice(0, 20).forEach(gap => {
    rows.push(`| ${escapeMarkdown(gap.seriesTitle)} | ${escapeMarkdown(gap.publisher || '-')} | ${gap.volumeNumber} | \`${escapeMarkdown(gap.classification)}\` |`);
  });
  if (gaps.length > 20) rows.push(`| ... | ... | ... | ${gaps.length - 20} weitere |`);
  rows.push('');
  return rows;
}

function renderSummary(report) {
  const summary = (report.current && report.current.summary) || {};
  const comparison = report.comparison || {};
  const counts = comparison.counts || {};
  const privacy = report.privacy || {};
  const classification = privacy.allowedClassification || (report.documented && report.documented.summary && report.documented.summary.classification) || 'source-data-gap';
  const matches = comparison.matchesDocumentedStand === true;
  const series = (report.current && report.current.affectedSeries) || [];
  const publishers = (report.current && report.current.affectedPublishers) || [];
  const artifactPath = rel(reportPath);

  const lines = [];
  lines.push('## Release-Cache-Coverage-Gaps');
  lines.push('');
  lines.push(matches
    ? 'Status: dokumentierter `source-data-gap`-Stand ist synchron.'
    : 'Status: Coverage-Gap-Drift erkannt - Dokumentation bewusst pruefen.');
  lines.push('');
  lines.push('| Kennzahl | Wert |');
  lines.push('|---|---:|');
  lines.push(`| Aktuelle Coverage-Luecken | ${summary.missingCacheCoverage} |`);
  lines.push(`| Betroffene Serien | ${summary.missingSeries} |`);
  lines.push(`| Betroffene Verlage | ${summary.missingPublishers} |`);
  lines.push(`| Neue Gaps | ${counts.newGaps} |`);
  lines.push(`| Verschwundene Gaps | ${counts.resolvedGaps} |`);
  lines.push(`| Dokumentierter Stand synchron | ${formatBool(matches)} |`);
  lines.push(`| Klassifizierung | \`${classification}\` |`);
  lines.push('');

  lines.push('### Betroffene Serien');
  lines.push('');
  lines.push('| Serie | Verlag | Fehlende Baende | Anzahl | Klassifizierung |');
  lines.push('|---|---|---:|---:|---|');
  series.forEach(group => {
    lines.push(`| ${escapeMarkdown(group.seriesTitle)} | ${escapeMarkdown(group.publisher || '-')} | ${formatVolumes(group.missingVolumes)} | ${group.missingCount} | \`${escapeMarkdown(group.classification || classification)}\` |`);
  });
  if (series.length === 0) lines.push('| - | - | - | 0 | - |');
  lines.push('');

  lines.push('### Betroffene Verlage');
  lines.push('');
  lines.push('| Verlag | Luecken | Serien |');
  lines.push('|---|---:|---:|');
  publishers.forEach(group => {
    lines.push(`| ${escapeMarkdown(group.publisher)} | ${group.missingCount} | ${group.seriesCount} |`);
  });
  if (publishers.length === 0) lines.push('| - | 0 | 0 |');
  lines.push('');

  lines.push(...renderGapList('Neue Gaps', comparison.newGaps));
  lines.push(...renderGapList('Verschwundene Gaps', comparison.resolvedGaps));

  lines.push('### Artefakt und Sicherheit');
  lines.push('');
  lines.push(`- Artefakt: \`${artifactPath}\` (GitHub Actions Artifact: \`release-cache-coverage-report\`)`);
  lines.push(`- Keine Fake-Daten erzeugt: ${privacy.addsReleaseData === false ? 'ja' : 'unbekannt'}`);
  lines.push(`- Keine privaten Sammlungsdaten enthalten: ${privacy.containsPrivateCollectionData === false ? 'ja' : 'unbekannt'}`);
  lines.push('- Bekannte `source-data-gap`-Luecken bleiben Warnzustand und lassen den normalen Workflow nicht scheitern.');
  lines.push('');

  return lines.join(os.EOL);
}

try {
  const report = readReport();
  const markdown = renderSummary(report) + os.EOL;
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, markdown, 'utf8');
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
  }
  console.log(markdown);
} catch (e) {
  console.error(`\nERROR: Release-Cache-Coverage-Summary fehlgeschlagen: ${e.message}\n`);
  process.exit(1);
}
