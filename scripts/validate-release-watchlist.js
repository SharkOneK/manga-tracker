'use strict';

/**
 * validate-release-watchlist.js — Phase 19
 *
 * Prüft data/release-watchlist.json auf Schema-Korrektheit.
 *
 * Aufruf:
 *   node scripts/validate-release-watchlist.js [watchlist-datei]
 *
 * Standardpfad (relativ zum Repo-Root):
 *   data/release-watchlist.json
 *
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs   = require('fs');
const path = require('path');

// ─── Dateipfade aus Argumenten oder Defaults ──────────────────────────────
const repoRoot      = path.resolve(__dirname, '..');
const watchlistFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'data', 'release-watchlist.json');

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────
function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Datei nicht gefunden: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Ungültiges JSON in "${path.basename(filePath)}": ${e.message}`);
  }
}

function isValidHttpsUrl(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeForDuplicateCheck(seriesTitle, publisher) {
  return String(seriesTitle || '').toLowerCase().trim() + '|' +
    String(publisher || '').toLowerCase().trim();
}

// ─── Haupt-Validierung ────────────────────────────────────────────────────
let totalErrors = 0;

function fail(msg) {
  console.error('  ✗ ' + msg);
  totalErrors++;
}

function pass(msg) {
  console.log('  ✓ ' + msg);
}

// ── release-watchlist.json ────────────────────────────────────────────────
console.log(`\nPrüfe: ${watchlistFile}\n`);

let watchlist;
try {
  watchlist = readJson(watchlistFile);
} catch (e) {
  console.error('  ✗ ' + e.message);
  console.error('\n❌ Validierung fehlgeschlagen (Datei nicht lesbar)\n');
  process.exit(1);
}

// Toplevel-Felder
if (watchlist.schemaVersion !== 1) {
  fail(`"schemaVersion" muss 1 sein (erhalten: ${JSON.stringify(watchlist.schemaVersion)})`);
} else {
  pass('schemaVersion: 1');
}

if (!Array.isArray(watchlist.items)) {
  fail('"items" ist kein Array — Validierung der Einträge übersprungen');
  console.error('\n❌ Validierung fehlgeschlagen\n');
  process.exit(1);
} else {
  pass(`items: Array mit ${watchlist.items.length} Eintrag/Einträgen`);
}

// Item-Validierung
let itemErrorCount = 0;
watchlist.items.forEach((item, idx) => {
  const label = `Item ${idx + 1}${item && item.seriesTitle ? ` ("${item.seriesTitle}")` : ''}`;

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    fail(`${label}: kein Objekt`);
    itemErrorCount++;
    return;
  }

  // seriesTitle
  if (typeof item.seriesTitle !== 'string' || !item.seriesTitle.trim()) {
    fail(`${label}: "seriesTitle" fehlt oder ist leer`);
    itemErrorCount++;
  }

  // publisher
  if (typeof item.publisher !== 'string' || !item.publisher.trim()) {
    fail(`${label}: "publisher" fehlt oder ist leer`);
    itemErrorCount++;
  }

  // volumeNumber: integer >= 1
  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) {
    fail(`${label}: "volumeNumber" muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.volumeNumber)})`);
    itemErrorCount++;
  }

  // enabled: boolean
  if (typeof item.enabled !== 'boolean') {
    fail(`${label}: "enabled" muss ein Boolean sein (erhalten: ${JSON.stringify(item.enabled)})`);
    itemErrorCount++;
  }

  // sourceUrl: null oder https://-URL
  if (!isValidHttpsUrl(item.sourceUrl)) {
    fail(`${label}: "sourceUrl" muss null oder eine https://-URL sein (erhalten: ${JSON.stringify(item.sourceUrl)})`);
    itemErrorCount++;
  }
});

if (itemErrorCount === 0) {
  pass(`Alle ${watchlist.items.length} Item(s) haben gültige Pflichtfelder`);
}

// Duplikat-Check: normalizedTitle|normalizedPublisher|volumeNumber
const seen = new Map();
watchlist.items.forEach((item, idx) => {
  if (!item || typeof item !== 'object') return;
  const normalizedKey = normalizeForDuplicateCheck(item.seriesTitle, item.publisher) +
    '|' + item.volumeNumber;
  if (seen.has(normalizedKey)) {
    fail(`Duplikat gefunden: Item ${idx + 1} und Item ${seen.get(normalizedKey) + 1} haben gleiche Kombination aus seriesTitle + publisher + volumeNumber ("${normalizedKey}")`);
  } else {
    seen.set(normalizedKey, idx);
  }
});
if (totalErrors === 0) pass('Keine Duplikate gefunden');

// ─── Ergebnis ─────────────────────────────────────────────────────────────
console.log('');
if (totalErrors > 0) {
  console.error(`❌ Validierung fehlgeschlagen — ${totalErrors} Fehler gefunden\n`);
  process.exit(1);
} else {
  const count = watchlist.items ? watchlist.items.length : 0;
  console.log(`✅ Validierung erfolgreich — ${count} Item(s) geprüft, keine Fehler\n`);
  process.exit(0);
}
