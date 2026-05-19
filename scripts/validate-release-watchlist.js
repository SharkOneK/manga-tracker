'use strict';

/**
 * validate-release-watchlist.js — Phase 22
 *
 * Prüft data/release-watchlist.json auf Schema-Korrektheit.
 * Unterstützt volumeNumber (Einzelband) und volumeNumbers (Mehrband-Array).
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

  // volumeNumber / volumeNumbers: genau eines muss vorhanden sein, nicht beide
  const hasVolumeNumber  = 'volumeNumber' in item;
  const hasVolumeNumbers = 'volumeNumbers' in item;

  if (hasVolumeNumber && hasVolumeNumbers) {
    fail(`${label}: "volumeNumber" und "volumeNumbers" dürfen nicht gleichzeitig gesetzt sein`);
    itemErrorCount++;
  } else if (hasVolumeNumber) {
    // volumeNumber: integer >= 1
    if (!Number.isInteger(item.volumeNumber) || item.volumeNumber < 1) {
      fail(`${label}: "volumeNumber" muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.volumeNumber)})`);
      itemErrorCount++;
    }
  } else if (hasVolumeNumbers) {
    // volumeNumbers: Array, nicht leer, alle integer >= 1, keine Duplikate
    if (!Array.isArray(item.volumeNumbers) || item.volumeNumbers.length === 0) {
      fail(`${label}: "volumeNumbers" muss ein nicht-leeres Array sein (erhalten: ${JSON.stringify(item.volumeNumbers)})`);
      itemErrorCount++;
    } else {
      let arrayError = false;
      item.volumeNumbers.forEach((v, i) => {
        if (!Number.isInteger(v) || v < 1) {
          fail(`${label}: "volumeNumbers[${i}]" muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(v)})`);
          itemErrorCount++;
          arrayError = true;
        }
      });
      if (!arrayError) {
        const volSet = new Set(item.volumeNumbers);
        if (volSet.size !== item.volumeNumbers.length) {
          fail(`${label}: "volumeNumbers" enthält Duplikate`);
          itemErrorCount++;
        }
      }
    }
  } else {
    fail(`${label}: entweder "volumeNumber" oder "volumeNumbers" muss vorhanden sein`);
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

// Duplikat-Check: erkennt Überschneidungen zwischen volumeNumber und volumeNumbers
// Normalisierter Schlüssel: title|publisher|volumeNummer
const seen = new Map();

function checkVolumeDuplicate(item, idx, vol) {
  const normalizedKey = normalizeForDuplicateCheck(item.seriesTitle, item.publisher) + '|' + vol;
  if (seen.has(normalizedKey)) {
    fail(`Duplikat gefunden: Item ${idx + 1} und Item ${seen.get(normalizedKey) + 1} haben gleiche Kombination aus seriesTitle + publisher + volumeNumber ("${normalizedKey}")`);
  } else {
    seen.set(normalizedKey, idx);
  }
}

watchlist.items.forEach((item, idx) => {
  if (!item || typeof item !== 'object') return;
  if ('volumeNumber' in item && Number.isInteger(item.volumeNumber)) {
    checkVolumeDuplicate(item, idx, item.volumeNumber);
  } else if ('volumeNumbers' in item && Array.isArray(item.volumeNumbers)) {
    item.volumeNumbers.forEach(v => {
      if (Number.isInteger(v)) checkVolumeDuplicate(item, idx, v);
    });
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
