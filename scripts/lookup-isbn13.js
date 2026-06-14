#!/usr/bin/env node
'use strict';

/**
 * lookup-isbn13.js — Backlog 3.1
 *
 * Ermittelt für aktivierte Watchlist-Bände (Serientitel + Verlag + Bandnummer)
 * eine ISBN-13 über die Open-Library-Search-API und legt das Ergebnis in einem
 * separaten, versionierten Cache (data/isbn-lookup-cache.json) ab.
 *
 * Bewusst konservativ: Es wird NIE ein unsicherer Treffer als ISBN-13 geschrieben.
 * Nur bei genau einem plausiblen, gültigen Kandidaten -> confidence "high".
 * Sonst "unsure"/"none" mit isbn13: null.
 *
 * Aufruf:
 *   node scripts/lookup-isbn13.js [--write] [--json] [--limit N]
 *                                 [--watchlist <pfad>] [--cache <pfad>]
 *
 * - Default ist Dry-Run (kein Schreiben). --write persistiert nach Cache.
 * - --json schreibt genau einen JSON-Block auf stdout (Logs auf stderr,
 *   Phase-49-stdout-Hygiene).
 * - --limit N fragt maximal N Bände ab (schont API bei manuellen Läufen).
 *
 * Exit 0 bei erfolgreichem Lauf (auch ohne ISBN-Treffer);
 * Exit 1 nur bei harten Fehlern (Datei nicht lesbar / ungültiges JSON).
 *
 * Test-Determinismus: fetchJson ist per context injizierbar (DI, exakt wie in
 * den Release-Providern). Tests injizieren einen Fake-fetchJson und machen
 * KEINE echten Netz-Calls.
 *
 * NICHT-Ziel dieses Schritts: Verdrahtung in den Matching-Pfad
 * (release-confidence.js) — bleibt unberührt.
 */

const fs = require('fs');
const path = require('path');

const {
  normalizeTitle,
  normalizePublisher,
  buildPublisherAliasMap,
} = require('./release-confidence');
const {
  fetchJson: defaultFetchJson,
  normalizeIsbn13,
} = require('./release-providers/provider-utils');

const repoRoot = path.resolve(__dirname, '..');
const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const SOURCE = 'openlibrary';
const SCRIPT_SOURCE = 'lookup-isbn13.js';

// ── reine Kernfunktionen (offline testbar) ───────────────────────────────────

/**
 * Fächert die Watchlist zu Einzel-Bänden auf und ignoriert enabled === false.
 * volumeNumber (Einzelband) und volumeNumbers[] (mehrere Bände) werden beide
 * unterstützt; Duplikate (seriesTitle+publisher+volume) werden dedupliziert.
 */
