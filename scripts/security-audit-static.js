'use strict';

/**
 * security-audit-static.js — Phase 21b
 *
 * Statische Sicherheitsprüfungen für den Manga Tracker.
 * Prüft CSP, Supply-Chain, CI-Konfiguration und Code-Struktur.
 *
 * Aufruf: node scripts/security-audit-static.js
 * Exit 0 = alle Checks bestanden (Warns zählen nicht als Fail),
 * Exit 1 = mindestens ein Check fehlgeschlagen
 */

const fs   = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
let totalChecks = 0;
let totalFailed = 0;
let totalWarns  = 0;

function pass(msg) { console.log('  ✓ ' + msg); totalChecks++; }
function fail(msg) { console.error('  ✗ ' + msg); totalChecks++; totalFailed++; }
function warn(msg) { console.warn('  ⚠ WARN: ' + msg); totalChecks++; totalWarns++; }

function readFile(rel) {
  const fullPath = path.join(repoRoot, rel);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf-8');
}

function fileExists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

// ── Dateien laden ──────────────────────────────────────────────────────────

const html      = readFile('index.html');
const ciYml     = readFile('.github/workflows/ci.yml');
const appJs     = readFile('src/app.js');
const supabaseJs = readFile('src/supabase.js');
const checkSecretsJs = readFile('scripts/check-secrets.js');

console.log('\nSicherheits-Audit (statisch) — Phase 21b\n');

// ── Check 1: index.html enthält CSP ───────────────────────────────────────
if (!html) {
  fail('Check 1: index.html nicht gefunden');
} else if (!html.includes('Content-Security-Policy')) {
  fail('Check 1: index.html enthält keine Content-Security-Policy');
} else {
  pass('Check 1: index.html enthält Content-Security-Policy');
}

// ── Check 2: CSP enthält object-src none ──────────────────────────────────
if (!html) {
  fail("Check 2: index.html nicht gefunden (object-src 'none' nicht prüfbar)");
} else if (!html.includes("object-src 'none'")) {
  fail("Check 2: CSP enthält kein object-src 'none'");
} else {
  pass("Check 2: CSP enthält object-src 'none'");
}

// ── Check 3: CSP enthält base-uri self ────────────────────────────────────
if (!html) {
  fail("Check 3: index.html nicht gefunden (base-uri 'self' nicht prüfbar)");
} else if (!html.includes("base-uri 'self'")) {
  fail("Check 3: CSP enthält kein base-uri 'self'");
} else {
  pass("Check 3: CSP enthält base-uri 'self'");
}

// ── Check 4: CSP enthält frame-ancestors none ─────────────────────────────
if (!html) {
  fail("Check 4: index.html nicht gefunden (frame-ancestors 'none' nicht prüfbar)");
} else if (!html.includes("frame-ancestors 'none'")) {
  fail("Check 4: CSP enthält kein frame-ancestors 'none'");
} else {
  pass("Check 4: CSP enthält frame-ancestors 'none'");
}

// ── Check 5: kein externes Script-Tag ohne SRI oder lokales Vendor ─────────
// Erlaubt: vendor/ (lokale Dateien), kein CDN-Script ohne integrity
if (!html) {
  fail('Check 5: index.html nicht gefunden (CDN-Script-Check nicht möglich)');
} else {
  // Suche nach script-Tags mit src
  const scriptTagRe = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  let cdnIssues = 0;
  while ((match = scriptTagRe.exec(html)) !== null) {
    const src = match[1];
    const tag = match[0];
    const isExternal = /^https?:\/\//i.test(src);
    if (isExternal) {
      const hasIntegrity = /integrity=["'][^"']+["']/.test(tag);
      if (!hasIntegrity) {
        fail('Check 5: Externes Script ohne SRI: ' + src);
        cdnIssues++;
      }
    }
  }
  if (cdnIssues === 0) {
    pass('Check 5: Kein externes Script ohne SRI (oder alle Scripte lokal)');
  }
}

