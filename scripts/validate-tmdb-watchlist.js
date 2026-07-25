'use strict';

/**
 * validate-tmdb-watchlist.js — Phase 75
 *
 * Prüft data/tmdb-watchlist.json auf Schema-Korrektheit.
 * Kuratierte Eingabeliste für scripts/update-tmdb-catalog.js (analog
 * validate-release-watchlist.js): steuert, WELCHE TMDB-Serien-IDs der
 * Runner abfragt (E5, spec.md Phase 75).
 *
 * Aufruf:
 *   node scripts/validate-tmdb-watchlist.js [watchlist-datei]
 *
 * Standardpfad (relativ zum Repo-Root):
 *   data/tmdb-watchlist.json
 *
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const defaultFile = path.join(repoRoot, 'data', 'tmdb-watchlist.json');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Datei nicht gefunden: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Ungültiges JSON in "${path.basename(filePath)}": ${e.message}`);
  }
}

function validateTmdbWatchlist(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['document-not-an-object'] };
  }
  if (doc.schemaVersion !== 1) errors.push('schemaVersion muss 1 sein');
  if (!Array.isArray(doc.items)) {
    errors.push('"items" ist kein Array');
    return { ok: errors.length === 0, errors };
  }

  const seen = new Set();
  doc.items.forEach((item, index) => {
    const where = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where}: kein Objekt`);
      return;
    }
    if (!Number.isInteger(item.tmdbId) || item.tmdbId < 1) {
      errors.push(`${where}.tmdbId: muss ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.tmdbId)})`);
    } else if (seen.has(item.tmdbId)) {
      errors.push(`${where}.tmdbId: Duplikat (${item.tmdbId})`);
    } else {
      seen.add(item.tmdbId);
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      errors.push(`${where}.title: fehlt oder ist leer (nur menschenlesbarer Hinweis, nicht autoritativ)`);
    }
    if (typeof item.enabled !== 'boolean') {
      errors.push(`${where}.enabled: muss ein Boolean sein (erhalten: ${JSON.stringify(item.enabled)})`);
    }
    if (item.notes !== undefined && typeof item.notes !== 'string') {
      errors.push(`${where}.notes: muss ein String sein, wenn vorhanden`);
    }
  });

  return { ok: errors.length === 0, errors };
}

function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : defaultFile;
  console.log(`\nPrüfe: ${file}\n`);

  let doc;
  try {
    doc = readJson(file);
  } catch (e) {
    console.error('  ✗ ' + e.message);
    console.error('\n❌ Validierung fehlgeschlagen (Datei nicht lesbar)\n');
    process.exit(1);
  }

  const result = validateTmdbWatchlist(doc);
  if (!result.ok) {
    result.errors.forEach(err => console.error('  ✗ ' + err));
    console.error(`\n❌ Validierung fehlgeschlagen — ${result.errors.length} Fehler gefunden\n`);
    process.exit(1);
  }
  const count = Array.isArray(doc.items) ? doc.items.length : 0;
  console.log(`✅ Validierung erfolgreich — ${count} Item(s) geprüft, keine Fehler\n`);
}

if (require.main === module) main();

module.exports = { validateTmdbWatchlist };
