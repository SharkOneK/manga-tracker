'use strict';

/**
 * build-supabase-catalog-snapshot.js — Phase 39d
 *
 * Liest verified entries aus Supabase (public.manga_catalog_entries) und
 * schreibt einen statischen Snapshot in data/release-cache-supabase-snapshot.json.
 *
 * Lauft PARALLEL zur bestehenden release-cache.json-Pipeline und ersetzt diese
 * bewusst NICHT (siehe Phase 39 Note, Scope F: Kompatibilitat erhalten).
 *
 * Aufruf:
 *   SUPABASE_URL=...  SUPABASE_ANON_KEY=...  node scripts/build-supabase-catalog-snapshot.js
 *   node scripts/build-supabase-catalog-snapshot.js --out data/foo.json
 *
 * Required env:
 *   SUPABASE_URL        z.B. https://<project>.supabase.co
 *   SUPABASE_ANON_KEY   Supabase publishable / anon key
 *
 * Exit 0 = OK, Exit 1 = Fehler (HTTP, Schema-Defekt, ENV fehlt).
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_SIZE = 1000;   // PostgREST default Range-Limit
const MAX_ROWS  = 100000; // Sicherheitsdeckel
const PROJECT_REF_FROM_URL = (url) => {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url || ''));
  return m ? m[1] : null;
};

function parseArgs(argv) {
  const out = { outFile: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outFile = path.resolve(argv[++i]);
    }
  }
  return out;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`ENV "${name}" fehlt. Phase 39d erfordert SUPABASE_URL + SUPABASE_ANON_KEY.`);
  }
  return String(value).trim();
}

function mapConfidence(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'low';
  if (n >= 80) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function normalizeIsbn13(raw) {
  if (typeof raw !== 'string') return null;
  // release-cache.json akzeptiert nur exakt 13 Ziffern; Supabase erlaubt 10-13 mit X.
  return /^\d{13}$/.test(raw) ? raw : null;
}

function toReleaseDate(raw) {
  // Supabase liefert release_date als 'YYYY-MM-DD'
  if (typeof raw !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function toIsoChecked(raw) {
  if (typeof raw !== 'string') return null;
  // Supabase liefert verified_at als ISO mit Mikrosekunden + TZ; release-cache erwartet ISO.
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function mapEntry(row) {
  // Kein PostgREST-embed auf manga_catalog_sources: anon hat dort default-deny (Phase 39a).
  // Stattdessen ausschliesslich manga_catalog_entries.source_name; bei null Fallback.
  const sourceDisplay =
    (typeof row.source_name === 'string' && row.source_name.trim()) || 'Supabase Catalog';

  return {
    seriesTitle:           String(row.series_title || '').trim(),
    normalizedSeriesTitle: String(row.normalized_series_title || '').trim(),
    publisher:             String(row.publisher || '').trim(),
    normalizedPublisher:   String(row.normalized_publisher || '').trim(),
    volumeNumber:          Number.isInteger(row.volume_number) ? row.volume_number : Number(row.volume_number),
    releaseDate:           toReleaseDate(row.release_date),
    isbn13:                normalizeIsbn13(row.isbn13),
    coverUrl:              typeof row.cover_url === 'string' && row.cover_url ? row.cover_url : null,
    sourceUrl:             typeof row.source_url === 'string' && row.source_url ? row.source_url : null,
    sourceName:            sourceDisplay,
    confidence:            mapConfidence(row.confidence),
    notes:                 'Phase 39d: Snapshot aus Supabase manga_catalog_entries (verified=true).',
    checkedAt:             toIsoChecked(row.verified_at),
  };
}

function sortEntries(items) {
  return items.slice().sort((a, b) => {
    const ta = a.normalizedSeriesTitle || '';
    const tb = b.normalizedSeriesTitle || '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    const pa = a.normalizedPublisher || '';
    const pb = b.normalizedPublisher || '';
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    return (a.volumeNumber || 0) - (b.volumeNumber || 0);
  });
}

function stableSnapshotPayload(snapshot) {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    supabaseProject: snapshot.supabaseProject,
    itemCount: snapshot.itemCount,
    items: snapshot.items,
  });
}

function preserveGeneratedAtIfUnchanged(outFile, snapshot) {
  if (!fs.existsSync(outFile)) return snapshot;
  try {
    const previous = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    if (
      previous &&
      typeof previous.generatedAt === 'string' &&
      stableSnapshotPayload(previous) === stableSnapshotPayload(snapshot)
    ) {
      return { ...snapshot, generatedAt: previous.generatedAt };
    }
  } catch (_) {
    // Defekte/unerwartete Altdatei nicht kaschieren: neuen Snapshot schreiben.
  }
  return snapshot;
}

async function fetchPage(supaUrl, anonKey, from, to) {
  const url =
    supaUrl.replace(/\/+$/, '') +
    '/rest/v1/manga_catalog_entries' +
    '?select=series_title,normalized_series_title,publisher,normalized_publisher,' +
            'volume_number,release_date,isbn13,cover_url,source_url,source_name,' +
            'confidence,verified,verified_at' +
    '&verified=eq.true' +
    '&order=normalized_series_title.asc,normalized_publisher.asc,volume_number.asc';

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey':        anonKey,
      'authorization': 'Bearer ' + anonKey,
      'accept':        'application/json',
      'accept-profile':'public',
      'range-unit':    'items',
      'range':         from + '-' + to,
      'prefer':        'count=exact',
    },
  });

  if (res.status !== 200 && res.status !== 206) {
    const body = await res.text().catch(() => '');
    throw new Error('Supabase HTTP ' + res.status + ': ' + body.slice(0, 500));
  }

  const contentRange = res.headers.get('content-range') || '';
  const total = (() => {
    const m = /\/(\d+|\*)$/.exec(contentRange);
    if (!m) return null;
    if (m[1] === '*') return null;
    return Number(m[1]);
  })();

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error('Supabase response ist kein Array.');
  }
  return { rows, total };
}

async function fetchAllVerified(supaUrl, anonKey) {
  const all = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { rows, total } = await fetchPage(supaUrl, anonKey, from, to);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (all.length >= MAX_ROWS) {
      throw new Error('Mehr als ' + MAX_ROWS + ' verified entries; Sicherheitsdeckel erreicht.');
    }
    if (total !== null && all.length >= total) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv);
  const supaUrl = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const projectRef = PROJECT_REF_FROM_URL(supaUrl);

  if (!projectRef) {
    throw new Error('SUPABASE_URL hat unerwartetes Format: ' + supaUrl);
  }

  const outFile = args.outFile || path.join(REPO_ROOT, 'data', 'release-cache-supabase-snapshot.json');

  const rawRows = await fetchAllVerified(supaUrl, anonKey);
  const mapped  = rawRows.map(mapEntry);

  // Minimal-Integritaetscheck pro Item (release-cache-Schema duldet kein Mussfeld-leer)
  const bad = mapped.filter((it, idx) => {
    if (!it.seriesTitle || !it.normalizedSeriesTitle) { console.error('skip (no title) idx=' + idx); return true; }
    if (!it.publisher   || !it.normalizedPublisher)   { console.error('skip (no publisher) idx=' + idx); return true; }
    if (!Number.isInteger(it.volumeNumber) || it.volumeNumber < 1) { console.error('skip (bad volume) idx=' + idx); return true; }
    if (!it.releaseDate) { console.error('skip (no releaseDate) idx=' + idx); return true; }
    if (!it.checkedAt)   { console.error('skip (no checkedAt) idx=' + idx); return true; }
    return false;
  });
  const clean = mapped.filter((it) => !bad.includes(it));
  const sorted = sortEntries(clean);

  const snapshot = preserveGeneratedAtIfUnchanged(outFile, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'build-supabase-catalog-snapshot.js',
    supabaseProject: projectRef,
    itemCount: sorted.length,
    items: sorted,
  });

  const json = JSON.stringify(snapshot, null, 2) + '\n';
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json, 'utf-8');

  console.log('Phase 39d Snapshot geschrieben: ' + outFile);
  console.log('  Project: ' + projectRef);
  console.log('  itemCount: ' + sorted.length + ' (rohe verified entries: ' + rawRows.length + ', verworfen: ' + bad.length + ')');
}

main().catch((err) => {
  console.error('build-supabase-catalog-snapshot.js: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
