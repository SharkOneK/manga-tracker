'use strict';

/**
 * validate-isbn-lookup-cache.js — Backlog 3.x
 *
 * Prüft data/isbn-lookup-cache.json auf Schema-Korrektheit und ISBN-Konsistenz.
 * Kern: 'high'-Items MÜSSEN eine gültige ISBN-13 (978/979) tragen, 'unsure'/'none'
 * MÜSSEN isbn13 === null haben (verhindert ein "high-loses" Speichern einer ISBN).
 *
 * Aufruf:
 *   node scripts/validate-isbn-lookup-cache.js [cache-datei]
 *
 * Standardpfad (relativ zum Repo-Root):
 *   data/isbn-lookup-cache.json
 *
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs   = require('fs');
const path = require('path');
const { normalizeTitle } = require('./release-confidence');

// ─── Dateipfade aus Argumenten oder Defaults ──────────────────────────────
const repoRoot  = path.resolve(__dirname, '..');
const cacheFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'data', 'isbn-lookup-cache.json');

const ISBN13_RE = /^(978|979)\d{10}$/;
const ISO_RE    = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const VALID_CONFIDENCE = new Set(['high', 'unsure', 'none']);

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoString(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
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
  pass('schemaVersion: 1');
}

if (typeof cache.source !== 'string') {
  fail(`"source" muss ein String sein (erhalten: ${JSON.stringify(cache.source)})`);
} else {
  pass('source: String');
}

if (!(cache.generatedAt === null || isIsoString(cache.generatedAt))) {
  fail(`"generatedAt" muss null oder ein ISO-8601-String sein (erhalten: ${JSON.stringify(cache.generatedAt)})`);
} else {
  pass('generatedAt: null oder ISO-8601');
}

if (!Number.isInteger(cache.itemCount) || cache.itemCount < 0) {
  fail(`"itemCount" muss ein Integer >= 0 sein (erhalten: ${JSON.stringify(cache.itemCount)})`);
}

if (!Array.isArray(cache.items)) {
  fail('"items" ist kein Array — Validierung der Einträge übersprungen');
  console.error('\n❌ Validierung fehlgeschlagen\n');
  process.exit(1);
} else {
  pass(`items: Array mit ${cache.items.length} Eintrag/Einträgen`);
}

if (Number.isInteger(cache.itemCount) && cache.itemCount !== cache.items.length) {
  fail(`"itemCount" (${cache.itemCount}) stimmt nicht mit items.length (${cache.items.length}) überein`);
}

// Item-Validierung
let itemErrorCount = 0;
cache.items.forEach((item, idx) => {
  const label = `Item ${idx + 1}${item && item.seriesTitle ? ` ("${item.seriesTitle}")` : ''}`;

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    fail(`${label}: kein Objekt`);
    itemErrorCount++;
    return;
  }

  if (!isNonEmptyString(item.seriesTitle)) {
    fail(`${label}: "seriesTitle" fehlt oder ist leer`);
    itemErrorCount++;
  }

  if (!isNonEmptyString(item.normalizedSeriesTitle)) {
    fail(`${label}: "normalizedSeriesTitle" fehlt oder ist leer`);
    itemErrorCount++;
  } else if (isNonEmptyString(item.seriesTitle) && item.normalizedSeriesTitle !== normalizeTitle(item.seriesTitle)) {
    fail(`${label}: "normalizedSeriesTitle" passt nicht zur Norm von "seriesTitle" (erwartet: ${JSON.stringify(normalizeTitle(item.seriesTitle))})`);
    itemErrorCount++;
  }

  if (!isNonEmptyString(item.source)) {
    fail(`${label}: "source" fehlt oder ist leer`);
    itemErrorCount++;
  }

  if (!(item.publisher === null || typeof item.publisher === 'string')) {
    fail(`${label}: "publisher" muss String oder null sein (erhalten: ${JSON.stringify(item.publisher)})`);
    itemErrorCount++;
  }

  if (!(item.normalizedPublisher === null || typeof item.normalizedPublisher === 'string')) {
    fail(`${label}: "normalizedPublisher" muss String oder null sein (erhalten: ${JSON.stringify(item.normalizedPublisher)})`);
    itemErrorCount++;
  }

  if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) {
    fail(`${label}: "volumeNumber" muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.volumeNumber)})`);
    itemErrorCount++;
  }

  if (!VALID_CONFIDENCE.has(item.confidence)) {
    fail(`${label}: "confidence" muss high|unsure|none sein (erhalten: ${JSON.stringify(item.confidence)})`);
    itemErrorCount++;
  }

  if (!Number.isInteger(item.candidateCount) || item.candidateCount < 0) {
    fail(`${label}: "candidateCount" muss ein Integer >= 0 sein (erhalten: ${JSON.stringify(item.candidateCount)})`);
    itemErrorCount++;
  }

  if (typeof item.evidence !== 'string') {
    fail(`${label}: "evidence" muss ein String sein (erhalten: ${JSON.stringify(item.evidence)})`);
    itemErrorCount++;
  }

  if (!isIsoString(item.checkedAt)) {
    fail(`${label}: "checkedAt" muss ein ISO-8601-String sein (erhalten: ${JSON.stringify(item.checkedAt)})`);
    itemErrorCount++;
  }

  // ── ISBN-Konsistenz (Kern) ──────────────────────────────────────────────
  if (item.confidence === 'high') {
    if (typeof item.isbn13 !== 'string' || !ISBN13_RE.test(item.isbn13)) {
      fail(`${label}: bei confidence "high" muss "isbn13" eine gültige ISBN-13 (978/979) sein (erhalten: ${JSON.stringify(item.isbn13)})`);
      itemErrorCount++;
    }
  } else if (item.confidence === 'unsure' || item.confidence === 'none') {
    if (item.isbn13 !== null) {
      fail(`${label}: bei confidence "${item.confidence}" muss "isbn13" null sein (erhalten: ${JSON.stringify(item.isbn13)})`);
      itemErrorCount++;
    }
  }
});

if (itemErrorCount === 0) {
  pass(`Alle ${cache.items.length} Item(s) haben gültige Felder und ISBN-Konsistenz`);
}

// Duplikat-Check: normalizedSeriesTitle|normalizedPublisher|volumeNumber
const seen = new Map();
cache.items.forEach((item, idx) => {
  if (!item || typeof item !== 'object') return;
  const key = [
    String(item.normalizedSeriesTitle || ''),
    String(item.normalizedPublisher == null ? '' : item.normalizedPublisher),
    String(item.volumeNumber == null ? '' : item.volumeNumber),
  ].join('|');
  if (seen.has(key)) {
    fail(`Duplikat gefunden: Item ${idx + 1} und Item ${seen.get(key) + 1} haben gleichen Schlüssel ("${key}")`);
  } else {
    seen.set(key, idx);
  }
});
if (totalErrors === 0) pass('Keine Duplikate gefunden');

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
