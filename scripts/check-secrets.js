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
 *   - echte Supabase Secret Keys (sb_secret_*)
 *   - JWT-Format (eyJhbG...) — entspricht legacy signierten Supabase-Secret-Keys
 *
 * Erlaubt sind reine Variablen-/Rollenbezeichnungen wie
 * SUPABASE_SERVICE_ROLE_KEY oder service_role. Diese Namen sind keine Secrets;
 * echte Schlüssel werden über sb_secret_* bzw. JWT-Muster erkannt.
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
  'docs',
  'scripts',
];

// Diese Datei selbst wird ausgenommen (enthält die Muster als Quellcode)
const SELF = path.resolve(__filename);

// Ausgenommene Dateien (Dokumentation über Secrets, kein echter Secret-Inhalt)
const EXCLUDED_FILES = new Set([
  path.resolve(repoRoot, 'docs', 'security.md'),
]);

// Verbotene Muster: [RegExp, Beschreibung]
// WICHTIG: Muster hier als aufgeteilte Strings angegeben,
//          damit dieser Quellcode selbst kein Match erzeugt.
const FORBIDDEN_PATTERNS = [
  [
    // Supabase JWT-Format: base64-kodiertes {"alg":"HS256"} — nur echte Secrets haben dieses Format
    // Der aktuelle publishable Key (sb_publishable_*) ist KEIN JWT und wird hier NICHT geflaggt.
    new RegExp('eyJhbG' + 'ciOi'),
    'JWT-Token (eyJhbG...) — potentiell ein Supabase-Secret-Key',
  ],
  [
    // GitHub Personal Access Token (classic)
    new RegExp('ghp' + '_[A-Za-z0-9]{36}'),
    'ghp_... — GitHub Personal Access Token (classic)',
  ],
  [
    // GitHub Personal Access Token (newer fine-grained format)
    new RegExp('github' + '_pat_[A-Za-z0-9_]{82}'),
    'github_pat_... — GitHub Fine-Grained Personal Access Token',
  ],
  [
    // OpenAI secret key
    new RegExp('sk-[A-Za-z0-9]{32,}'),
    'sk-... — potentieller OpenAI API Key',
  ],
  [
    // AWS Access Key ID
    new RegExp('AKIA[0-9A-Z]{16}'),
    'AKIA... — AWS Access Key ID',
  ],
  [
    new RegExp('BEGIN PRIVATE KEY'),
    'BEGIN PRIVATE KEY — privater Schlüssel darf nicht committed werden',
  ],
  [
    new RegExp('BEGIN RSA PRIVATE KEY'),
    'BEGIN RSA PRIVATE KEY — privater RSA-Schlüssel darf nicht committed werden',
  ],
  [
    new RegExp('sb' + '_secret_'),
    'sb_secret_... — Supabase Secret Key darf nicht committed werden',
  ],
  [
    // TMDB v3 API-Key: 32 Hex-Zeichen, kontextgebunden an "api_key=" (geringe
    // False-Positive-Rate). Ein v4-Read-Token ist ein JWT und wird bereits über
    // das eyJhbG...-Muster oben erfasst.
    new RegExp('api_key=' + '[0-9a-f]{32}'),
    'api_key=<32-hex> — potentieller TMDB-API-Key darf nicht committed werden',
  ],
];

const SCAN_EXTS = new Set(['.js', '.html', '.json', '.yml', '.yaml', '.md', '.txt']);

// ── Scanner ────────────────────────────────────────────────────────────────

function scanFile(filePath) {
  if (filePath === SELF) return; // sich selbst überspringen
  if (EXCLUDED_FILES.has(path.resolve(filePath))) return; // ausgenommene Dateien überspringen

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
