'use strict';

/**
 * smoke-test-static.js — Phase 16
 *
 * Prueft die statische Grundstruktur des Projekts:
 *   - index.html vorhanden und lesbar
 *   - Keine Merge-Konflikt-Marker
 *   - Wichtige DOM-IDs vorhanden
 *   - Lokale Script-Referenzen vorhanden und Dateien existieren
 *   - data/release-cache.json vorhanden und parsebar
 *   - Keine Merge-Konflikt-Marker in JS-Quelldateien
 *
 * Aufruf: node scripts/smoke-test-static.js
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs   = require('fs');
const path = require('path');

const repoRoot    = path.resolve(__dirname, '..');
let   totalErrors = 0;

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.error('  ✗ ' + msg); totalErrors++; }

// ── index.html ─────────────────────────────────────────────────────────────
const htmlPath = path.join(repoRoot, 'index.html');
console.log('\nPrüfe: index.html\n');

if (!fs.existsSync(htmlPath)) {
  fail('index.html nicht gefunden');
  console.error('\n❌ Smoke-Test fehlgeschlagen (index.html fehlt)\n');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf-8');
pass('index.html vorhanden');

// ── Merge-Konflikt-Marker in index.html ───────────────────────────────────
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];
let   conflictHits     = 0;
CONFLICT_MARKERS.forEach(marker => {
  if (html.includes(marker)) {
    fail('Merge-Konflikt-Marker in index.html: "' + marker + '"');
    conflictHits++;
  }
});
if (conflictHits === 0) pass('Keine Merge-Konflikt-Marker in index.html');

// ── Pflicht-IDs ────────────────────────────────────────────────────────────
const REQUIRED_IDS = [
  'tabs',
  'content',
  'overlay',
  'toast',
  'sync-dot',
  'btn-add',
  'readonly-banner',
  'modal',
  'modal-title',
  'c-reading',
  'c-buy',
  'c-kalender',
];

let idErrors = 0;
REQUIRED_IDS.forEach(id => {
  if (!html.includes('id="' + id + '"')) {
    fail('Pflicht-ID fehlt in index.html: id="' + id + '"');
    idErrors++;
  }
});
if (idErrors === 0) pass('Alle ' + REQUIRED_IDS.length + ' Pflicht-IDs vorhanden');

// ── Lokale Script-Referenzen ───────────────────────────────────────────────
const LOCAL_SCRIPTS = [
  './src/utils.js',
  './src/supabase.js',
  './src/app.js',
];

let scriptErrors = 0;
LOCAL_SCRIPTS.forEach(ref => {
  if (!html.includes('src="' + ref + '"')) {
    fail('Script-Tag fehlt in index.html: src="' + ref + '"');
    scriptErrors++;
  }
  const filePath = path.join(repoRoot, ref.replace(/^\.\//, ''));
  if (!fs.existsSync(filePath)) {
    fail('Script-Datei nicht gefunden: ' + ref);
    scriptErrors++;
  }
});
if (scriptErrors === 0) pass('Alle ' + LOCAL_SCRIPTS.length + ' lokalen Script-Referenzen vorhanden und Dateien existieren');

// ── Merge-Konflikt-Marker in JS-Quelldateien ───────────────────────────────
const JS_SOURCES = [
  'src/app.js',
  'src/utils.js',
  'src/supabase.js',
];

console.log('\nPrüfe: JS-Quelldateien\n');
JS_SOURCES.forEach(rel => {
  const filePath = path.join(repoRoot, rel);
  if (!fs.existsSync(filePath)) {
    fail(rel + ': Datei nicht gefunden');
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  let hits = 0;
  CONFLICT_MARKERS.forEach(marker => {
    if (content.includes(marker)) {
      fail('Merge-Konflikt-Marker in ' + rel + ': "' + marker + '"');
      hits++;
    }
  });
  if (hits === 0) pass(rel + ': keine Konflikt-Marker');
});

// ── data/release-cache.json ────────────────────────────────────────────────
const cachePath = path.join(repoRoot, 'data', 'release-cache.json');
console.log('\nPrüfe: data/release-cache.json\n');

if (!fs.existsSync(cachePath)) {
  fail('data/release-cache.json nicht gefunden');
} else {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    pass('data/release-cache.json vorhanden und parsebar');
  } catch (e) {
    fail('data/release-cache.json ist kein gültiges JSON: ' + e.message);
    cache = null;
  }
  if (cache !== null) {
    if (cache.schemaVersion !== 1) {
      fail('release-cache.json schemaVersion erwartet 1, erhalten: ' + JSON.stringify(cache.schemaVersion));
    } else {
      pass('schemaVersion: 1');
    }
    if (!Array.isArray(cache.items)) {
      fail('release-cache.json "items" ist kein Array');
    } else {
      pass('items: Array mit ' + cache.items.length + ' Einträgen');
    }
  }
}

// ── Ergebnis ───────────────────────────────────────────────────────────────
console.log('');
if (totalErrors > 0) {
  console.error('❌ Smoke-Test fehlgeschlagen — ' + totalErrors + ' Fehler\n');
  process.exit(1);
} else {
  console.log('✅ Smoke-Test bestanden\n');
  process.exit(0);
}
