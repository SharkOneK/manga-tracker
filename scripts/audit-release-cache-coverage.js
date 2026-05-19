'use strict';

/**
 * audit-release-cache-coverage.js — Phase 19
 *
 * Prüft ob aktivierte Watchlist-Einträge im Release-Cache vorhanden sind.
 *
 * Aufruf:
 *   node scripts/audit-release-cache-coverage.js [--strict]
 *
 * Standardpfade (relativ zum Repo-Root):
 *   data/release-watchlist.json
 *   data/release-cache.json
 *
 * Exit 0 = OK (Warnmodus) — auch bei fehlenden Einträgen
 * Exit 1 = Fehler nur wenn --strict gesetzt
 */

const fs   = require('fs');
const path = require('path');

const repoRoot      = path.resolve(__dirname, '..');
const watchlistFile = path.join(repoRoot, 'data', 'release-watchlist.json');
const cacheFile     = path.join(repoRoot, 'data', 'release-cache.json');
const strict        = process.argv.includes('--strict');

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

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(watchlistNorm, cacheNorm) {
  if (!watchlistNorm || !cacheNorm) return false;
  if (watchlistNorm === cacheNorm) return true;
  if (watchlistNorm.length >= 3 && cacheNorm.includes(watchlistNorm)) return true;
  if (cacheNorm.length >= 3 && watchlistNorm.includes(cacheNorm)) return true;
  return false;
}

// ─── Dateien laden ────────────────────────────────────────────────────────
console.log('\nAudit: Release-Cache-Abdeckung (Watchlist vs. Cache)\n');

let watchlist, cache;
try {
  watchlist = readJson(watchlistFile);
} catch (e) {
  console.error(`  ✗ ${e.message}`);
  console.error('\n❌ Audit fehlgeschlagen (Watchlist nicht lesbar)\n');
  process.exit(1);
}

try {
  cache = readJson(cacheFile);
} catch (e) {
  console.error(`  ✗ ${e.message}`);
  console.error('\n❌ Audit fehlgeschlagen (Cache nicht lesbar)\n');
  process.exit(1);
}

const enabledItems = (Array.isArray(watchlist.items) ? watchlist.items : [])
  .filter(item => item && item.enabled === true);

const cacheItems = Array.isArray(cache.items) ? cache.items : [];

console.log(`Watchlist: ${enabledItems.length} aktivierte Einträge`);
console.log(`Cache: ${cacheItems.length} Einträge\n`);

// ─── Abgleich ─────────────────────────────────────────────────────────────
let missingCount = 0;
let foundCount   = 0;

enabledItems.forEach(entry => {
  const normTitle = normalizeTitle(entry.seriesTitle);
  const vol       = entry.volumeNumber;

  const found = cacheItems.some(item => {
    if (!item || typeof item !== 'object') return false;
    const cacheNorm = item.normalizedSeriesTitle || normalizeTitle(item.seriesTitle || '');
    if (!titleMatches(normTitle, cacheNorm)) return false;
    return item.volumeNumber === vol;
  });

  if (found) {
    console.log(`  ✓ ${entry.seriesTitle} Band ${vol} gefunden`);
    foundCount++;
  } else {
    console.log(`  ✗ ${entry.seriesTitle} Band ${vol} fehlt`);
    missingCount++;
  }
});

// ─── Zusammenfassung ──────────────────────────────────────────────────────
console.log('');
console.log(`Gefundene Cache-Einträge: ${foundCount}`);
console.log(`Fehlende Cache-Abdeckung: ${missingCount}`);

if (missingCount === 0) {
  console.log('\n✅ Alle aktivierten Watchlist-Einträge sind im Cache abgedeckt\n');
} else {
  console.log(`\n⚠ ${missingCount} Watchlist-Eintrag/Einträge noch nicht im Cache`);
  if (strict) {
    console.error('❌ Strict-Modus: Exit 1 wegen fehlender Cache-Abdeckung\n');
    process.exit(1);
  } else {
    console.log('ℹ Warnmodus (kein --strict): Exit 0\n');
  }
}
