'use strict';

/**
 * check-secrets.js — Phase 16
 *
 * Sucht nach verbotenen Token-Mustern in Quell- und Datendateien.
 *
 * Erlaubt:
 *   - Supabase Publishable Key (sb_publishable_*)
 *   - UUIDs (collId, ownerToken etc. — landen nur im localStorage)
 *
 * Verboten:
 *   - "service_role" (Supabase Service-Role-Secret)
 *   - JWT-Format (eyJhbG...) — entspricht einem signierten Supabase-Secret-Key
 *
 * Hinweis: Diese Datei selbst ist von der Prüfung ausgenommen,
 *          damit die Regex-Muster keine false positives erzeugen.
 *
 * Aufruf: node scripts/check-secrets.js
 * Exit 0 = OK, Exit 1 = Verbotenes Muster gefunden
 */

const fs   = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
let   totalErrors = 0;
let   filesScanned = 0;

function fail(msg) { console.error('  ✗ ' + msg); totalErrors++; }
function pass(msg) { console.log('  ✓ ' + msg); }

// ── Konfiguration ──────────────────────────────────────────────────────────

// Nur diese Verzeichnisse und Dateien werden gescannt
const SCAN_TARGETS = [
  'src',
  'index.html',
  'data',
  '.github',
];

// Diese Datei selbst wird ausgenommen (enthält die Muster als Quellcode)
const SELF = path.resolve(__filename);

// Verbotene Muster: [RegExp, Beschreibung]
// WICHTIG: Muster hier als aufgeteilte Strings angegeben,
//          damit dieser Quellcode selbst kein Match erzeugt.
const FORBIDDEN_PATTERNS = [
  [
    new RegExp('service' + '_role'),
    'service_role — Supabase Service-Role-Key darf nicht committed werden',
  ],
  [
    // Supabase JWT-Format: base64-kodiertes {"alg":"HS256"} — nur echte Secrets haben dieses Format
    // Der aktuelle publishable Key (sb_publishable_*) ist KEIN JWT und wird hier NICHT geflaggt.
    new RegExp('eyJhbG' + 'ciOi'),
    'JWT-Token (eyJhbG...) — potentiell ein Supabase-Secret-Key',
  ],
];

const SCAN_EXTS = new Set(['.js', '.html', '.json', '.yml', '.yaml']);

// ── Scanner ────────────────────────────────────────────────────────────────

function scanFile(filePath) {
  if (filePath === SELF) return; // sich selbst überspringen

  const rel = path.relative(repoRoot, filePath);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    fail('Konnte Datei nicht lesen: ' + rel + ' (' + e.message + ')');
    return;
  }

  filesScanned++;
  const lines = content.split('\n');
  lines.forEach(function(line, idx) {
    FORBIDDEN_PATTERNS.forEach(function(entry) {
      var pattern = entry[0];
      var label   = entry[1];
      if (pattern.test(line)) {
        fail(rel + ':' + (idx + 1) + ' — ' + label);
      }
    });
  });
}

function scanEntry(target) {
  const fullPath = path.join(repoRoot, target);
  if (!fs.existsSync(fullPath)) return;

  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    if (SCAN_EXTS.has(ext)) scanFile(fullPath);
    return;
  }
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    entries.forEach(function(entry) {
      const childPath = path.join(fullPath, entry.name);
      if (entry.isDirectory()) {
        scanEntryFull(childPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTS.has(ext)) scanFile(childPath);
      }
    });
  }
}

function scanEntryFull(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function(entry) {
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanEntryFull(childPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_EXTS.has(ext)) scanFile(childPath);
    }
  });
}

// ── Haupt-Scan ─────────────────────────────────────────────────────────────
console.log('\nPrüfe auf verbotene Muster...\n');
SCAN_TARGETS.forEach(scanEntry);

// ── Ergebnis ───────────────────────────────────────────────────────────────
console.log('');
if (totalErrors > 0) {
  console.error('❌ Secret-Check fehlgeschlagen — ' + totalErrors + ' Treffer in ' + filesScanned + ' Datei(en)\n');
  process.exit(1);
} else {
  pass(filesScanned + ' Datei(en) geprüft — keine verbotenen Muster gefunden');
  console.log('\n✅ Secret-Check bestanden\n');
  process.exit(0);
}
