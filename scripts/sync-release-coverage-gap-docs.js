#!/usr/bin/env node
'use strict';

/**
 * sync-release-coverage-gap-docs.js - Phase 41
 *
 * Synchronisiert nach einem Release-Intake die aus dem Coverage-Audit
 * abgeleiteten Dokumentationsdateien und Expected Counts. Das Script erzeugt
 * keine Release-Daten, veraendert data/release-cache.json nicht und markiert
 * neu entdeckte Gaps konservativ als manuell zu pruefende source-data-gap-Faelle.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');
const gapsDocPath = path.join(repoRoot, 'docs', 'release-cache-coverage-gaps.md');
const sourceGapAnalysisDocPath = path.join(repoRoot, 'docs', 'release-cache-source-gap-analysis.md');
const validatorPath = path.join(repoRoot, 'scripts', 'validate-release-cache-coverage-gaps.js');

const EXPECTED_CLASSIFICATION = 'source-data-gap';
const DEFAULT_CAUSE = 'manual-source-required';
const DEFAULT_FIX = 'manual-source-review';
const GENERATED_NOTICE = 'Stand: automatisch synchronisiert aus aktuellem Audit gegen `data/release-watchlist.json` und `data/release-cache.json`.';

function rel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function writeIfChanged(filePath, content) {
  const normalized = content.endsWith('\n') ? content : content + '\n';
  const current = readText(filePath);
  if (current === normalized) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalized, 'utf8');
  return true;
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

function gapKey(item) {
  return [
    normalizeText(item && item.seriesTitle),
    normalizeText((item && item.publisher) || 'Unbekannter Verlag'),
    Number(item && item.volumeNumber),
  ].join('|');
}

function escapeMarkdown(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatVolumes(volumes) {
  if (!Array.isArray(volumes) || volumes.length === 0) return '-';
  const sorted = Array.from(new Set(volumes.map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
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

function countBy(items, keyFn) {
  const counts = new Map();
  items.forEach(item => {
    const key = keyFn(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'));
}

function mostCommon(values, fallback) {
  const counts = countBy(values.map(value => ({ value })), item => item.value).filter(([key]) => key);
  return counts.length ? counts[0][0] : fallback;
}

function assertAuditShape(report) {
  if (!report || typeof report !== 'object') throw new Error('Audit-Report fehlt');
  if (!report.summary || typeof report.summary !== 'object') throw new Error('Audit summary fehlt');
  ['missing', 'missingBySeries', 'missingByPublisher'].forEach(key => {
    if (!Array.isArray(report[key])) throw new Error(`Audit ${key} muss ein Array sein`);
  });
  const summary = report.summary;
  if (report.missing.length !== summary.missingCacheCoverage) {
    throw new Error('Audit missing.length passt nicht zu summary.missingCacheCoverage');
  }
  if (report.missing.some(item => item.classification !== EXPECTED_CLASSIFICATION)) {
    throw new Error(`Alle fehlenden Coverage-Gaps muessen ${EXPECTED_CLASSIFICATION} sein`);
  }
}

function buildCoverageGapsDoc(report) {
  const s = report.summary;
  const lines = [];
  lines.push('# Phase 22c - Klassifizierung verbleibender Release-Cache-Coverage-Luecken');
  lines.push('');
  lines.push(GENERATED_NOTICE);
  lines.push('');
  lines.push('## Zusammenfassung');
  lines.push('');
  lines.push('| Kennzahl | Wert |');
  lines.push('|---|---:|');
  lines.push(`| Aktivierte Watchlist-Eintraege | ${s.enabledWatchlistEntries} |`);
  lines.push(`| Expandierte Watchlist-Bandkandidaten | ${s.expandedWatchlistVolumeCandidates} |`);
  lines.push(`| Release-Cache-Eintraege | ${s.cacheEntries} |`);
  lines.push(`| Gefundene Cache-Eintraege | ${s.foundCacheEntries} |`);
  lines.push(`| Verbleibende Luecken | ${s.missingCacheCoverage} |`);
  lines.push(`| Betroffene Serien | ${s.missingSeries} |`);
  lines.push(`| Betroffene Verlage | ${s.missingPublishers} |`);
  lines.push('');
  lines.push('## Klassifikation');
  lines.push('');
  lines.push(`Alle ${s.missingCacheCoverage} verbleibenden Luecken sind als \`${EXPECTED_CLASSIFICATION}\` klassifiziert.`);
  lines.push('');
  lines.push('Bedeutung: Der Watchlist-Band wurde nach dem Cache-Update weiterhin nicht in `data/release-cache.json` gefunden. Diese Faelle sind Quellen-/Datenqualitaetsfaelle und duerfen nicht durch Fake-Daten geschlossen werden.');
  lines.push('');
  lines.push('Empfohlener Umgang: manuell in verlaesslicher Quelle pruefen, erst danach echte Release-Daten ergaenzen. Wenn keine Quelle einen belastbaren Treffer liefert, bleibt die Luecke sichtbar.');
  lines.push('');
  lines.push('## Luecken nach Serie');
  lines.push('');
  lines.push('| Serie | Verlag | Fehlende Baende | Anzahl | Klassifikation |');
  lines.push('|---|---|---:|---:|---|');
  (report.missingBySeries || []).forEach(group => {
    lines.push(`| ${escapeMarkdown(group.seriesTitle)} | ${escapeMarkdown(group.publisher || 'Unbekannter Verlag')} | ${formatVolumes(group.missingVolumes)} | ${group.missingCount} | ${escapeMarkdown(group.classification || EXPECTED_CLASSIFICATION)} |`);
  });
  if (!report.missingBySeries.length) lines.push('| - | - | - | 0 | - |');
  lines.push('');
  lines.push('## Luecken nach Verlag');
  lines.push('');
  lines.push('| Verlag | Luecken | Serien |');
  lines.push('|---|---:|---:|');
  (report.missingByPublisher || []).forEach(group => {
    lines.push(`| ${escapeMarkdown(group.publisher || 'Unbekannter Verlag')} | ${group.missingCount} | ${group.seriesCount} |`);
  });
  if (!report.missingByPublisher.length) lines.push('| - | 0 | 0 |');
  lines.push('');
  lines.push('## Maschinenlesbarer Audit');
  lines.push('');
  lines.push('Der Audit kann die gleiche Klassifizierung als JSON ausgeben:');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/audit-release-cache-coverage.js --json');
  lines.push('```');
  lines.push('');
  lines.push('Relevante Felder: `summary`, `missingBySeries`, `missingByPublisher`, `missing`.');
  lines.push('');
  lines.push('Der CI-/Docs-Validator prueft, dass dieser dokumentierte Stand zum JSON-Audit passt:');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/validate-release-cache-coverage-gaps.js');
  lines.push('```');
  lines.push('');
  lines.push('## Phase 22e: CI-Artefakt und Verlauf');
  lines.push('');
  lines.push('Jeder CI-Lauf schreibt den aktuellen Coverage-Gap-Zustand als JSON-Artefakt:');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/write-release-cache-coverage-report.js');
  lines.push('```');
  lines.push('');
  lines.push('Standardausgabe: `artifacts/release-cache-coverage-report.json` (nur CI-/lokales Artefakt, keine Release-Datenquelle).');
  lines.push('');
  lines.push('Das Artefakt enthaelt:');
  lines.push('');
  lines.push('- aktuelle Anzahl der Coverage-Gaps, betroffenen Serien und Verlage');
  lines.push('- betroffene Serien inklusive fehlender Baende');
  lines.push('- betroffene Verlage inklusive Serienliste');
  lines.push('- Vergleich gegen diesen dokumentierten Stand');
  lines.push('- `newGaps` fuer neu hinzugekommene Luecken');
  lines.push('- `resolvedGaps` fuer verschwundene Luecken');
  lines.push('- Privacy-Marker: keine privaten Sammlungsdaten und keine neuen Release-Daten');
  lines.push('');
  lines.push('Der normale Workflow scheitert weiterhin nicht an bekannten `source-data-gap`-Luecken. Drift gegen diese Dokumentation wird aber im Validator sichtbar, damit die Dokumentation bewusst aktualisiert werden kann.');
  lines.push('');
  lines.push('## Phase 23a: Ursachenanalyse');
  lines.push('');
  lines.push(`Die ${s.missingCacheCoverage} \`source-data-gap\`-Einzelluecken sind in \`docs/release-cache-source-gap-analysis.md\` strukturiert analysiert.`);
  lines.push('');
  lines.push('Die Analyse dokumentiert pro Gap:');
  lines.push('');
  lines.push('- vermutete Ursache');
  lines.push('- gepruefte Quelle');
  lines.push('- empfohlene Massnahme');
  lines.push('- ob ein sicherer Cache-Patch moeglich ist');
  lines.push('- ob eine manuelle Quellenpruefung noetig ist');
  lines.push('');
  lines.push('Aktueller Befund: kein Gap ist ohne weitere Quellenpruefung sicher patchbar. Es wurden keine Fake-Daten, keine geratenen Release-Daten und keine privaten Sammlungsdaten ergaenzt.');
  lines.push('');
  lines.push('### Phase 22f: GitHub-Actions-Summary');
  lines.push('');
  lines.push('Der CI-Lauf rendert den Artefakt-Report zusaetzlich direkt in die GitHub-Actions-Summary:');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/write-release-cache-coverage-summary.js');
  lines.push('```');
  lines.push('');
  lines.push('Die Summary zeigt ohne Artefakt-Download:');
  lines.push('');
  lines.push('- aktuelle Coverage-Luecken');
  lines.push('- betroffene Serien und Verlage');
  lines.push('- neue und verschwundene Gaps');
  lines.push('- Synchronitaet mit diesem dokumentierten Stand');
  lines.push('- Klassifizierung `source-data-gap`');
  lines.push('- Hinweis, dass keine Fake-Daten und keine privaten Sammlungsdaten erzeugt wurden');
  lines.push('- Verweis auf das Artefakt `release-cache-coverage-report`');
  lines.push('');
  lines.push('## Datenschutz');
  lines.push('');
  lines.push('- Keine privaten Sammlungsstaende enthalten.');
  lines.push('- Keine neuen Release-Daten ergaenzt.');
  lines.push('- Keine manuellen oder geratenen Cache-Eintraege erzeugt.');
  lines.push('- Audit bleibt ohne `--strict` im Warnmodus mit Exit 0.');
  return lines.join('\n') + '\n';
}

function extractSourceGapAnalysisJson(doc) {
  const re = /<!-- source-gap-analysis-json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- source-gap-analysis-json:end -->/;
  const match = doc.match(re);
  if (!match) return { schemaVersion: 1, generatedAt: 'historisch', gapAnalysis: [] };
  return JSON.parse(match[1]);
}

function defaultGapAnalysisItem(gap) {
  return {
    seriesTitle: gap.seriesTitle,
    publisher: gap.publisher || null,
    volumeNumber: gap.volumeNumber,
    classification: EXPECTED_CLASSIFICATION,
    priority: 'mittel',
    suspectedCause: DEFAULT_CAUSE,
    checkedSources: [
      {
        name: 'Release-Intake-Staging / Release-Cache-Audit',
        url: 'data/release-watchlist.json',
        result: 'Nach Release-Intake in der Watchlist vorhanden; kein passender Eintrag in data/release-cache.json.',
      },
    ],
    evidence: 'Der Band wurde per Release-Intake in die Watchlist uebernommen. Der Release-Cache enthaelt noch kein belegtes Datum; kein Cache-Patch ohne verifizierte Quelle.',
    recommendedFix: DEFAULT_FIX,
    safeToPatch: false,
    manualSourceReviewNeeded: true,
  };
}

function sanitizeGapAnalysisItem(existing, gap) {
  const item = existing && typeof existing === 'object'
    ? { ...existing }
    : defaultGapAnalysisItem(gap);

  item.seriesTitle = gap.seriesTitle;
  item.publisher = gap.publisher || null;
  item.volumeNumber = gap.volumeNumber;
  item.classification = EXPECTED_CLASSIFICATION;
  if (typeof item.priority !== 'string' || !item.priority.trim()) item.priority = 'mittel';
  if (typeof item.suspectedCause !== 'string' || !item.suspectedCause.trim()) item.suspectedCause = DEFAULT_CAUSE;
  if (!Array.isArray(item.checkedSources)) item.checkedSources = [];
  if (typeof item.evidence !== 'string' || !item.evidence.trim()) {
    item.evidence = defaultGapAnalysisItem(gap).evidence;
  }
  if (typeof item.recommendedFix !== 'string' || !item.recommendedFix.trim()) item.recommendedFix = DEFAULT_FIX;
  item.safeToPatch = false;
  item.manualSourceReviewNeeded = true;

  [
    'releaseDate',
    'owned',
    'read',
    'readAt',
    'boughtAt',
    'collectionStatus',
    'seriesId',
  ].forEach(key => delete item[key]);

  return item;
}

function syncGapAnalysisItems(report, existingParsed) {
  const existingItems = Array.isArray(existingParsed.gapAnalysis) ? existingParsed.gapAnalysis : [];
  const existingByKey = new Map(existingItems.map(item => [gapKey(item), item]));
  const gapAnalysis = (report.missing || []).map(gap => sanitizeGapAnalysisItem(existingByKey.get(gapKey(gap)), gap));
  return {
    schemaVersion: 1,
    generatedAt: existingParsed.generatedAt || 'historisch',
    gapAnalysis,
  };
}

function analysisByGapKey(gapAnalysis) {
  return new Map(gapAnalysis.map(item => [gapKey(item), item]));
}

function findAnalysisForSeries(group, byKey) {
  return (group.missingVolumes || [])
    .map(volumeNumber => byKey.get(gapKey({ seriesTitle: group.seriesTitle, publisher: group.publisher, volumeNumber })))
    .filter(Boolean);
}

function buildSourceAnalysisIntro(report, parsed) {
  const gapAnalysis = parsed.gapAnalysis || [];
  const byKey = analysisByGapKey(gapAnalysis);
  const safePatchCount = gapAnalysis.filter(item => item.safeToPatch === true).length;
  const manualReviewCount = gapAnalysis.filter(item => item.manualSourceReviewNeeded === true).length;
  const causeCounts = countBy(gapAnalysis, item => item.suspectedCause || DEFAULT_CAUSE);
  const fixCounts = countBy(gapAnalysis, item => item.recommendedFix || DEFAULT_FIX);
  const lines = [];
  lines.push('# Phase 23a - Release-Cache Source-Gap-Ursachenanalyse');
  lines.push('');
  lines.push(GENERATED_NOTICE);
  lines.push('');
  lines.push(`Diese Datei dokumentiert die ${report.summary.missingCacheCoverage} bekannten \`source-data-gap\`-Luecken aus \`docs/release-cache-coverage-gaps.md\`. Sie ist bewusst eine Analyse- und Entscheidungsdatei: Es werden keine Release-Daten geraten, keine privaten Sammlungsdaten ergaenzt und \`data/release-cache.json\` bleibt unangetastet.`);
  lines.push('');
  lines.push('## Ergebnis');
  lines.push('');
  lines.push('| Kennzahl | Wert |');
  lines.push('|---|---:|');
  lines.push(`| Analysierte Gaps | ${gapAnalysis.length} |`);
  lines.push(`| Betroffene Serien | ${report.summary.missingSeries} |`);
  lines.push(`| Sichere direkte Cache-Patches | ${safePatchCount} |`);
  lines.push(`| Manuelle Quellenpruefung noetig | ${manualReviewCount} |`);
  lines.push('');
  lines.push('## Ursachencluster');
  lines.push('');
  lines.push('| Vermutete Ursache | Gaps |');
  lines.push('|---|---:|');
  causeCounts.forEach(([cause, count]) => lines.push(`| ${escapeMarkdown(cause)} | ${count} |`));
  if (!causeCounts.length) lines.push('| - | 0 |');
  lines.push('');
  lines.push('Interpretation:');
  lines.push('');
  lines.push('- `manual-source-required`: Der Gap wurde aus dem aktuellen Audit uebernommen; vor einem Cache-Patch muss eine belastbare Quelle manuell geprueft werden.');
  lines.push('- `not-yet-released`: Die bekannte Quelle fuehrt den Band gar nicht mit einem validen Datum oder nur mit Platzhalterdatum. Kein Cache-Patch ohne weitere Quelle.');
  lines.push('- `source-missing`: Die bekannte Quelle enthaelt den Band aktuell nicht in der passenden Edition.');
  lines.push('- `publisher-normalization`: Watchlist-/Quellenpublisher weichen fachlich ab; erst Metadaten klaeren, dann patchen.');
  lines.push('- `volume-numbering-mismatch`: Bandnummer passt wahrscheinlich nicht zur Edition oder zur Quellenzaehlung.');
  lines.push('');
  lines.push('## Empfohlene Massnahmen');
  lines.push('');
  lines.push('| Empfohlener Fix | Gaps |');
  lines.push('|---|---:|');
  fixCounts.forEach(([fix, count]) => lines.push(`| ${escapeMarkdown(fix)} | ${count} |`));
  if (!fixCounts.length) lines.push('| - | 0 |');
  lines.push('');
  lines.push('Der einzige sichere naechste Schritt ist aktuell `manual-source-review`: offizielle Verlagsseite oder bereits erlaubte vertrauenswuerdige Quelle pruefen und erst danach echte Release-Daten mit Source-URL uebernehmen.');
  lines.push('');
  lines.push('## Serienuebersicht');
  lines.push('');
  lines.push('| Serie | Verlag | Fehlende Baende | Anzahl | Ursache | Empfehlung | Safe to patch |');
  lines.push('|---|---|---:|---:|---|---|---|');
  (report.missingBySeries || []).forEach(group => {
    const items = findAnalysisForSeries(group, byKey);
    const cause = mostCommon(items.map(item => item.suspectedCause), DEFAULT_CAUSE);
    const fix = mostCommon(items.map(item => item.recommendedFix), DEFAULT_FIX);
    const safe = items.some(item => item.safeToPatch === true) ? 'teilweise' : 'nein';
    lines.push(`| ${escapeMarkdown(group.seriesTitle)} | ${escapeMarkdown(group.publisher || 'Unbekannter Verlag')} | ${formatVolumes(group.missingVolumes)} | ${group.missingCount} | ${escapeMarkdown(cause)} | ${escapeMarkdown(fix)} | ${safe} |`);
  });
  if (!report.missingBySeries.length) lines.push('| - | - | - | 0 | - | - | nein |');
  lines.push('');
  lines.push('## Einzelgap-Matrix');
  lines.push('');
  lines.push('| Serie | Verlag | Band | Ursache | Empfehlung | Safe to patch | Manuelle Quellenpruefung |');
  lines.push('|---|---|---:|---|---|---|---|');
  (report.missing || []).forEach(gap => {
    const item = byKey.get(gapKey(gap)) || defaultGapAnalysisItem(gap);
    lines.push(`| ${escapeMarkdown(gap.seriesTitle)} | ${escapeMarkdown(gap.publisher || 'Unbekannter Verlag')} | ${gap.volumeNumber} | ${escapeMarkdown(item.suspectedCause || DEFAULT_CAUSE)} | ${escapeMarkdown(item.recommendedFix || DEFAULT_FIX)} | ${item.safeToPatch === true ? 'ja' : 'nein'} | ${item.manualSourceReviewNeeded === true ? 'ja' : 'nein'} |`);
  });
  if (!report.missing.length) lines.push('| - | - | - | - | - | nein | nein |');
  lines.push('');
  return lines.join('\n');
}

function buildMachineSection(parsed) {
  return [
    '## Maschinenlesbare Analyse',
    '',
    '<!-- source-gap-analysis-json:start -->',
    '```json',
    JSON.stringify(parsed, null, 2),
    '```',
    '<!-- source-gap-analysis-json:end -->',
    '',
  ].join('\n');
}

function buildSourceAnalysisFooter(report) {
  const lines = [];
  lines.push('## Quellenstrategie pro Verlag');
  lines.push('');
  lines.push('| Verlag | Gaps | Serien | Strategie |');
  lines.push('|---|---:|---:|---|');
  (report.missingByPublisher || []).forEach(group => {
    lines.push(`| ${escapeMarkdown(group.publisher || 'Unbekannter Verlag')} | ${group.missingCount} | ${group.seriesCount} | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |`);
  });
  if (!report.missingByPublisher.length) lines.push('| - | 0 | 0 | Keine offenen Gaps. |');
  lines.push('');
  lines.push('## Konkrete naechste Fixes');
  lines.push('');
  lines.push('1. Neue oder weiterhin offene Audit-Gaps aus der maschinenlesbaren Analyse mit `manual-source-review` triagieren.');
  lines.push('2. Offizielle Verlagsseiten oder bereits erlaubte vertrauenswuerdige Quellen fuer die groessten Gap-Bloecke priorisieren.');
  lines.push('3. Erst wenn ein echtes Datum mit Source-URL vorliegt: Updater/Quelle erweitern oder Watchlist-Metadaten ergaenzen, danach Cache per Skriptprozess aktualisieren.');
  lines.push('');
  lines.push('## Sicherheitsbestaetigung');
  lines.push('');
  lines.push('- Keine Fake-Daten ergaenzt.');
  lines.push('- Keine geratenen Release-Daten ergaenzt.');
  lines.push('- Keine privaten Sammlungsdaten verwendet.');
  lines.push('- `data/release-cache.json` wurde fuer diese Analyse nicht veraendert.');
  lines.push('');
  return lines.join('\n');
}

function buildSourceGapAnalysisDoc(report) {
  const currentDoc = readText(sourceGapAnalysisDocPath);
  const existingParsed = extractSourceGapAnalysisJson(currentDoc);
  const parsed = syncGapAnalysisItems(report, existingParsed);
  const intro = buildSourceAnalysisIntro(report, parsed);
  const machineSection = buildMachineSection(parsed);
  const re = /## Maschinenlesbare Analyse[\s\S]*?<!-- source-gap-analysis-json:end -->\s*/;
  const footerMatch = currentDoc.match(re);
  const existingFooter = footerMatch ? currentDoc.slice((footerMatch.index || 0) + footerMatch[0].length).replace(/^\s+/, '') : '';
  const historicalStart = existingFooter.indexOf('## Phase 33 Manual Source-Gap Audit');
  const historicalFooter = historicalStart === -1 ? '' : existingFooter.slice(historicalStart).replace(/^\s+/, '');
  const generatedFooter = buildSourceAnalysisFooter(report);
  return `${intro}\n${machineSection}${generatedFooter}${historicalFooter ? `\n${historicalFooter}` : ''}`;
}

