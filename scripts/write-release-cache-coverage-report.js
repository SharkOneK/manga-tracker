#!/usr/bin/env node
'use strict';

/**
 * write-release-cache-coverage-report.js - Phase 22e
 *
 * Schreibt den maschinenlesbaren Release-Cache-Coverage-Gap-Report fuer CI.
 * Bekannte `source-data-gap`-Luecken bleiben Warnzustand; dieses Script macht
 * den Stand als Artefakt und als Vergleich gegen die Dokumentation sichtbar.
 *
 * Aufruf:
 *   node scripts/write-release-cache-coverage-report.js [--out artifacts/release-cache-coverage-report.json] [--fail-on-drift]
 *
 * Exit 0 = Report geschrieben (auch bei bekannten source-data-gap-Luecken)
 * Exit 1 = Report konnte nicht erzeugt werden oder --fail-on-drift findet Docs-Drift
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');
const gapsDocPath = path.join(repoRoot, 'docs', 'release-cache-coverage-gaps.md');
const defaultOutPath = path.join(repoRoot, 'artifacts', 'release-cache-coverage-report.json');

const args = process.argv.slice(2);
const failOnDrift = args.includes('--fail-on-drift');

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} benoetigt einen Pfad`);
  return path.resolve(repoRoot, value);
}

const outPath = argValue('--out', defaultOutPath);

function normalizeText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function gapKey(seriesTitle, publisher, volumeNumber) {
  return [normalizeText(seriesTitle), normalizeText(publisher || 'Unbekannter Verlag'), volumeNumber].join('|');
}

function parseAuditJsonStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('Audit --json muss ausschliesslich ein JSON-Objekt auf stdout schreiben');
  }
  return JSON.parse(trimmed);
}

function runAuditJson() {
  const stdout = cp.execFileSync(process.execPath, [auditScript, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseAuditJsonStdout(stdout);
}

function parseNumberFromDoc(doc, label) {
  const re = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`);
  const match = doc.match(re);
  if (!match) throw new Error(`Docs: Kennzahl "${label}" fehlt`);
  return Number(match[1]);
}

function parseVolumeList(value) {
  const result = [];
  String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/u);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        const step = start <= end ? 1 : -1;
        for (let n = start; step > 0 ? n <= end : n >= end; n += step) result.push(n);
        return;
      }
      const single = part.match(/^\d+$/);
      if (single) result.push(Number(part));
    });
  return result;
}

function extractSectionRows(doc, heading) {
  const start = doc.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Docs: Abschnitt "${heading}" fehlt`);
  const rest = doc.slice(start).split(/\r?\n/);
  const rows = [];
  let inTable = false;
  for (const line of rest.slice(1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim()) {
      if (inTable) break;
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    inTable = true;
    if (/^\|\s*-/.test(line) || /^\|\s*Serie\s*\|/.test(line)) continue;
    rows.push(line);
  }
  return rows;
}

function parseDocumentedStand() {
  if (!fs.existsSync(gapsDocPath)) throw new Error('docs/release-cache-coverage-gaps.md fehlt');
  const doc = fs.readFileSync(gapsDocPath, 'utf8');
  const summary = {
    missingCacheCoverage: parseNumberFromDoc(doc, 'Verbleibende Luecken'),
    missingSeries: parseNumberFromDoc(doc, 'Betroffene Serien'),
    missingPublishers: parseNumberFromDoc(doc, 'Betroffene Verlage'),
    classification: 'source-data-gap',
  };

  const gaps = [];
  extractSectionRows(doc, 'Luecken nach Serie').forEach(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 5) return;
    const [seriesTitle, publisher, volumeText, countText, classification] = cells;
    const volumes = parseVolumeList(volumeText);
    const expectedCount = Number(countText);
    if (Number.isInteger(expectedCount) && expectedCount !== volumes.length) {
      throw new Error(`Docs: Anzahl passt nicht zu Baenden fuer ${seriesTitle}`);
    }
    volumes.forEach(volumeNumber => {
      gaps.push({
        seriesTitle,
        publisher,
        volumeNumber,
        classification,
        key: gapKey(seriesTitle, publisher, volumeNumber),
      });
    });
  });

  return {
    source: path.relative(repoRoot, gapsDocPath).replace(/\\/g, '/'),
    summary,
    gaps,
  };
}

function compareGaps(auditReport, documented) {
  const currentGaps = (auditReport.missing || []).map(item => ({
    seriesTitle: item.seriesTitle,
    publisher: item.publisher || null,
    volumeNumber: item.volumeNumber,
    classification: item.classification,
    key: gapKey(item.seriesTitle, item.publisher || 'Unbekannter Verlag', item.volumeNumber),
  }));
  const currentByKey = new Map(currentGaps.map(item => [item.key, item]));
  const documentedByKey = new Map(documented.gaps.map(item => [item.key, item]));

  const newGaps = currentGaps.filter(item => !documentedByKey.has(item.key));
  const resolvedGaps = documented.gaps.filter(item => !currentByKey.has(item.key));
  const unchangedGaps = currentGaps.filter(item => documentedByKey.has(item.key));
  const summary = auditReport.summary || {};
  const allCurrentSourceDataGaps = currentGaps.every(item => item.classification === documented.summary.classification);
  const summaryMatches =
    summary.missingCacheCoverage === documented.summary.missingCacheCoverage &&
    summary.missingSeries === documented.summary.missingSeries &&
    summary.missingPublishers === documented.summary.missingPublishers;

  return {
    matchesDocumentedStand: summaryMatches && newGaps.length === 0 && resolvedGaps.length === 0 && allCurrentSourceDataGaps,
    summaryMatches,
    allCurrentGapsUseDocumentedClassification: allCurrentSourceDataGaps,
    counts: {
      currentGaps: currentGaps.length,
      documentedGaps: documented.gaps.length,
      unchangedGaps: unchangedGaps.length,
      newGaps: newGaps.length,
      resolvedGaps: resolvedGaps.length,
    },
    newGaps,
    resolvedGaps,
  };
}

function sortedSeries(groups) {
  return (groups || []).map(group => ({
    seriesTitle: group.seriesTitle,
    publisher: group.publisher,
    missingCount: group.missingCount,
    missingVolumes: group.missingVolumes,
    classification: group.classification,
  })).sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, 'de'));
}

function buildCiReport() {
  const auditReport = runAuditJson();
  const documented = parseDocumentedStand();
  const comparison = compareGaps(auditReport, documented);
  return {
    schemaVersion: 1,
    reportType: 'release-cache-coverage-ci-report',
    generatedAt: new Date().toISOString(),
    mode: 'warn',
    status: comparison.matchesDocumentedStand ? 'documented-source-data-gaps' : 'coverage-gap-drift',
    privacy: {
      containsPrivateCollectionData: false,
      addsReleaseData: false,
      allowedClassification: 'source-data-gap',
    },
    files: {
      auditScript: path.relative(repoRoot, auditScript).replace(/\\/g, '/'),
      documentedGaps: documented.source,
    },
    current: {
      summary: auditReport.summary,
      affectedSeries: sortedSeries(auditReport.missingBySeries),
      affectedPublishers: auditReport.missingByPublisher || [],
      gaps: (auditReport.missing || []).map(item => ({
        seriesTitle: item.seriesTitle,
        publisher: item.publisher,
        volumeNumber: item.volumeNumber,
        classification: item.classification,
        watchlistEntryIndex: item.watchlistEntryIndex,
      })),
    },
    documented,
    comparison,
  };
}

function printHumanSummary(report) {
  const s = report.current.summary || {};
  const c = report.comparison;
  console.log('\nRelease-Cache-Coverage-Gap-Report (Phase 22e)\n');
  console.log(`Report: ${path.relative(repoRoot, outPath).replace(/\\/g, '/')}`);
  console.log(`Aktuelle Luecken: ${s.missingCacheCoverage}`);
  console.log(`Betroffene Serien: ${s.missingSeries}`);
  console.log(`Betroffene Verlage: ${s.missingPublishers}`);
  console.log(`Neue Gaps: ${c.counts.newGaps}`);
  console.log(`Verschwundene Gaps: ${c.counts.resolvedGaps}`);
  console.log(`Dokumentierter Stand synchron: ${c.matchesDocumentedStand ? 'ja' : 'nein'}`);
  console.log('');
}

function appendGitHubStepSummary(report) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const s = report.current.summary || {};
  const c = report.comparison;
  const lines = [
    '## Release-Cache-Coverage-Gaps',
    '',
    '| Kennzahl | Wert |',
    '|---|---:|',
    `| Aktuelle Luecken | ${s.missingCacheCoverage} |`,
    `| Betroffene Serien | ${s.missingSeries} |`,
    `| Betroffene Verlage | ${s.missingPublishers} |`,
    `| Neue Gaps | ${c.counts.newGaps} |`,
    `| Verschwundene Gaps | ${c.counts.resolvedGaps} |`,
    `| Dokumentierter Stand synchron | ${c.matchesDocumentedStand ? 'ja' : 'nein'} |`,
    '',
    `Artefakt: \`${path.relative(repoRoot, outPath).replace(/\\/g, '/')}\``,
    '',
  ];
  fs.appendFileSync(target, lines.join(os.EOL), 'utf8');
}

try {
  const report = buildCiReport();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  printHumanSummary(report);
  if (failOnDrift && !report.comparison.matchesDocumentedStand) {
    console.error('Coverage-Gap-Drift erkannt (--fail-on-drift).');
    process.exit(1);
  }
} catch (e) {
  console.error(`\n❌ Release-Cache-Coverage-Report fehlgeschlagen: ${e.message}\n`);
  process.exit(1);
}
