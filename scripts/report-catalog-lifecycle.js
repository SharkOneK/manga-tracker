#!/usr/bin/env node
'use strict';

/**
 * Phase 47: catalog lifecycle drift report.
 *
 * Compares release artifacts with the shared Supabase catalog. The script is
 * diagnostic only: it never writes to Supabase and never changes source data.
 *
 * Optional env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  required to read manga_catalog_candidates
 *   SUPABASE_ANON_KEY          fallback for verified entries if service key is absent
 *
 * Usage:
 *   node scripts/report-catalog-lifecycle.js
 *   node scripts/report-catalog-lifecycle.js --out artifacts/catalog-lifecycle.json
 *   node scripts/report-catalog-lifecycle.js --collection export.json
 */

const fs = require('fs');
const path = require('path');
const {
  buildPublisherAliasMap,
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const DEFAULT_OUT = path.join(DATA_DIR, 'release-catalog-lifecycle-report.json');
const PAGE_SIZE = 1000;
const MAX_ROWS = 100000;

function parseArgs(argv) {
  const args = { outFile: DEFAULT_OUT, collectionFile: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) args.outFile = path.resolve(argv[++i]);
    else if (argv[i] === '--collection' && argv[i + 1]) args.collectionFile = path.resolve(argv[++i]);
  }
  return args;
}

function readJsonIfExists(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toVolumeNumbers(item) {
  if (Array.isArray(item && item.volumeNumbers)) return item.volumeNumbers;
  if (Object.prototype.hasOwnProperty.call(item || {}, 'volumeNumber')) return [item.volumeNumber];
  return [];
}

function keyFromParts(seriesTitle, publisher, volumeNumber, aliasMap) {
  const volume = Number(volumeNumber);
  if (!Number.isInteger(volume) || volume < 1) return null;
  const title = normalizeTitle(seriesTitle);
  const pub = normalizePublisher(publisher, aliasMap);
  if (!title || !pub) return null;
  return [title, pub, volume].join('|');
}

function addArtifactItems(map, artifact, items, aliasMap) {
  (Array.isArray(items) ? items : []).forEach(item => {
    toVolumeNumbers(item).forEach(volume => {
      const key = keyFromParts(item.seriesTitle, item.publisher, volume, aliasMap);
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          key,
          seriesTitle: item.seriesTitle,
          publisher: item.publisher,
          volumeNumber: Number(volume),
          artifacts: {},
          warnings: [],
        });
      }
      map.get(key).artifacts[artifact] = true;
    });
  });
}

function addSupabaseRows(map, artifact, rows, aliasMap) {
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const key = keyFromParts(
      row.series_title || row.seriesTitle,
      row.publisher,
      row.volume_number == null ? row.volumeNumber : row.volume_number,
      aliasMap
    );
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        key,
        seriesTitle: row.series_title || row.seriesTitle,
        publisher: row.publisher,
        volumeNumber: Number(row.volume_number == null ? row.volumeNumber : row.volume_number),
        artifacts: {},
        warnings: [],
      });
    }
    const record = map.get(key);
    record.artifacts[artifact] = true;
    if (artifact === 'supabaseCandidate') record.candidateStatus = row.status || null;
    if (artifact === 'supabaseEntry') record.entryVerified = row.verified === true;
  });
}

function collectionItemsFromFile(file) {
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mangaList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.m) ? parsed.m : []);
  const out = [];
  mangaList.forEach(manga => {
    const seriesTitle = String(manga && manga.title || '').trim();
    const publisher = String(manga && manga.pub || '').trim();
    if (!seriesTitle || !publisher) return;
    Object.keys((manga && manga.bands) || {}).forEach(volume => {
      const n = Number(volume);
      if (Number.isInteger(n) && n >= 1) out.push({ seriesTitle, publisher, volumeNumber: n });
    });
  });
  return out;
}

async function fetchSupabasePage(supaUrl, key, table, select, from, to) {
  const url = supaUrl.replace(/\/+$/, '') + '/rest/v1/' + table + '?select=' + encodeURIComponent(select);
  const res = await fetch(url, {
    headers: {
      apikey: key,
      authorization: 'Bearer ' + key,
      accept: 'application/json',
      range: from + '-' + to,
      'range-unit': 'items',
    },
  });
  if (res.status !== 200 && res.status !== 206) {
    const body = await res.text().catch(() => '');
    throw new Error(table + ' HTTP ' + res.status + ': ' + body.slice(0, 300));
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(table + ' response is not an array');
  return rows;
}

async function fetchSupabaseRows(supaUrl, key, table, select) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const rows = await fetchSupabasePage(supaUrl, key, table, select, from, from + PAGE_SIZE - 1);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (all.length >= MAX_ROWS) throw new Error(table + ' exceeded safety limit ' + MAX_ROWS);
  }
  return all;
}