function expandWatchlistItems(watchlist) {
  const items = Array.isArray(watchlist && watchlist.items) ? watchlist.items : [];
  const expanded = [];
  const seen = new Set();

  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    const seriesTitle = entry.seriesTitle;
    const publisher = entry.publisher || null;

    const volumeNumbers = [];
    if (Object.prototype.hasOwnProperty.call(entry, 'volumeNumber')) {
      volumeNumbers.push(entry.volumeNumber);
    }
    if (Array.isArray(entry.volumeNumbers)) {
      for (const num of entry.volumeNumbers) volumeNumbers.push(num);
    }

    for (const volumeNumber of volumeNumbers) {
      const key = `${normalizeTitle(seriesTitle)}|${normalizePublisher(publisher)}|${volumeNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push({ seriesTitle, publisher, volumeNumber });
    }
  }
  return expanded;
}

function isGermanDoc(doc) {
  const langs = Array.isArray(doc && doc.language) ? doc.language : [];
  return langs.some(lang => String(lang).toLowerCase() === 'ger' || String(lang).toLowerCase() === 'de');
}

function docPublishers(doc) {
  return Array.isArray(doc && doc.publisher) ? doc.publisher.filter(Boolean) : [];
}

function docTitle(doc) {
  return doc && (doc.title_suggest || doc.title) || '';
}

/**
 * Wählt aus einer Open-Library-search.json-Antwort genau dann eine ISBN-13, wenn
 * genau ein plausibler, gültiger Kandidat existiert. Reine Logik, kein Netzwerk.
 *
 * "Plausibel" = normalisierter Titel-Match (normalizeTitle) UND mindestens eine
 * gültige ISBN-13 (normalizeIsbn13: 978/979 + 13 Stellen). Deutschsprachige
 * Ausgaben und Verlags-Übereinstimmung (normalizePublisher) sind zusätzliche
 * Signale: liefert die Suche mehrere plausible docs, aber genau eine deutsche
 * mit passendem Verlag, gilt diese als der eindeutige Kandidat.
 *
 * Rückgabe: { isbn13, confidence, candidateCount, evidence } — niemals eine ISBN
 * ohne confidence "high".
 */
function selectIsbnFromResponse(query, apiResponse, options = {}) {
  const aliasMap = options.aliasMap;
  const docs = Array.isArray(apiResponse && apiResponse.docs) ? apiResponse.docs : [];
  if (docs.length === 0) {
    return { isbn13: null, confidence: 'none', candidateCount: 0, evidence: 'Open Library lieferte keine Treffer (docs: []).' };
  }

  const expectedTitle = normalizeTitle(query.seriesTitle);
  const expectedPublisher = query.publisher ? normalizePublisher(query.publisher, aliasMap) : '';

  // Plausible Kandidaten: Titel-Match. Pro doc werden ALLE gültigen ISBN-13
  // behalten (Open Library bündelt mehrere Editionen — Hardcover/Paperback/
  // Neuauflage — typischerweise unter einem Work-doc).
  const candidates = [];
  for (const doc of docs) {
    if (normalizeTitle(docTitle(doc)) !== expectedTitle) continue;
    const isbns = (Array.isArray(doc && doc.isbn) ? doc.isbn : [])
      .map(normalizeIsbn13)
      .filter(Boolean);
    if (isbns.length === 0) continue;
    const publishers = docPublishers(doc).map(name => normalizePublisher(name, aliasMap));
    candidates.push({
      isbns,
      german: isGermanDoc(doc),
      publisherMatch: expectedPublisher ? publishers.includes(expectedPublisher) : false,
    });
  }

  // Menge der DISTINKTEN gültigen ISBN-13 über alle titel-passenden docs.
  const distinct = isbns => new Set([].concat(...isbns.map(c => c.isbns)));

  const allIsbns = distinct(candidates);
  if (allIsbns.size === 0) {
    return {
      isbn13: null,
      confidence: 'none',
      candidateCount: 0,
      evidence: 'Kein Treffer mit passendem Titel und gültiger ISBN-13 (978/979).',
    };
  }

  if (allIsbns.size === 1) {
    return {
      isbn13: [...allIsbns][0],
      confidence: 'high',
      candidateCount: 1,
      evidence: 'Genau eine distinkte ISBN-13 über alle plausiblen Treffer (Titel-Match).',
    };
  }

  // Mehr als eine distinkte ISBN-13: Verengung NUR mit erwartetem Verlag, der
  // matcht. Ohne expectedPublisher wird konservativ nicht verengt -> unsure.
  if (expectedPublisher) {
    const narrowed = candidates.filter(c => c.german && c.publisherMatch);
    const narrowedIsbns = distinct(narrowed);
    if (narrowedIsbns.size === 1) {
      return {
        isbn13: [...narrowedIsbns][0],
        confidence: 'high',
        candidateCount: allIsbns.size,
        evidence: `Eindeutig über deutschsprachige Ausgabe und Verlag auf eine ISBN verengt (${allIsbns.size} distinkte Roh-ISBN).`,
      };
    }
  }

  return {
    isbn13: null,
    confidence: 'unsure',
    candidateCount: allIsbns.size,
    evidence: `${allIsbns.size} distinkte plausible ISBN-13 — konservativ keine gewählt.`,
  };
}

function buildOpenLibraryUrl(query) {
  const params = new URLSearchParams();
  params.set('title', String(query.seriesTitle || ''));
  if (query.publisher) params.set('publisher', String(query.publisher));
  params.set('fields', 'title,title_suggest,isbn,publisher,language');
  params.set('limit', '20');
  return `${OPENLIBRARY_SEARCH}?${params.toString()}`;
}

/**
 * Fragt Open Library für genau einen Band ab und liefert das Cache-Item.
 * context = { fetchJson, aliasMap, policy }. Netzfehler werden abgefangen
 * (kein Crash) -> confidence "none", isbn13 null, Fehlertext in evidence.
 */
async function lookupOne(query, context = {}) {
  const fetchJson = typeof context.fetchJson === 'function' ? context.fetchJson : defaultFetchJson;
  const aliasMap = context.aliasMap;
  const policy = context.policy || {};
  const checkedAt = context.checkedAt || new Date().toISOString();

  const base = {
    seriesTitle: query.seriesTitle,
    normalizedSeriesTitle: normalizeTitle(query.seriesTitle),
    publisher: query.publisher || null,
    normalizedPublisher: query.publisher ? normalizePublisher(query.publisher, aliasMap) : null,
    volumeNumber: query.volumeNumber,
    source: SOURCE,
    checkedAt,
  };

  try {
    const response = await fetchJson(buildOpenLibraryUrl(query), policy);
    const selection = selectIsbnFromResponse(query, response, { aliasMap });
    return {
      ...base,
      isbn13: selection.isbn13,
      confidence: selection.confidence,
      candidateCount: selection.candidateCount,
      evidence: selection.evidence,
    };
  } catch (error) {
    return {
      ...base,
      isbn13: null,
      confidence: 'none',
      candidateCount: 0,
      evidence: `Open Library konnte nicht abgefragt werden: ${error.message}`,
    };
  }
}

/**
 * Orchestriert das Lookup über die expandierten Items und baut das Cache-Objekt.
 * Schreibt NICHT selbst (das Schreiben/Mergen macht die CLI).
 */
async function runLookup({ items, context = {}, limit }) {
  const list = Array.isArray(items) ? items : [];
  const effective = (Number.isInteger(limit) && limit > 0) ? list.slice(0, limit) : list;
  const resultItems = [];
  for (const query of effective) {
    resultItems.push(await lookupOne(query, context));
  }
  return {
    schemaVersion: 1,
    generatedAt: context.generatedAt || new Date().toISOString(),
    source: SCRIPT_SOURCE,
    itemCount: resultItems.length,
    items: resultItems,
  };
}

// ── --write-Idempotenz: bestehende high-ISBN beibehalten ─────────────────────
//
// Nutzerentscheidung: Eine bereits gespeicherte high-ISBN darf nicht durch ein
// späteres none/unsure-Ergebnis überschrieben werden (kein Überschreiben einer
// sicheren ISBN durch ein schlechteres Ergebnis). Sie wird nur durch einen neuen
// high-Treffer ersetzt.

function cacheKey(item) {
  return `${normalizeTitle(item.seriesTitle)}|${normalizePublisher(item.publisher)}|${item.volumeNumber}`;
}

function mergeWithExistingCache(freshCache, existingCache) {
  const existingItems = Array.isArray(existingCache && existingCache.items) ? existingCache.items : [];
  const existingByKey = new Map(existingItems.map(item => [cacheKey(item), item]));

  const freshKeys = new Set(freshCache.items.map(cacheKey));

  const mergedItems = freshCache.items.map(fresh => {
    const previous = existingByKey.get(cacheKey(fresh));
    if (previous && previous.confidence === 'high' && fresh.confidence !== 'high') {
      // Sichere ISBN beibehalten; Hinweis im evidence vermerken.
      return {
        ...previous,
        evidence: `${previous.evidence || 'Vorheriger high-Treffer.'} (Beibehalten: neuer Lauf lieferte "${fresh.confidence}".)`,
        checkedAt: fresh.checkedAt,
      };
    }
    return fresh;
  });

  // Idempotenz-Union: bestehende high-Einträge, die im neuen Lauf gar nicht
  // abgefragt wurden (z. B. --limit oder enabled:false), bleiben erhalten —
  // sonst ginge eine sichere ISBN verloren.
  for (const previous of existingItems) {
    if (previous.confidence === 'high' && !freshKeys.has(cacheKey(previous))) {
      mergedItems.push(previous);
    }
  }

  return { ...freshCache, items: mergedItems, itemCount: mergedItems.length };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { write: false, json: false, limit: null, watchlist: null, cache: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--watchlist') args.watchlist = argv[++i];
    else if (arg === '--cache') args.cache = argv[++i];
  }
  return args;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jsonMode = args.json;

  // Phase-49-stdout-Hygiene: im --json-Mode landet NUR ein JSON-Block auf stdout.
  function logInfo() {
    if (jsonMode) console.error.apply(console, arguments);
    else console.log.apply(console, arguments);
  }
  function writeJsonStdout(obj) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  }

  const watchlistFile = args.watchlist
    ? path.resolve(args.watchlist)
    : path.join(repoRoot, 'data', 'release-watchlist.json');
  const cacheFile = args.cache
    ? path.resolve(args.cache)
    : path.join(repoRoot, 'data', 'isbn-lookup-cache.json');

  let watchlist;
  let sources;
  try {
    watchlist = readJson(watchlistFile);
    sources = fs.existsSync(path.join(repoRoot, 'data', 'release-sources.json'))
      ? readJson(path.join(repoRoot, 'data', 'release-sources.json'))
      : null;
  } catch (e) {
    if (jsonMode) writeJsonStdout({ schemaVersion: 1, error: e.message, itemCount: 0, items: [] });
    else console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const aliasMap = buildPublisherAliasMap(sources);
  const policy = (sources && sources.requestPolicy) || {};
  const items = expandWatchlistItems(watchlist);

  logInfo(`ISBN-13-Lookup (Open Library) — ${items.length} Watchlist-Band(e)`);
  if (args.write) logInfo('Modus: --write (Cache wird aktualisiert)');
  else logInfo('Modus: Dry-Run (kein Schreiben; nutze --write zum Persistieren)');

  const freshCache = await runLookup({
    items,
    context: { fetchJson: defaultFetchJson, aliasMap, policy },
    limit: args.limit,
  });

  let finalCache = freshCache;
  if (args.write) {
    const existing = fs.existsSync(cacheFile) ? readJson(cacheFile) : null;
    finalCache = mergeWithExistingCache(freshCache, existing);
    fs.writeFileSync(cacheFile, JSON.stringify(finalCache, null, 2) + '\n', 'utf-8');
    logInfo(`Cache geschrieben: ${path.relative(repoRoot, cacheFile).replace(/\\/g, '/')}`);
  }

  const highCount = finalCache.items.filter(i => i.confidence === 'high').length;
  logInfo(`Ergebnis: ${highCount} high / ${finalCache.itemCount} geprüft`);

  if (jsonMode) writeJsonStdout(finalCache);

  process.exitCode = 0;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  expandWatchlistItems,
  selectIsbnFromResponse,
  buildOpenLibraryUrl,
  lookupOne,
  runLookup,
  mergeWithExistingCache,
};
