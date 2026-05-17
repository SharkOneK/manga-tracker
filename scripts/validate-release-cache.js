'use strict';

/**
 * validate-release-cache.js — Phase 15a
 *
 * Prüft data/release-cache.json auf Schema-Korrektheit.
 * Optionaler zweiter Pfad: data/release-sources.json.
 *
 * Aufruf:
 *   node scripts/validate-release-cache.js [cache-datei] [sources-datei]
 *
 * Standardpfade (relativ zum Repo-Root):
 *   data/release-cache.json
 *   data/release-sources.json  (optional, nur wenn vorhanden)
 *
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs   = require('fs');
const path = require('path');

// ─── Regex-Konstanten ─────────────────────────────────────────────────────
const DATE_RE    = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE     = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ISBN13_RE  = /^\d{13}$/;
const HTTPS_RE   = /^https:\/\//;

const VALID_CONFIDENCE = ['high', 'medium', 'low'];

// ─── Dateipfade aus Argumenten oder Defaults ──────────────────────────────
const repoRoot   = path.resolve(__dirname, '..');
const cacheFile  = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'data', 'release-cache.json');
const sourcesFile = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, 'data', 'release-sources.json');

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

function isValidIso(str) {
  if (typeof str !== 'string') return false;
  if (!ISO_RE.test(str)) return false;
  return !isNaN(Date.parse(str));
}

function isValidDate(str) {
  if (typeof str !== 'string') return false;
  if (!DATE_RE.test(str)) return false;
  // YYYY-MM-DD ohne Uhrzeit → Node.js parst als UTC-Mitternacht
  const d = new Date(str);
  if (isNaN(d.getTime())) return false;
  // UTC-Datumsteile prüfen (verhindert Timezone-Drift und ungültige Tage wie 2026-02-30)
  const [year, month, day] = str.split('-').map(Number);
  return d.getUTCFullYear() === year
      && d.getUTCMonth() + 1 === month
      && d.getUTCDate()      === day;
}

// ─── Einzelnes Item validieren ────────────────────────────────────────────
function validateItem(item, itemIdx) {
  const errors = [];
  const label  = `Item ${itemIdx}${item && item.seriesTitle ? ` ("${item.seriesTitle}")` : ''}`;

  if (!item || typeof item !== 'object') {
    errors.push(`${label}: kein Objekt`);
    return errors; // Keine weiteren Checks möglich
  }

  // ── Pflichtfelder: Strings ───────────────────────────────────────────────
  const reqStr = (field) => {
    if (typeof item[field] !== 'string' || !item[field].trim()) {
      errors.push(`${label}: "${field}" fehlt oder ist leer`);
    }
  };
  reqStr('seriesTitle');
  reqStr('normalizedSeriesTitle');
  reqStr('publisher');
  reqStr('normalizedPublisher');
  reqStr('sourceName');

  // ── volumeNumber ─────────────────────────────────────────────────────────
  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) {
    errors.push(`${label}: "volumeNumber" muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.volumeNumber)})`);
  }

  // ── releaseDate: YYYY-MM-DD + valides Datum ───────────────────────────────
  if (!isValidDate(item.releaseDate)) {
    errors.push(`${label}: "releaseDate" kein gültiges YYYY-MM-DD (erhalten: ${JSON.stringify(item.releaseDate)})`);
  }

  // ── confidence ───────────────────────────────────────────────────────────
  if (!VALID_CONFIDENCE.includes(item.confidence)) {
    errors.push(`${label}: "confidence" muss high/medium/low sein (erhalten: ${JSON.stringify(item.confidence)})`);
  }

  // ── checkedAt: ISO-Zeitstempel ────────────────────────────────────────────
  if (!isValidIso(item.checkedAt)) {
    errors.push(`${label}: "checkedAt" kein gültiger ISO-Zeitstempel (erhalten: ${JSON.stringify(item.checkedAt)})`);
  }

  // ── Optionale Felder: nur prüfen wenn nicht null/undefined ───────────────
  if (item.isbn13 !== null && item.isbn13 !== undefined) {
    if (typeof item.isbn13 !== 'string' || !ISBN13_RE.test(item.isbn13)) {
      errors.push(`${label}: "isbn13" muss null oder ein 13-stelliger Ziffern-String sein (erhalten: ${JSON.stringify(item.isbn13)})`);
    }
  }

  if (item.coverUrl !== null && item.coverUrl !== undefined) {
    if (typeof item.coverUrl !== 'string' || !HTTPS_RE.test(item.coverUrl)) {
      errors.push(`${label}: "coverUrl" muss null oder eine https://-URL sein (erhalten: ${JSON.stringify(item.coverUrl)})`);
    }
  }

  if (item.sourceUrl !== null && item.sourceUrl !== undefined) {
    if (typeof item.sourceUrl !== 'string' || !HTTPS_RE.test(item.sourceUrl)) {
      errors.push(`${label}: "sourceUrl" muss eine https://-URL sein (erhalten: ${JSON.stringify(item.sourceUrl)})`);
    }
  }

  return errors;
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

// ── release-cache.json ────────────────────────────────────────────────────
console.log(`\nPrüfe: ${cacheFile}\n`);

let cache;
try {
  cache = readJson(cacheFile);
} catch (e) {
  console.error('  ✗ ' + e.message);
  console.error('\n❌ Validierung fehlgeschlagen (Datei nicht lesbar)\n');
  process.exit(1);
}

// Toplevel-Felder
if (cache.schemaVersion !== 1) {
  fail(`"schemaVersion" muss 1 sein (erhalten: ${JSON.stringify(cache.schemaVersion)})`);
} else {
  pass(`schemaVersion: 1`);
}

if (!isValidIso(cache.generatedAt)) {
  fail(`"generatedAt" kein gültiger ISO-Zeitstempel (erhalten: ${JSON.stringify(cache.generatedAt)})`);
} else {
  pass(`generatedAt: ${cache.generatedAt}`);
}

if (typeof cache.source !== 'string' || !cache.source.trim()) {
  fail(`"source" fehlt oder ist kein String`);
} else {
  pass(`source: "${cache.source}"`);
}

if (!Array.isArray(cache.items)) {
  fail('"items" ist kein Array — Validierung der Einträge übersprungen');
  console.error('\n❌ Validierung fehlgeschlagen\n');
  process.exit(1);
} else {
  pass(`items: Array mit ${cache.items.length} Eintrag/Einträgen`);
}

if (cache.itemCount !== cache.items.length) {
  fail(`"itemCount" (${cache.itemCount}) stimmt nicht mit items.length (${cache.items.length}) überein`);
} else {
  pass(`itemCount: ${cache.itemCount} (korrekt)`);
}

// Item-Validierung
let itemErrorCount = 0;
cache.items.forEach((item, idx) => {
  const errs = validateItem(item, idx + 1);
  errs.forEach(e => { fail(e); itemErrorCount++; });
});
if (itemErrorCount === 0) {
  pass(`Alle ${cache.items.length} Item(s) haben gültige Pflichtfelder`);
}

// Duplikat-Check: normalizedSeriesTitle + normalizedPublisher + volumeNumber
const seen = new Map();
cache.items.forEach((item, idx) => {
  if (!item || typeof item !== 'object') return;
  const key = [
    (item.normalizedSeriesTitle || '').trim(),
    (item.normalizedPublisher   || '').trim(),
    item.volumeNumber,
  ].join('|');
  if (seen.has(key)) {
    fail(`Duplikat gefunden: Item ${idx + 1} und Item ${seen.get(key) + 1} haben gleiche Kombination aus normalizedSeriesTitle + normalizedPublisher + volumeNumber ("${key}")`);
  } else {
    seen.set(key, idx);
  }
});
if (totalErrors === 0) pass('Keine Duplikate gefunden');

// ── release-sources.json (optional) ───────────────────────────────────────
if (fs.existsSync(sourcesFile)) {
  console.log(`\nPrüfe: ${sourcesFile}\n`);
  let sources;
  try {
    sources = readJson(sourcesFile);
  } catch (e) {
    fail(e.message);
    sources = null;
  }
  if (sources) {
    if (sources.schemaVersion !== 1) {
      fail(`sources "schemaVersion" muss 1 sein (erhalten: ${JSON.stringify(sources.schemaVersion)})`);
    } else {
      pass(`sources schemaVersion: 1`);
    }
    if (!sources.requestPolicy || typeof sources.requestPolicy !== 'object') {
      fail('"requestPolicy" fehlt oder ist kein Objekt');
    } else {
      pass(`requestPolicy vorhanden`);
    }
    if (!Array.isArray(sources.sources)) {
      fail('"sources.sources" ist kein Array');
    } else {
      pass(`sources.sources: ${sources.sources.length} Quelle(n)`);
      sources.sources.forEach((src, i) => {
        if (!src || typeof src !== 'object') { fail(`source[${i}]: kein Objekt`); return; }
        if (!src.id)   fail(`source[${i}]: "id" fehlt`);
        if (!src.name) fail(`source[${i}]: "name" fehlt`);
        if (!src.baseUrl || !HTTPS_RE.test(src.baseUrl)) {
          fail(`source[${i}] ("${src.id || '?'}"): "baseUrl" muss https://-URL sein`);
        }
        if (!Array.isArray(src.allowedUrls)) {
          fail(`source[${i}] ("${src.id || '?'}"): "allowedUrls" ist kein Array`);
        }
      });
    }
  }
} else {
  console.log(`\n  ℹ release-sources.json nicht gefunden (optional, übersprungen)\n`);
}

// ─── Ergebnis ─────────────────────────────────────────────────────────────
console.log('');
if (totalErrors > 0) {
  console.error(`❌ Validierung fehlgeschlagen — ${totalErrors} Fehler gefunden\n`);
  process.exit(1);
} else {
  const count = cache.items ? cache.items.length : 0;
  console.log(`✅ Validierung erfolgreich — ${count} Item(s) geprüft, keine Fehler\n`);
  process.exit(0);
}