// ── Check 6: vendor/jszip.min.js existiert ────────────────────────────────
if (!fileExists('vendor/jszip.min.js')) {
  fail('Check 6: vendor/jszip.min.js nicht gefunden');
} else {
  pass('Check 6: vendor/jszip.min.js vorhanden');
}

// ── Check 7: index.html lädt jszip aus vendor/, nicht CDN ────────────────
if (!html) {
  fail('Check 7: index.html nicht gefunden');
} else if (html.includes('cdn.jsdelivr.net') && html.includes('jszip')) {
  fail('Check 7: index.html lädt JSZip noch von CDN (cdn.jsdelivr.net)');
} else if (!html.includes('./vendor/jszip.min.js') && !html.includes('vendor/jszip.min.js')) {
  fail('Check 7: index.html enthält keinen vendor/jszip.min.js Script-Tag');
} else {
  pass('Check 7: index.html lädt JSZip aus vendor/ (lokal)');
}

// ── Check 8: ci.yml hat permissions: contents: read ──────────────────────
if (!ciYml) {
  fail('Check 8: .github/workflows/ci.yml nicht gefunden');
} else if (!ciYml.includes('permissions') || !ciYml.includes('contents: read')) {
  fail('Check 8: ci.yml hat kein "permissions: contents: read"');
} else {
  pass('Check 8: ci.yml enthält permissions: contents: read');
}

// ── Check 9: app.js hat getAppMode ────────────────────────────────────────
if (!appJs) {
  fail('Check 9: src/app.js nicht gefunden');
} else if (!appJs.includes('getAppMode')) {
  fail('Check 9: src/app.js enthält keine getAppMode-Funktion');
} else {
  pass('Check 9: src/app.js enthält getAppMode');
}

// ── Check 10: app.js hat canEditLocal ─────────────────────────────────────
if (!appJs) {
  fail('Check 10: src/app.js nicht gefunden');
} else if (!appJs.includes('canEditLocal')) {
  fail('Check 10: src/app.js enthält keine canEditLocal-Funktion');
} else {
  pass('Check 10: src/app.js enthält canEditLocal');
}

// ── Check 11: app.js hat isPublicReadOnly ────────────────────────────────
if (!appJs) {
  fail('Check 11: src/app.js nicht gefunden');
} else if (!appJs.includes('isPublicReadOnly')) {
  fail('Check 11: src/app.js enthält keine isPublicReadOnly-Funktion');
} else {
  pass('Check 11: src/app.js enthält isPublicReadOnly');
}

// ── Check 12: supabase.js oder app.js enthält Fragment-Adopt (hash.slice) ─
const hasFragmentAdopt =
  (supabaseJs && supabaseJs.includes('hash.slice')) ||
  (appJs && appJs.includes('hash.slice'));

if (!hasFragmentAdopt) {
  fail('Check 12: weder src/supabase.js noch src/app.js enthält Fragment-Adopt-Logik (hash.slice)');
} else {
  pass('Check 12: Fragment-Adopt-Logik (hash.slice) vorhanden');
}

// ── Check 13: keine Adopt-Query-Links in docs/* und data/* ───────────────
const ADOPT_QUERY_RE = /\?adopt=.*&token=/;
const docsDir  = path.join(repoRoot, 'docs');
const dataDir  = path.join(repoRoot, 'data');
let adoptIssues = 0;

function scanForAdoptQuery(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function(entry) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForAdoptQuery(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.html', '.txt', '.json'].includes(ext)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (ADOPT_QUERY_RE.test(content)) {
          fail('Check 13: Adopt-Query-Link (?adopt=...&token=) in ' + path.relative(repoRoot, fullPath));
          adoptIssues++;
        }
      }
    }
  });
}

scanForAdoptQuery(docsDir);
scanForAdoptQuery(dataDir);
if (adoptIssues === 0) {
  pass('Check 13: Keine Adopt-Query-Links in docs/* und data/*');
}

// ── Check 14: release-utils.js existiert ─────────────────────────────────
if (!fileExists('src/release-utils.js')) {
  fail('Check 14: src/release-utils.js nicht gefunden');
} else {
  pass('Check 14: src/release-utils.js vorhanden');
}

