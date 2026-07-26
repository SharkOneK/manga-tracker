#!/usr/bin/env node
'use strict';

/**
 * Phase 75: server-seitiger TMDB-Import (GitHub Actions, TMDB_API_KEY Secret).
 *
 * Liest die kuratierte Watchlist (data/tmdb-watchlist.json), holt für jede
 * `enabled`-ID die TMDB-Serie und mappt sie über scripts/tmdb-provider.js auf
 * einen sanitisierten Katalogrecord. Schreibt NUR:
 *   - data/tmdb-series-catalog.json
 *
 * Struktur analog scripts/run-series-publication-status.js: stabiler
 * generatedAt-Zeitstempel (kein Diff-Rauschen ohne inhaltliche Änderung),
 * defensive Fehlerbehandlung pro ID (eine kaputte/timeoutende ID bricht NIE
 * den Gesamtlauf ab), abschließende Validierung vor dem Schreiben.
 *
 * Läuft NICHT in scripts/run-all-checks.js (braucht Netzwerk + Secret) —
 * ausschließlich über .github/workflows/update-tmdb-catalog.yml.
 *
 * Der API-Key wird ausschließlich aus process.env.TMDB_API_KEY gelesen, nie
 * geloggt und nie in ein Artefakt geschrieben. Fehlt er, bricht der Lauf
 * sofort und sauber ab (kein Teilkatalog-Commit ohne Key, kein Leck).
 */

const fs = require('fs');
const path = require('path');
const { fetchSeries } = require('./tmdb-provider');
const { validateTmdbSeriesCatalog } = require('./validate-tmdb-series-catalog');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const watchlistFile = path.join(dataDir, 'tmdb-watchlist.json');
const catalogFile = path.join(dataDir, 'tmdb-series-catalog.json');

const DEFAULT_DELAY_MS = Number(process.env.TMDB_MIN_DELAY_MS || 250);
const DEFAULT_TIMEOUT_MS = Number(process.env.TMDB_TIMEOUT_MS || 10000);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonStable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function stripGeneratedAt(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.generatedAt;
  return copy;
}

// Schreibt generatedAt nur neu, wenn sich der Inhalt tatsächlich geändert hat —
// sonst entsteht bei jedem Lauf ein Diff ohne inhaltliche Änderung (analog
// run-series-publication-status.js).
function stableGeneratedAt(file, doc) {
  if (!fs.existsSync(file)) return doc.generatedAt;
  try {
    const existing = readJson(file);
    if (JSON.stringify(stripGeneratedAt(existing)) === JSON.stringify(stripGeneratedAt(doc))) {
      return existing.generatedAt;
    }
  } catch (_) { /* ignore and use new timestamp */ }
  return doc.generatedAt;
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    // Fail-closed: kein Live-Netz ohne Key, kein Teilkatalog-Commit.
    throw new Error('TMDB_API_KEY fehlt (GitHub Secret nicht gesetzt) — Abbruch ohne Netzzugriff.');
  }

  const startedAt = new Date().toISOString();
  const watchlist = fs.existsSync(watchlistFile) ? readJson(watchlistFile) : { items: [] };
  const enabledItems = (Array.isArray(watchlist.items) ? watchlist.items : [])
    .filter(item => item && item.enabled === true && Number.isInteger(item.tmdbId));

  const records = [];
  const skipped = [];

  for (const item of enabledItems) {
    const res = await fetchSeries(item.tmdbId, {
      fetchImpl: fetch,
      apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (!res.ok) {
      // Nur die Fehlerklasse landet im Log — nie die Anfrage-URL/den Key.
      console.warn(`  ⚠ tmdbId ${item.tmdbId} (${item.title || 'ohne Titel'}) übersprungen: ${res.reason}`);
      skipped.push({ tmdbId: item.tmdbId, title: item.title || '', reason: res.reason });
    } else {
      records.push(res.record);
    }
    await sleep(DEFAULT_DELAY_MS);
  }

  records.sort((a, b) => a.title.localeCompare(b.title, 'de') || a.tmdbId - b.tmdbId);

  const existingCatalog = fs.existsSync(catalogFile)
    ? readJson(catalogFile)
    : { schemaVersion: 1, generatedAt: startedAt, source: 'update-tmdb-catalog.js', items: [] };

  const nextCatalog = {
    schemaVersion: 1,
    generatedAt: startedAt,
    source: 'update-tmdb-catalog.js',
    items: records,
  };
  nextCatalog.generatedAt = stableGeneratedAt(catalogFile, nextCatalog);

  const validation = validateTmdbSeriesCatalog(nextCatalog);
  if (!validation.ok) {
    throw new Error(`tmdb-series-catalog validation failed: ${validation.errors.join('; ')}`);
  }

  if (JSON.stringify(existingCatalog) !== JSON.stringify(nextCatalog)) {
    writeJsonStable(catalogFile, nextCatalog);
  }

  console.log('TMDB-Katalog-Pipeline abgeschlossen.');
  console.log(`  Watchlist enabled: ${enabledItems.length}`);
  console.log(`  Erfolgreich gemappt: ${records.length}`);
  console.log(`  Übersprungen (Fehler): ${skipped.length}`);
  if (skipped.length) {
    skipped.forEach(s => console.log(`    - tmdbId ${s.tmdbId} (${s.title}): ${s.reason}`));
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('update-tmdb-catalog fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