function applyWarnings(record, availability) {
  const a = record.artifacts;
  if (a.releaseCache && availability.entries && !a.supabaseEntry) {
    record.warnings.push('cache_not_in_supabase_entries');
  }
  if (a.releaseCache && a.supabaseEntry && !a.supabaseSnapshot) {
    record.warnings.push('supabase_entry_not_in_snapshot');
  }
  if (a.watchlist && availability.candidates && !a.supabaseCandidate && !a.supabaseEntry) {
    record.warnings.push('watchlist_not_in_supabase_catalog');
  }
  if (a.localCollection && availability.candidates && !a.supabaseCandidate && !a.supabaseEntry) {
    record.warnings.push('local_seedable_not_global');
  }
  if (record.candidateStatus && ['blocked', 'rejected'].includes(record.candidateStatus)) {
    record.warnings.push('candidate_' + record.candidateStatus);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const sources = readJsonIfExists(path.join(DATA_DIR, 'release-sources.json'), {});
  const aliasMap = buildPublisherAliasMap(sources);
  const records = new Map();

  const watchlist = readJsonIfExists(path.join(DATA_DIR, 'release-watchlist.json'), { items: [] });
  const queue = readJsonIfExists(path.join(DATA_DIR, 'release-source-review-queue.json'), { queue: [] });
  const cache = readJsonIfExists(path.join(DATA_DIR, 'release-cache.json'), { items: [] });
  const snapshot = readJsonIfExists(path.join(DATA_DIR, 'release-cache-supabase-snapshot.json'), { items: [] });

  addArtifactItems(records, 'watchlist', watchlist.items, aliasMap);
  addArtifactItems(records, 'reviewQueue', queue.queue || queue.items, aliasMap);
  addArtifactItems(records, 'releaseCache', cache.items, aliasMap);
  addArtifactItems(records, 'supabaseSnapshot', snapshot.items, aliasMap);
  addArtifactItems(records, 'localCollection', collectionItemsFromFile(args.collectionFile), aliasMap);

  const supabase = {
    urlConfigured: Boolean(process.env.SUPABASE_URL),
    candidates: { available: false, count: 0, error: null },
    entries: { available: false, count: 0, error: null },
  };

  const supaUrl = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const readKey = serviceKey || process.env.SUPABASE_ANON_KEY || '';

  if (supaUrl && serviceKey) {
    try {
      const candidates = await fetchSupabaseRows(
        supaUrl,
        serviceKey,
        'manga_catalog_candidates',
        'series_title,publisher,volume_number,status,candidate_key,promoted_entry_id'
      );
      supabase.candidates = { available: true, count: candidates.length, error: null };
      addSupabaseRows(records, 'supabaseCandidate', candidates, aliasMap);
    } catch (e) {
      supabase.candidates.error = e.message || String(e);
    }
  }

  if (supaUrl && readKey) {
    try {
      const entries = await fetchSupabaseRows(
        supaUrl,
        readKey,
        'manga_catalog_entries',
        'series_title,publisher,volume_number,verified'
      );
      const verifiedEntries = entries.filter(row => row.verified === true);
      supabase.entries = { available: true, count: verifiedEntries.length, error: null };
      addSupabaseRows(records, 'supabaseEntry', verifiedEntries, aliasMap);
    } catch (e) {
      supabase.entries.error = e.message || String(e);
    }
  }

  const availability = {
    candidates: supabase.candidates.available,
    entries: supabase.entries.available,
  };
  const items = Array.from(records.values()).sort((a, b) => a.key.localeCompare(b.key, 'de'));
  items.forEach(item => applyWarnings(item, availability));

  const warningCounts = {};
  items.forEach(item => {
    item.warnings.forEach(warning => {
      warningCounts[warning] = (warningCounts[warning] || 0) + 1;
    });
  });

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'report-catalog-lifecycle.js',
    inputs: {
      watchlistItems: Array.isArray(watchlist.items) ? watchlist.items.length : 0,
      reviewQueueItems: Array.isArray(queue.queue || queue.items) ? (queue.queue || queue.items).length : 0,
      releaseCacheItems: Array.isArray(cache.items) ? cache.items.length : 0,
      supabaseSnapshotItems: Array.isArray(snapshot.items) ? snapshot.items.length : 0,
      localCollectionItems: args.collectionFile ? collectionItemsFromFile(args.collectionFile).length : 0,
    },
    supabase,
    summary: {
      records: items.length,
      recordsWithWarnings: items.filter(item => item.warnings.length).length,
      warningCounts,
    },
    items: items.filter(item => item.warnings.length),
  };

  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(args.outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('Catalog lifecycle report written: ' + path.relative(REPO_ROOT, args.outFile));
  console.log('Warnings: ' + report.summary.recordsWithWarnings + ' / ' + report.summary.records);
}

main().catch(error => {
  console.error('report-catalog-lifecycle.js: ' + (error && error.message ? error.message : error));
  process.exit(1);
});
