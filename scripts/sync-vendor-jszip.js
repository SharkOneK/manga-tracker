#!/usr/bin/env node
'use strict';

/**
 * sync-vendor-jszip.js — Phase 83 (Audit-Befund 12)
 *
 * Erzeugt vendor/jszip.min.js deterministisch aus dem installierten npm-Paket,
 * schreibt die SRI-Metadaten nach vendor/jszip.sri.json und zieht das
 * integrity="sha384-…"-Attribut in index.html nach.
 *
 * Aufgabenteilung (bewusst getrennt):
 *  - scripts/security-audit-static.js (Check 40/40b): "die ausgelieferte Datei
 *    passt zum SRI-Attribut in index.html".
 *  - scripts/validate-vendor-jszip.js: "die ausgelieferte Datei passt zum
 *    npm-Paket und zur in package.json gepinnten Version".
 *  - dieses Skript: stellt genau diesen Zustand her.
 *
 * Der Banner der Datei ist NIE die Versionsquelle: jszip 3.10.x liefert Builds
 * aus, deren Banner nicht zwingend zur package.json-Version passt. Massgeblich
 * sind ausschliesslich Inhalts-Hashes plus die mitgefuehrte Metadatendatei.
 *
 * Aufruf:
 *   node scripts/sync-vendor-jszip.js            # schreibt (Default)
 *   node scripts/sync-vendor-jszip.js --check    # prueft nur, Exit 1 bei Drift
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const nodeModulesPkgPath = path.join(repoRoot, 'node_modules', 'jszip', 'package.json');
const sourceFile = 'dist/jszip.min.js';
const nodeModulesDistPath = path.join(repoRoot, 'node_modules', 'jszip', sourceFile);
const vendorPath = path.join(repoRoot, 'vendor', 'jszip.min.js');
const sriPath = path.join(repoRoot, 'vendor', 'jszip.sri.json');
const indexHtmlPath = path.join(repoRoot, 'index.html');

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

function sha384(buffer) {
  return crypto.createHash('sha384').update(buffer).digest('base64');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function pinnedVersion() {
  const pkg = readJson(packageJsonPath);
  const pinned = (pkg.devDependencies && pkg.devDependencies.jszip) || (pkg.dependencies && pkg.dependencies.jszip);
  if (!pinned) fail('package.json enthaelt keine jszip-Abhaengigkeit.');
  if (!EXACT_VERSION_RE.test(pinned)) {
    fail(`jszip muss exakt gepinnt sein (kein ^ oder ~), gefunden: "${pinned}".`);
  }
  return pinned;
}

// Setzt integrity="sha384-…" im jszip-Script-Tag von index.html.
function patchIndexHtml(hash) {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const tagMatch = html.match(/<script[^>]+vendor\/jszip\.min\.js[^>]*>/i);
  if (!tagMatch) fail('Kein vendor/jszip.min.js Script-Tag in index.html gefunden.');
  const tag = tagMatch[0];
  if (!/integrity=["']sha384-[^"']*["']/.test(tag)) fail('Script-Tag in index.html hat kein integrity="sha384-…"-Attribut.');
  const nextTag = tag.replace(/integrity=(["'])sha384-[^"']*\1/, `integrity=$1sha384-${hash}$1`);
  if (nextTag === tag) return false;
  fs.writeFileSync(indexHtmlPath, html.replace(tag, nextTag));
  return true;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const version = pinnedVersion();

  if (!fs.existsSync(nodeModulesPkgPath) || !fs.existsSync(nodeModulesDistPath)) {
    if (checkOnly) {
      console.log('⏭  node_modules/jszip fehlt — Sync-Check uebersprungen (npm ci zuerst ausfuehren).');
      return;
    }
    fail('node_modules/jszip fehlt — bitte zuerst `npm ci` ausfuehren.');
  }

  const installedVersion = readJson(nodeModulesPkgPath).version;
  if (installedVersion !== version) {
    fail(`node_modules/jszip ist ${installedVersion}, package.json pinnt ${version} — bitte \`npm ci\` ausfuehren.`);
  }

  // Byteweise Kopie: .gitattributes fuehrt vendor/jszip.min.js als `binary`,
  // jede Text-/Zeilenenden-Konvertierung wuerde den SRI-Hash verfaelschen.
  const sourceBuffer = fs.readFileSync(nodeModulesDistPath);
  const sourceHash = sha384(sourceBuffer);
  const vendorBuffer = fs.existsSync(vendorPath) ? fs.readFileSync(vendorPath) : null;
  const vendorChanged = !vendorBuffer || !vendorBuffer.equals(sourceBuffer);

  const existingSri = fs.existsSync(sriPath) ? readJson(sriPath) : null;
  const sriUpToDate = existingSri
    && existingSri.version === version
    && existingSri.hash === sourceHash
    && existingSri.file === sourceFile;

  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const integrityUpToDate = html.includes(`integrity="sha384-${sourceHash}"`);

  if (checkOnly) {
    if (vendorChanged || !sriUpToDate || !integrityUpToDate) {
      console.error('❌ vendor/jszip ist nicht synchron zum npm-Paket:');
      if (vendorChanged) console.error('  - vendor/jszip.min.js weicht von node_modules/jszip/dist/jszip.min.js ab');
      if (!sriUpToDate) console.error('  - vendor/jszip.sri.json fehlt oder passt nicht zu Version/Hash');
      if (!integrityUpToDate) console.error('  - integrity-Attribut in index.html passt nicht zum Hash');
      console.error('  → `node scripts/sync-vendor-jszip.js` ausfuehren.\n');
      process.exit(1);
    }
    console.log(`✅ vendor/jszip.min.js ist synchron (jszip ${version}, sha384-${sourceHash.slice(0, 12)}…).`);
    return;
  }

  if (vendorChanged) fs.copyFileSync(nodeModulesDistPath, vendorPath);

  // syncedAt nur dann neu setzen, wenn sich Hash oder Version aendern — sonst
  // erzeugt jeder Lauf einen Diff (Churn) ohne inhaltliche Aenderung.
  const syncedAt = sriUpToDate && existingSri.syncedAt ? existingSri.syncedAt : new Date().toISOString();
  const sri = {
    schemaVersion: 1,
    package: 'jszip',
    version,
    file: sourceFile,
    algorithm: 'sha384',
    hash: sourceHash,
    syncedAt,
  };
  fs.writeFileSync(sriPath, `${JSON.stringify(sri, null, 2)}\n`);

  const htmlPatched = patchIndexHtml(sourceHash);

  console.log(`jszip ${version} synchronisiert.`);
  console.log(`  vendor/jszip.min.js: ${vendorChanged ? 'aktualisiert' : 'unveraendert'}`);
  console.log(`  vendor/jszip.sri.json: sha384-${sourceHash}`);
  console.log(`  index.html: ${htmlPatched ? 'integrity aktualisiert' : 'integrity unveraendert'}`);
  if (vendorChanged) {
    console.log('  ⚠ vendor/jszip.min.js hat sich geaendert → CACHE_VERSION in sw.js bumpen.');
  }
}

if (require.main === module) main();

module.exports = { sha384 };
