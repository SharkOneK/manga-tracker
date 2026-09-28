#!/usr/bin/env node
'use strict';

/**
 * validate-vendor-jszip.js — Phase 83 (Audit-Befund 12)
 *
 * Macht Drift zwischen der gepinnten jszip-Version (package.json), der
 * ausgelieferten Datei (vendor/jszip.min.js), den Metadaten
 * (vendor/jszip.sri.json) und dem SRI-Attribut in index.html rot.
 * Genau dieser Check faellt aus, wenn Dependabot die Version anhebt, ohne dass
 * jemand `node scripts/sync-vendor-jszip.js` ausfuehrt.
 *
 * Laeuft vollstaendig offline (kein Netz, kein npm-Aufruf).
 *
 * Aufgabenteilung: scripts/security-audit-static.js (Check 40/40b) prueft
 * "ausgelieferte Datei passt zum SRI-Attribut"; dieser Validator prueft
 * zusaetzlich "ausgelieferte Datei passt zum npm-Paket und zur gepinnten Version".
 *
 * Der Banner in jszip.min.js ist NIE die Versionsquelle — jszip liefert Builds
 * aus, deren Banner nicht zwingend zur package.json-Version passt (3.10.1/3.10.2).
 * Geprueft wird ausschliesslich ueber Inhalts-Hashes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const vendorPath = path.join(repoRoot, 'vendor', 'jszip.min.js');
const sriPath = path.join(repoRoot, 'vendor', 'jszip.sri.json');
const indexHtmlPath = path.join(repoRoot, 'index.html');
const packageJsonPath = path.join(repoRoot, 'package.json');
const nodeModulesPkgPath = path.join(repoRoot, 'node_modules', 'jszip', 'package.json');
const nodeModulesDistPath = path.join(repoRoot, 'node_modules', 'jszip', 'dist', 'jszip.min.js');

const MIN_SIZE_BYTES = 10 * 1024;
const BANNER_RE = /^\/\*!\s*\n\s*\nJSZip v\d+\.\d+\.\d+/;

let totalErrors = 0;
function fail(message) { console.error('  ERR ' + message); totalErrors++; }
function pass(message) { console.log('  OK  ' + message); }
function skip(message) { console.log('  --  ' + message); }

function sha384(buffer) {
  return crypto.createHash('sha384').update(buffer).digest('base64');
}

console.log('\nPruefe: vendor/jszip.min.js (Phase 83)\n');

// ── 1: Datei existiert, plausible Groesse, JSZip-Banner ──────────────────────
let vendorBuffer = null;
if (!fs.existsSync(vendorPath)) {
  fail('vendor/jszip.min.js fehlt');
} else {
  vendorBuffer = fs.readFileSync(vendorPath);
  if (vendorBuffer.length < MIN_SIZE_BYTES) fail(`vendor/jszip.min.js ist nur ${vendorBuffer.length} Bytes gross`);
  else if (!BANNER_RE.test(vendorBuffer.toString('utf8', 0, 200))) fail('vendor/jszip.min.js traegt keinen JSZip-Banner');
  else pass(`vendor/jszip.min.js vorhanden (${vendorBuffer.length} Bytes, JSZip-Banner)`);
}

const vendorHash = vendorBuffer ? sha384(vendorBuffer) : null;

// ── 2: Hash === integrity-Attribut in index.html ─────────────────────────────
if (vendorHash) {
  if (!fs.existsSync(indexHtmlPath)) {
    fail('index.html fehlt (SRI-Abgleich nicht moeglich)');
  } else {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    const tag = (html.match(/<script[^>]+vendor\/jszip\.min\.js[^>]*>/i) || [])[0];
    const attr = tag ? (tag.match(/integrity=["']sha384-([^"']+)["']/) || [])[1] : null;
    if (!tag) fail('Kein vendor/jszip.min.js Script-Tag in index.html');
    else if (!attr) fail('Script-Tag in index.html hat kein integrity="sha384-…"-Attribut');
    else if (attr !== vendorHash) fail(`integrity in index.html (sha384-${attr.slice(0, 12)}…) passt nicht zu vendor/jszip.min.js (sha384-${vendorHash.slice(0, 12)}…)`);
    else pass('integrity-Attribut in index.html passt zum Hash der ausgelieferten Datei');
  }
}

// ── 3: Metadaten vendor/jszip.sri.json ───────────────────────────────────────
let pinnedVersion = null;
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  pinnedVersion = (pkg.devDependencies && pkg.devDependencies.jszip) || (pkg.dependencies && pkg.dependencies.jszip) || null;
} catch (e) {
  fail(`package.json nicht lesbar: ${e.message}`);
}
if (!pinnedVersion) fail('package.json enthaelt keine jszip-Abhaengigkeit');

let sri = null;
if (!fs.existsSync(sriPath)) {
  fail('vendor/jszip.sri.json fehlt — `node scripts/sync-vendor-jszip.js` ausfuehren');
} else {
  try { sri = JSON.parse(fs.readFileSync(sriPath, 'utf8')); }
  catch (e) { fail(`vendor/jszip.sri.json nicht lesbar: ${e.message}`); }
}

if (sri) {
  if (sri.package !== 'jszip') fail(`vendor/jszip.sri.json: package muss "jszip" sein (ist: ${sri.package})`);
  if (sri.file !== 'dist/jszip.min.js') fail(`vendor/jszip.sri.json: file muss "dist/jszip.min.js" sein (ist: ${sri.file})`);
  if (sri.algorithm !== 'sha384') fail(`vendor/jszip.sri.json: algorithm muss "sha384" sein (ist: ${sri.algorithm})`);
  if (vendorHash && sri.hash !== vendorHash) fail('vendor/jszip.sri.json: hash passt nicht zu vendor/jszip.min.js');
  if (pinnedVersion && sri.version !== pinnedVersion) {
    fail(`vendor/jszip.sri.json: version ${sri.version} passt nicht zur gepinnten Version ${pinnedVersion} — Vendor-Datei wurde nach dem Dependency-Bump nicht neu erzeugt`);
  }
  if (sri.package === 'jszip' && sri.file === 'dist/jszip.min.js' && sri.hash === vendorHash && sri.version === pinnedVersion) {
    pass(`vendor/jszip.sri.json passt zu Version ${sri.version} und zum Datei-Hash`);
  }
}

// ── 4: Abgleich gegen das installierte npm-Paket (nur wenn vorhanden) ────────
if (!fs.existsSync(nodeModulesPkgPath) || !fs.existsSync(nodeModulesDistPath)) {
  skip('node_modules/jszip nicht installiert — npm-Abgleich uebersprungen (nicht bestanden)');
} else {
  let installedVersion = null;
  try { installedVersion = JSON.parse(fs.readFileSync(nodeModulesPkgPath, 'utf8')).version; }
  catch (e) { fail(`node_modules/jszip/package.json nicht lesbar: ${e.message}`); }

  if (installedVersion && pinnedVersion && installedVersion !== pinnedVersion) {
    fail(`node_modules/jszip ist ${installedVersion}, package.json pinnt ${pinnedVersion} — \`npm ci\` ausfuehren`);
  }
  const installedHash = sha384(fs.readFileSync(nodeModulesDistPath));
  if (vendorHash && installedHash !== vendorHash) {
    fail('vendor/jszip.min.js weicht von node_modules/jszip/dist/jszip.min.js ab — `node scripts/sync-vendor-jszip.js` ausfuehren');
  } else if (vendorHash) {
    pass(`vendor/jszip.min.js ist byte-identisch zum npm-Paket (jszip ${installedVersion})`);
  }
}

console.log('');
if (totalErrors > 0) {
  console.error(`Vendor-jszip-Validierung fehlgeschlagen - ${totalErrors} Fehler\n`);
  process.exit(1);
}

console.log('Vendor-jszip-Validierung bestanden\n');
process.exit(0);
