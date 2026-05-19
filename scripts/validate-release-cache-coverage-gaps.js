#!/usr/bin/env node
'use strict';

/**
 * validate-release-cache-coverage-gaps.js - Phase 22d
 *
 * CI-/Docs-Stabilisierung fuer bekannte Release-Cache-Coverage-Luecken.
 *
 * Dieses Script behandelt dokumentierte `source-data-gap`-Luecken nicht als
 * Release-Cache-Fehler. Es prueft stattdessen, dass der maschinenlesbare
 * Audit-Report parsebar/stabil ist und die Dokumentation synchron bleibt.
 *
 * Exit 0 = JSON-Audit und Docs sind konsistent
 * Exit 1 = Schema-/Docs-Drift oder unerwartete Klassifikation
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');
const reportWriterScript = path.join(repoRoot, 'scripts', 'write-release-cache-coverage-report.js');
const summaryWriterScript = path.join(repoRoot, 'scripts', 'write-release-cache-coverage-summary.js');
const gapsDocPath = path.join(repoRoot, 'docs', 'release-cache-coverage-gaps.md');
const sourceGapAnalysisDocPath = path.join(repoRoot, 'docs', 'release-cache-source-gap-analysis.md');

const EXPECTED = {
  missingCacheCoverage: 34,
  missingSeries: 12,
  missingPublishers: 8,
  classification: 'source-data-gap',
};

const VALID_SUSPECTED_CAUSES = new Set([
  'title-normalization',
  'publisher-normalization',
  'edition-mismatch',
  'volume-numbering-mismatch',
  'source-missing',
  'parser-miss',
  'manual-source-required',
  'not-yet-released',
  'unknown',
]);

const VALID_RECOMMENDED_FIXES = new Set([
  'add-alias',
  'add-publisher-normalization',
  'add-edition-fingerprint',
  'add-source-url',
  'manual-source-review',
  'no-action-yet',
]);

let totalErrors = 0;
function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.error('  ✗ ' + msg); totalErrors++; }

function parseAuditJsonStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('Audit --json muss ausschliesslich ein JSON-Objekt auf stdout schreiben');
  }

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Audit --json ist nicht parsebar: ${e.message}`);
  }
}

function runAuditJson() {
  let stdout;
  try {
    stdout = cp.execFileSync(process.execPath, [auditScript, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`Audit --json darf im Warnmodus nicht fehlschlagen: ${e.message}`);
  }

  return parseAuditJsonStdout(stdout);
}

function validateStrictJsonMode() {
  try {
    cp.execFileSync(process.execPath, [auditScript, '--json', '--strict'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fail('Audit --json --strict muss bei dokumentierten Luecken mit Exit 1 enden');
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString('utf8') : '';
    const strictReport = parseAuditJsonStdout(stdout);
    if (!strictReport.summary || strictReport.summary.exitCode !== 1) {
      fail('Audit --json --strict muss summary.exitCode 1 liefern');
    } else {
      pass('Audit --json --strict bleibt parsebar und signalisiert Exit 1 nur im Strict-Modus');
    }
  }
}

function assertNumber(obj, key) {
  if (!Number.isInteger(obj[key]) || obj[key] < 0) {
    fail(`summary.${key} muss ein nicht-negativer Integer sein`);
  }
}

function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('Audit-Report muss ein JSON-Objekt sein');
    return;
  }
  if (report.schemaVersion !== 1) fail('schemaVersion muss 1 sein');
  if (!report.summary || typeof report.summary !== 'object') fail('summary fehlt');
  if (!Array.isArray(report.checked)) fail('checked muss ein Array sein');
  if (!Array.isArray(report.found)) fail('found muss ein Array sein');
  if (!Array.isArray(report.missing)) fail('missing muss ein Array sein');
  if (!Array.isArray(report.missingBySeries)) fail('missingBySeries muss ein Array sein');
  if (!Array.isArray(report.missingByPublisher)) fail('missingByPublisher muss ein Array sein');

  const summary = report.summary || {};
  [
    'enabledWatchlistEntries',
    'expandedWatchlistVolumeCandidates',
    'cacheEntries',
    'foundCacheEntries',
    'missingCacheCoverage',
    'missingSeries',
    'missingPublishers',
    'exitCode',
  ].forEach(key => assertNumber(summary, key));

  if (summary.exitCode !== 0) fail('Warnmodus ohne --strict muss summary.exitCode 0 liefern');
  if ((report.found || []).length !== summary.foundCacheEntries) fail('found.length passt nicht zu summary.foundCacheEntries');
  if ((report.missing || []).length !== summary.missingCacheCoverage) fail('missing.length passt nicht zu summary.missingCacheCoverage');
  if ((report.checked || []).length !== summary.expandedWatchlistVolumeCandidates) fail('checked.length passt nicht zu summary.expandedWatchlistVolumeCandidates');
  if ((report.found || []).length + (report.missing || []).length !== (report.checked || []).length) {
    fail('found + missing muss checked ergeben');
  }
  if ((report.missingBySeries || []).length !== summary.missingSeries) fail('missingBySeries.length passt nicht zu summary.missingSeries');
  if ((report.missingByPublisher || []).length !== summary.missingPublishers) fail('missingByPublisher.length passt nicht zu summary.missingPublishers');

  if (summary.missingCacheCoverage !== EXPECTED.missingCacheCoverage) {
    fail(`Dokumentierter Gap-Stand erwartet ${EXPECTED.missingCacheCoverage}, Audit meldet ${summary.missingCacheCoverage}`);
  }
  if (summary.missingSeries !== EXPECTED.missingSeries) {
    fail(`Dokumentierte Serienzahl erwartet ${EXPECTED.missingSeries}, Audit meldet ${summary.missingSeries}`);
  }
  if (summary.missingPublishers !== EXPECTED.missingPublishers) {
    fail(`Dokumentierte Verlagszahl erwartet ${EXPECTED.missingPublishers}, Audit meldet ${summary.missingPublishers}`);
  }

  (report.missing || []).forEach((item, idx) => {
    if (item.status !== 'missing') fail(`missing[${idx}].status muss "missing" sein`);
    if (item.classification !== EXPECTED.classification) {
      fail(`missing[${idx}].classification muss ${EXPECTED.classification} sein`);
    }
    if ('releaseDate' in item) fail(`missing[${idx}] darf kein erfundenes releaseDate enthalten`);
    if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) fail(`missing[${idx}].volumeNumber ungueltig`);
  });

  (report.missingBySeries || []).forEach((group, idx) => {
    if (group.classification !== EXPECTED.classification) {
      fail(`missingBySeries[${idx}].classification muss ${EXPECTED.classification} sein`);
    }
    if (!Array.isArray(group.missingVolumes) || group.missingVolumes.length !== group.missingCount) {
      fail(`missingBySeries[${idx}] missingVolumes/missingCount inkonsistent`);
    }
  });

  if (totalErrors === 0) pass('Audit-JSON ist parsebar, konsistent und klassifiziert Gaps als source-data-gap');
}

function validateCiReportArtifact(report) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cache-coverage-report-'));
  const outPath = path.join(tmpDir, 'report.json');
  try {
    cp.execFileSync(process.execPath, [reportWriterScript, '--out', outPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail(`CI-Report-Script muss Artefakt schreiben koennen: ${e.message}`);
    return;
  }

  let ciReport;
  try {
    ciReport = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    fail(`CI-Report-Artefakt ist nicht parsebar: ${e.message}`);
    return;
  }

  if (ciReport.schemaVersion !== 1) fail('CI-Report schemaVersion muss 1 sein');
  if (ciReport.reportType !== 'release-cache-coverage-ci-report') fail('CI-Report reportType unerwartet');
  if (!ciReport.current || !ciReport.current.summary) fail('CI-Report current.summary fehlt');
  if (!ciReport.comparison || typeof ciReport.comparison !== 'object') fail('CI-Report comparison fehlt');
  if (!ciReport.privacy || ciReport.privacy.containsPrivateCollectionData !== false) {
    fail('CI-Report muss private Sammlungsdaten ausschliessen');
  }

  const summary = (ciReport.current && ciReport.current.summary) || {};
  if (summary.missingCacheCoverage !== (report.summary || {}).missingCacheCoverage) {
    fail('CI-Report missingCacheCoverage passt nicht zum Audit');
  }
  if (!Array.isArray(ciReport.current.affectedSeries) || ciReport.current.affectedSeries.length !== (report.summary || {}).missingSeries) {
    fail('CI-Report affectedSeries passt nicht zum Audit');
  }
  if (!Array.isArray(ciReport.current.affectedPublishers) || ciReport.current.affectedPublishers.length !== (report.summary || {}).missingPublishers) {
    fail('CI-Report affectedPublishers passt nicht zum Audit');
  }
  if (!Array.isArray(ciReport.comparison.newGaps) || !Array.isArray(ciReport.comparison.resolvedGaps)) {
    fail('CI-Report muss neue und verschwundene Gaps als Arrays ausweisen');
  }
  if (ciReport.comparison.counts.newGaps !== 0) fail('CI-Report darf fuer dokumentierten Stand keine neuen Gaps melden');
  if (ciReport.comparison.counts.resolvedGaps !== 0) fail('CI-Report darf fuer dokumentierten Stand keine verschwundenen Gaps melden');
  if (ciReport.comparison.matchesDocumentedStand !== true) fail('CI-Report muss dokumentierten Stand als synchron markieren');

  if (totalErrors === 0) pass('CI-Report-Artefakt weist aktuelle, neue und verschwundene Coverage-Gaps aus');
}

function validateGitHubSummaryOutput(report) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cache-coverage-summary-'));
  const reportPath = path.join(tmpDir, 'report.json');
  const summaryPath = path.join(tmpDir, 'summary.md');
  try {
    cp.execFileSync(process.execPath, [reportWriterScript, '--out', reportPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cp.execFileSync(process.execPath, [summaryWriterScript, '--report', reportPath, '--out', summaryPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail(`GitHub-Summary-Script muss aus dem CI-Report Markdown erzeugen koennen: ${e.message}`);
    return;
  }

  const markdown = fs.readFileSync(summaryPath, 'utf8');
  const summary = report.summary || {};
  const requiredSnippets = [
    'Release-Cache-Coverage-Gaps',
    String(summary.missingCacheCoverage),
    String(summary.missingSeries),
    String(summary.missingPublishers),
    'Neue Gaps',
    'Verschwundene Gaps',
    'Dokumentierter Stand synchron',
    'source-data-gap',
    'Keine Fake-Daten',
    'release-cache-coverage-report',
  ];
  requiredSnippets.forEach(snippet => {
    if (!markdown.includes(snippet)) fail(`GitHub-Summary fehlt Marker: ${snippet}`);
  });
  if (!markdown.includes('| Betroffene Serien |') && !markdown.includes('### Betroffene Serien')) {
    fail('GitHub-Summary muss betroffene Serien sichtbar machen');
  }
  if (!markdown.includes('| Betroffene Verlage |') && !markdown.includes('### Betroffene Verlage')) {
    fail('GitHub-Summary muss betroffene Verlage sichtbar machen');
  }

  if (totalErrors === 0) pass('GitHub-Actions-Summary macht Coverage-Stand direkt sichtbar');
}

function extractDocSummary(doc) {
  const mapping = {
    missingCacheCoverage: /\|\s*Verbleibende Luecken\s*\|\s*(\d+)\s*\|/,
    missingSeries: /\|\s*Betroffene Serien\s*\|\s*(\d+)\s*\|/,
    missingPublishers: /\|\s*Betroffene Verlage\s*\|\s*(\d+)\s*\|/,
  };
  const result = {};
  Object.entries(mapping).forEach(([key, re]) => {
    const m = doc.match(re);
    if (!m) fail(`Docs: Kennzahl ${key} fehlt`);
    else result[key] = Number(m[1]);
  });
  return result;
}

function validateDocs(report) {
  if (!fs.existsSync(gapsDocPath)) {
    fail('docs/release-cache-coverage-gaps.md fehlt');
    return;
  }
  const doc = fs.readFileSync(gapsDocPath, 'utf8');
  const docSummary = extractDocSummary(doc);
  const summary = report.summary || {};

  ['missingCacheCoverage', 'missingSeries', 'missingPublishers'].forEach(key => {
    if (docSummary[key] !== summary[key]) {
      fail(`Docs: ${key} (${docSummary[key]}) passt nicht zum Audit (${summary[key]})`);
    }
  });

  const sourceGapHits = (doc.match(/source-data-gap/g) || []).length;
  if (sourceGapHits < EXPECTED.missingSeries + 1) {
    fail('Docs muessen source-data-gap fuer Zusammenfassung und Serien-Tabelle dokumentieren');
  }

  const forbidden = ['Sammlungsstand', 'owned', 'readAt', 'boughtAt'];
  forbidden.forEach(token => {
    if (doc.includes(token)) fail(`Docs duerfen keinen privaten Marker enthalten: ${token}`);
  });

  function normalizeDocText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[äÄ]/g, 'ae')
      .replace(/[öÖ]/g, 'oe')
      .replace(/[üÜ]/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const normalizedDoc = normalizeDocText(doc);
  (report.missingBySeries || []).forEach(group => {
    if (!normalizedDoc.includes(normalizeDocText(group.seriesTitle))) {
      fail(`Docs: Serie aus Audit fehlt: ${group.seriesTitle}`);
    }
  });

  if (totalErrors === 0) pass('Coverage-Gap-Dokumentation ist synchron zum JSON-Audit');
}

function gapKey(item) {
  return [
    String(item.seriesTitle || '').trim(),
    String(item.publisher || '').trim(),
    Number(item.volumeNumber),
  ].join('|');
}

function extractSourceGapAnalysisJson(doc) {
  const re = /<!-- source-gap-analysis-json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- source-gap-analysis-json:end -->/;
  const match = doc.match(re);
  if (!match) throw new Error('maschinenlesbarer source-gap-analysis-json Block fehlt');
  return JSON.parse(match[1]);
}

function validateSourceGapAnalysisDoc(report) {
  if (!fs.existsSync(sourceGapAnalysisDocPath)) {
    fail('docs/release-cache-source-gap-analysis.md fehlt');
    return;
  }

  const doc = fs.readFileSync(sourceGapAnalysisDocPath, 'utf8');
  let parsed;
  try {
    parsed = extractSourceGapAnalysisJson(doc);
  } catch (e) {
    fail(`Source-Gap-Analyse ist nicht parsebar: ${e.message}`);
    return;
  }

  if (!parsed || parsed.schemaVersion !== 1) fail('Source-Gap-Analyse schemaVersion muss 1 sein');
  if (!Array.isArray(parsed.gapAnalysis)) {
    fail('Source-Gap-Analyse muss gapAnalysis als Array enthalten');
    return;
  }

  const expectedMissing = report.missing || [];
  if (parsed.gapAnalysis.length !== expectedMissing.length) {
    fail(`Source-Gap-Analyse muss ${expectedMissing.length} Einzelgaps enthalten, gefunden ${parsed.gapAnalysis.length}`);
  }

  const expectedKeys = new Set(expectedMissing.map(gapKey));
  const seenKeys = new Set();
  let safePatchCount = 0;
  let manualReviewCount = 0;

  parsed.gapAnalysis.forEach((item, idx) => {
    const label = `gapAnalysis[${idx}]`;
    const key = gapKey(item);
    if (!expectedKeys.has(key)) fail(`${label} passt nicht zu aktuellem Audit-Missing: ${key}`);
    if (seenKeys.has(key)) fail(`${label} ist doppelt dokumentiert: ${key}`);
    seenKeys.add(key);

    if (item.classification !== EXPECTED.classification) {
      fail(`${label}.classification muss ${EXPECTED.classification} sein`);
    }
    if (!VALID_SUSPECTED_CAUSES.has(item.suspectedCause)) {
      fail(`${label}.suspectedCause ist nicht erlaubt: ${item.suspectedCause}`);
    }
    if (!VALID_RECOMMENDED_FIXES.has(item.recommendedFix)) {
      fail(`${label}.recommendedFix ist nicht erlaubt: ${item.recommendedFix}`);
    }
    if (!Array.isArray(item.checkedSources)) fail(`${label}.checkedSources muss ein Array sein`);
    if (typeof item.safeToPatch !== 'boolean') fail(`${label}.safeToPatch muss boolean sein`);
    if (item.safeToPatch === true) safePatchCount++;
    if (item.manualSourceReviewNeeded === true) manualReviewCount++;
    if ('releaseDate' in item) fail(`${label} darf kein Release-Datum enthalten`);
  });

  expectedKeys.forEach(key => {
    if (!seenKeys.has(key)) fail(`Source-Gap-Analyse fehlt Audit-Gap: ${key}`);
  });

  if (safePatchCount !== 0) fail('Phase 23a darf keine sicheren Cache-Patches ohne belegte Quelle markieren');
  if (manualReviewCount !== expectedMissing.length) {
    fail('Alle Phase-23a-Gaps muessen manuelle Quellenpruefung verlangen');
  }

  const requiredSnippets = [
    'Keine Fake-Daten',
    'Keine geratenen Release-Daten',
    'Keine privaten Sammlungsdaten',
    'data/release-cache.json',
    'MangaMoon',
    'MANGAMOON',
    'Tokyo Revengers',
  ];
  requiredSnippets.forEach(snippet => {
    if (!doc.includes(snippet)) fail(`Source-Gap-Analyse fehlt Marker: ${snippet}`);
  });

  const forbidden = ['Sammlungsstand', 'owned', 'readAt', 'boughtAt'];
  forbidden.forEach(token => {
    if (doc.includes(token)) fail(`Source-Gap-Analyse darf keinen privaten Marker enthalten: ${token}`);
  });

  if (totalErrors === 0) pass('Phase-23a-Source-Gap-Analyse deckt alle Audit-Gaps ohne Fake-Daten ab');
}

console.log('\nPruefe: Release-Cache-Coverage-Gaps JSON/Docs (Phase 22d)\n');

let report;
try {
  report = runAuditJson();
  pass('audit-release-cache-coverage.js --json liefert parsebares reines JSON');
} catch (e) {
  fail(e.message);
  report = null;
}

if (report) {
  validateReport(report);
  validateStrictJsonMode();
  validateDocs(report);
  validateSourceGapAnalysisDoc(report);
  validateCiReportArtifact(report);
  validateGitHubSummaryOutput(report);
}

console.log('');
if (totalErrors > 0) {
  console.error(`❌ Coverage-Gap-Validierung fehlgeschlagen — ${totalErrors} Fehler\n`);
  process.exit(1);
}

console.log('✅ Coverage-Gap-Validierung bestanden\n');
process.exit(0);
