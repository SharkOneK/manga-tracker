#!/usr/bin/env node
'use strict';

/**
 * test-audit-json-contract.js — Phase 49
 *
 * Sichert die stdout-Schnittstelle von audit-release-cache-coverage.js --json
 * gegenueber dem nachgelagerten Sync-Skript ab.
 *
 * Anforderungen:
 *  - exit code 0
 *  - stdout enthaelt genau einen parsbaren JSON-Block mit Pflichtfeldern
 *    (schemaVersion === 1, summary{}, missing[], missingBySeries[],
 *     missingByPublisher[])
 *  - stdout darf KEINE weiteren JSON-Objekte oder zusaetzlichen Top-Level-
 *    Zeichen enthalten (strenge Variante)
 *
 * Bewusst keine Validierung der inhaltlichen Werte (Anzahl Gaps etc.) —
 * dafuer existieren bereits validate-release-cache-coverage-gaps.js und
 * validate-release-source-review-queue.js.
 */

const cp = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');

function fail(msg, extra) {
  console.error(`\n✖ FAIL: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function runAudit() {
  // Deterministisch ohne Node-Warnings, weil Warnings je nach Node-Version
  // auch auf stderr/stdout landen koennen und das Vertragsergebnis nicht
  // beeinflussen sollen.
  return cp.spawnSync(process.execPath, [auditScript, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

console.log('Phase 49 — Audit JSON-Output Contract Test');
console.log('─────────────────────────────────────────────');

const res = runAudit();
if (res.error) fail(`Subprozess konnte nicht gestartet werden: ${res.error.message}`);
if (typeof res.status !== 'number') fail(`Subprozess ohne Statuscode beendet`);
if (res.status !== 0) {
  fail(`Audit beendete mit exit code ${res.status}`,
    `--- stdout ---\n${res.stdout || ''}\n--- stderr ---\n${res.stderr || ''}`);
}
ok('exit code === 0');

const stdout = String(res.stdout || '');
if (!stdout.trim()) fail('stdout ist leer');
ok('stdout ist nicht leer');

// Strenge Variante: nach trim() muss stdout exakt ein JSON-Objekt sein.
const trimmed = stdout.trim();
if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
  fail('stdout enthaelt Begleittext ausserhalb des JSON-Objekts',
    `--- stdout (Anfang) ---\n${trimmed.slice(0, 200)}\n--- stdout (Ende) ---\n${trimmed.slice(-200)}`);
}
ok('stdout ist nach trim() exakt ein JSON-Objekt');

let parsed;
try {
  parsed = JSON.parse(trimmed);
} catch (e) {
  fail(`stdout ist kein parsbares JSON: ${e.message}`,
    `--- stdout ---\n${trimmed.slice(0, 500)}\n…`);
}
ok('JSON.parse erfolgreich');

// Stelle sicher, dass NACH dem ersten JSON-Objekt nichts mehr kommt
// (kein zweites `}` aus z. B. einer angehaengten Debug-Ausgabe).
const firstParseLength = JSON.stringify(parsed).length;
// Reparse-Probe: ein zweiter Parser-Lauf ueber denselben Substring muss
// identisches Ergebnis liefern.
const reparsed = JSON.parse(trimmed);
if (typeof reparsed !== 'object' || Array.isArray(reparsed)) {
  fail('Top-Level-Wert ist kein JSON-Objekt');
}
ok(`Top-Level ist ein JSON-Objekt (${firstParseLength} Bytes serialisiert)`);

const requiredFields = [
  ['schemaVersion', 'number'],
  ['summary', 'object'],
  ['missing', 'array'],
  ['missingBySeries', 'array'],
  ['missingByPublisher', 'array'],
];

for (const [field, expected] of requiredFields) {
  const value = parsed[field];
  if (value === undefined) fail(`Pflichtfeld fehlt: ${field}`);
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== expected) fail(`Pflichtfeld ${field} hat Typ "${actual}", erwartet "${expected}"`);
  ok(`Pflichtfeld vorhanden: ${field} (${actual})`);
}

if (parsed.schemaVersion !== 1) fail(`schemaVersion erwartet 1, gefunden ${parsed.schemaVersion}`);
ok('schemaVersion === 1');

// summary muss numerische Kerngroessen tragen
const summaryNumeric = [
  'enabledWatchlistEntries',
  'expandedWatchlistVolumeCandidates',
  'cacheEntries',
  'foundCacheEntries',
  'missingCacheCoverage',
  'missingSeries',
  'missingPublishers',
  'exitCode',
];
for (const key of summaryNumeric) {
  if (typeof parsed.summary[key] !== 'number') {
    fail(`summary.${key} muss eine Zahl sein, gefunden ${typeof parsed.summary[key]}`);
  }
}
ok('summary.* numerische Pflichtfelder vorhanden');

// Konsistenz: missing.length === summary.missingCacheCoverage
if (parsed.missing.length !== parsed.summary.missingCacheCoverage) {
  fail(`missing.length (${parsed.missing.length}) != summary.missingCacheCoverage (${parsed.summary.missingCacheCoverage})`);
}
ok('missing.length === summary.missingCacheCoverage');

// stderr darf beliebig sein (Warnings, Status), aber nicht crashen.
const stderr = String(res.stderr || '');
if (stderr.includes('Error: ') || stderr.includes('UnhandledPromiseRejection')) {
  fail('stderr enthaelt unerwarteten Error-Trace', `--- stderr ---\n${stderr}`);
}
ok('stderr ohne Error-Traces');

console.log('\n✓ Audit JSON-Output Contract OK');