// ── Check 15: check-secrets.js scannt .md-Dateien ────────────────────────
if (!checkSecretsJs) {
  fail('Check 15: scripts/check-secrets.js nicht gefunden');
} else if (!checkSecretsJs.includes("'.md'")) {
  fail("Check 15: check-secrets.js scannt keine .md-Dateien ('.md' nicht gefunden)");
} else {
  pass('Check 15: check-secrets.js scannt .md-Dateien');
}

// ── Check 16: connect-src enthält keine Wildcards ─────────────────────────
if (!html) {
  fail('Check 16: index.html nicht gefunden (connect-src Wildcard-Prüfung nicht möglich)');
} else {
  // Extrahiere connect-src-Wert aus der CSP
  const cspMatch = html.match(/Content-Security-Policy[^>]*content="([^"]+)"/i);
  const cspContent = cspMatch ? cspMatch[1] : '';
  const connectSrcMatch = cspContent.match(/connect-src\s+([^;]+)/);
  const connectSrcValue = connectSrcMatch ? connectSrcMatch[1] : '';
  if (connectSrcValue.includes('*')) {
    fail('Check 16: connect-src enthält Wildcard (*) — zu weit gefasst');
  } else {
    pass('Check 16: connect-src enthält keine Wildcards');
  }
}

// ── Check 17: index.html enthält no-referrer ──────────────────────────────
if (!html) {
  fail('Check 17: index.html nicht gefunden (Referrer-Policy nicht prüfbar)');
} else if (!html.includes('no-referrer')) {
  fail('Check 17: index.html enthält keine Referrer-Policy no-referrer');
} else {
  pass('Check 17: index.html enthält Referrer-Policy no-referrer');
}

// ── Check 18: supabase/migrations/phase21b_public_projection_rls.sql existiert
if (!fileExists('supabase/migrations/phase21b_public_projection_rls.sql')) {
  fail('Check 18: supabase/migrations/phase21b_public_projection_rls.sql nicht gefunden');
} else {
  pass('Check 18: supabase/migrations/phase21b_public_projection_rls.sql vorhanden');
}

// ── Check 19: src/app.js enthält buildPublicCollectionData ────────────────
if (!appJs) {
  fail('Check 19: src/app.js nicht gefunden');
} else if (!appJs.includes('buildPublicCollectionData')) {
  fail('Check 19: src/app.js enthält keine buildPublicCollectionData-Funktion');
} else {
  pass('Check 19: src/app.js enthält buildPublicCollectionData');
}

// ── Check 20: unsafe-inline CSP-Restschuld dokumentieren ─────────────────
// WARN (kein FAIL): unsafe-inline noch vorhanden — Restschuld für Phase 22
if (!html) {
  fail('Check 20: index.html nicht gefunden (unsafe-inline-Prüfung nicht möglich)');
} else if (html.includes("'unsafe-inline'")) {
  warn("Check 20: CSP enthält noch 'unsafe-inline' (Restschuld Phase 22 — vollständige Entfernung erfordert Event-Delegation-Refactoring aller Inline-Handler)");
} else {
  pass("Check 20: CSP enthält kein 'unsafe-inline' — vollständig gehärtet");
}

// ── Ergebnis ───────────────────────────────────────────────────────────────
const passed = totalChecks - totalFailed - totalWarns;
console.log('');
if (totalWarns > 0) {
  console.warn('  ⚠ ' + totalWarns + ' Warnung(en) — dokumentierte Restschuld, kein Fehler');
}
if (totalFailed > 0) {
  console.error('❌ Sicherheits-Audit fehlgeschlagen — ' + totalFailed + '/' + totalChecks + ' Checks nicht bestanden\n');
  process.exit(1);
} else {
  console.log('✅ Sicherheits-Audit bestanden — ' + (totalChecks - totalFailed) + '/' + totalChecks + ' Checks (inkl. ' + totalWarns + ' Warn)\n');
  process.exit(0);
}