function updateValidatorExpected(report) {
  const current = readText(validatorPath);
  if (!current) throw new Error(`${rel(validatorPath)} fehlt`);
  const expectedRe = /const EXPECTED = \{\s*missingCacheCoverage:\s*(\d+),\s*missingSeries:\s*(\d+),\s*missingPublishers:\s*(\d+),\s*classification:\s*'([^']+)',\s*\};/m;
  const match = current.match(expectedRe);
  if (!match) {
    throw new Error('EXPECTED-Block in validate-release-cache-coverage-gaps.js nicht gefunden');
  }
  if (
    Number(match[1]) === report.summary.missingCacheCoverage &&
    Number(match[2]) === report.summary.missingSeries &&
    Number(match[3]) === report.summary.missingPublishers &&
    match[4] === EXPECTED_CLASSIFICATION
  ) {
    return false;
  }
  const replacement = `const EXPECTED = {\n  missingCacheCoverage: ${report.summary.missingCacheCoverage},\n  missingSeries: ${report.summary.missingSeries},\n  missingPublishers: ${report.summary.missingPublishers},\n  classification: '${EXPECTED_CLASSIFICATION}',\n};`;
  const updated = current.replace(expectedRe, replacement);
  return writeIfChanged(validatorPath, updated);
}

function main() {
  const report = runAuditJson();
  assertAuditShape(report);

  const changed = [];
  if (writeIfChanged(gapsDocPath, buildCoverageGapsDoc(report))) changed.push(rel(gapsDocPath));
  if (writeIfChanged(sourceGapAnalysisDocPath, buildSourceGapAnalysisDoc(report))) changed.push(rel(sourceGapAnalysisDocPath));
  if (updateValidatorExpected(report)) changed.push(rel(validatorPath));

  if (changed.length) {
    console.log('Release-Coverage-Gap-Dokumentation synchronisiert:');
    changed.forEach(file => console.log(`  - ${file}`));
  } else {
    console.log('Release-Coverage-Gap-Dokumentation ist bereits synchron.');
  }
}

try {
  main();
} catch (e) {
  console.error(`\nERROR: Sync Release-Coverage-Gap-Dokumentation fehlgeschlagen: ${e.message}\n`);
  process.exit(1);
}
