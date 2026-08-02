'use strict';

/**
 * validate-tmdb-series-catalog.js — Phase 75
 *
 * Prüft data/tmdb-series-catalog.json auf Schema-Korrektheit UND darauf, dass
 * NIE mehr als die allowlisteten öffentlichen Felder enthalten sind (kein
 * api_key, kein Roh-TMDB-Blob, keine privaten Sammlungsfelder). Wird sowohl
 * vom Runner (scripts/update-tmdb-catalog.js) als auch eigenständig in CI
 * aufgerufen (analog validate-release-volume-counts.js).
 *
 * Aufruf:
 *   node scripts/validate-tmdb-series-catalog.js [catalog-datei]
 *
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const defaultFile = path.join(repoRoot, 'data', 'tmdb-series-catalog.json');

const ALLOWED_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'generatedAt', 'source', 'items']);
// Exakte Allowlist aus spec.md Phase 75 — "nichts weiter".
const ALLOWED_ITEM_KEYS = new Set([
  'tmdbId', 'title', 'network', 'total', 'seasonCount', 'ongoing', 'cover', 'genres', 'overview', 'seasons',
  'streamingProviders',
]);
// Verbotene Keys, egal wo im Dokument: API-Key-Leck oder private Sammlungsfelder.
const FORBIDDEN_KEYS = new Set([
  'api_key', 'apiKey', 'token', 'data',
  'notes', 'owned', 'status', 'bands', 'bandCovers', 'current', 'externalIds',
  'startedAt', 'finishedAt', 'owner_token', 'ownerToken', 'view_token', 'viewToken',
]);
const ALLOWED_ONGOING = new Set(['true', 'false', null]);
const MAX_GENRES = 12;
// Spiegelt MAX_PROVIDERS aus scripts/tmdb-provider.js (Phase 77).
const MAX_PROVIDERS = 20;

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Datei nicht gefunden: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Ungültiges JSON in "${path.basename(filePath)}": ${e.message}`);
  }
}

function isHttpsUrlOrEmpty(value) {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) { return false; }
}

function isIsoDateTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

// Rekursiv jeder Schlüssel im Dokument — fängt auch einen versehentlichen
// {...tmdb}-Spread ab, der ALLOWED_ITEM_KEYS umgeht, aber einen verbotenen
// Key mitbringt (z. B. api_key steckt in einem verschachtelten Objekt).
function walkForbidden(value, errors, pathLabel) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForbidden(item, errors, `${pathLabel}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) errors.push(`${pathLabel}.${key}: verbotener Key (private/Secret-Feld)`);
      walkForbidden(nested, errors, `${pathLabel}.${key}`);
    }
  }
}

function validateTmdbSeriesCatalog(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['document-not-an-object'] };
  }

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) errors.push(`Top-Level-Key nicht erlaubt: ${key}`);
  }
  walkForbidden(doc, errors, '$');

  if (doc.schemaVersion !== 1) errors.push('schemaVersion muss 1 sein');
  if (!isIsoDateTime(doc.generatedAt)) errors.push('generatedAt muss ein ISO-Zeitstempel sein');
  if (typeof doc.source !== 'string' || !doc.source.trim()) errors.push('source muss ein nicht-leerer String sein');
  if (!Array.isArray(doc.items)) {
    errors.push('"items" ist kein Array');
    return { ok: errors.length === 0, errors };
  }

  const seenIds = new Set();
  doc.items.forEach((item, index) => {
    const where = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where}: kein Objekt`);
      return;
    }

    for (const key of Object.keys(item)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) errors.push(`${where}.${key}: Key nicht allowlistet`);
    }

    if (!Number.isInteger(item.tmdbId) || item.tmdbId < 1) {
      errors.push(`${where}.tmdbId: muss ein Integer >= 1 sein`);
    } else if (seenIds.has(item.tmdbId)) {
      errors.push(`${where}.tmdbId: Duplikat (${item.tmdbId})`);
    } else {
      seenIds.add(item.tmdbId);
    }

    if (typeof item.title !== 'string' || !item.title.trim()) errors.push(`${where}.title: muss ein nicht-leerer String sein`);
    if (typeof item.network !== 'string') errors.push(`${where}.network: muss ein String sein (ggf. leer)`);

    if (item.total !== null && (!Number.isInteger(item.total) || item.total < 1)) {
      errors.push(`${where}.total: muss null oder ein Integer >= 1 sein (erhalten: ${JSON.stringify(item.total)})`);
    }
    if (!Number.isInteger(item.seasonCount) || item.seasonCount < 0) {
      errors.push(`${where}.seasonCount: muss ein Integer >= 0 sein`);
    }
    if (!ALLOWED_ONGOING.has(item.ongoing)) errors.push(`${where}.ongoing: muss 'true', 'false' oder null sein`);
    if (!isHttpsUrlOrEmpty(item.cover)) errors.push(`${where}.cover: muss '' oder eine https://-URL sein`);

    if (!Array.isArray(item.genres)) {
      errors.push(`${where}.genres: muss ein Array sein`);
    } else {
      if (item.genres.length > MAX_GENRES) errors.push(`${where}.genres: mehr als ${MAX_GENRES} Einträge`);
      item.genres.forEach((g, gi) => {
        if (typeof g !== 'string' || !g.trim()) errors.push(`${where}.genres[${gi}]: muss ein nicht-leerer String sein`);
      });
    }

    if (typeof item.overview !== 'string') errors.push(`${where}.overview: muss ein String sein (ggf. leer)`);

    if (!Array.isArray(item.streamingProviders)) {
      errors.push(`${where}.streamingProviders: muss ein Array sein`);
    } else {
      if (item.streamingProviders.length > MAX_PROVIDERS) errors.push(`${where}.streamingProviders: mehr als ${MAX_PROVIDERS} Einträge`);
      item.streamingProviders.forEach((p, pi) => {
        if (typeof p !== 'string' || !p.trim()) errors.push(`${where}.streamingProviders[${pi}]: muss ein nicht-leerer String sein`);
      });
    }

    if (!item.seasons || typeof item.seasons !== 'object' || Array.isArray(item.seasons)) {
      errors.push(`${where}.seasons: muss ein Objekt sein`);
    } else {
      Object.entries(item.seasons).forEach(([band, seasonNumber]) => {
        if (!/^\d+$/.test(band) || Number(band) < 1) errors.push(`${where}.seasons: Schlüssel "${band}" ist kein Band >= 1`);
        if (!Number.isInteger(seasonNumber) || seasonNumber < 1) errors.push(`${where}.seasons["${band}"]: Wert muss ein Integer >= 1 sein`);
      });
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

  const result = validateTmdbSeriesCatalog(doc);
  if (!result.ok) {
    result.errors.forEach(err => console.error('  ✗ ' + err));
    console.error(`\n❌ Validierung fehlgeschlagen — ${result.errors.length} Fehler gefunden\n`);
    process.exit(1);
  }
  const count = Array.isArray(doc.items) ? doc.items.length : 0;
  console.log(`✅ Validierung erfolgreich — ${count} Item(s) geprüft, keine Fehler\n`);
}

if (require.main === module) main();

module.exports = { validateTmdbSeriesCatalog, ALLOWED_ITEM_KEYS, ALLOWED_TOP_LEVEL_KEYS, FORBIDDEN_KEYS };
