'use strict';

/**
 * report-review-queue-supabase-coverage.js — Phase 39e
 *
 * Read-only Drift-Report zwischen JSON-Queue und Supabase.
 * Schreibt data/release-source-review-queue-coverage.json mit drei Buckets:
 *   - inQueueAndCandidate     (identity match in manga_catalog_candidates)
 *   - inQueueAndVerifiedEntry (bereits in manga_catalog_entries verified=true)
 *   - inQueueOnly             (noch nicht migriert)
 *
 * Bewegt nichts, aendert nichts. Reines Diagnose-Tool.
 *
 * ENV:
 *   SUPABASE_URL                  Pflicht
 *   SUPABASE_SERVICE_ROLE_KEY     Pflicht (candidates sind nicht public-lesbar)
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE    = path.join(REPO_ROOT, 'data', 'release-source-review-queue.json');
const COVERAGE_FILE = path.join(REPO_ROOT, 'data', 'release-source-review-queue-coverage.json');

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error('ENV "' + name + '" fehlt. Phase 39e Coverage erfordert SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  }
  return String(v).trim();
}

// Spiegel der 39b/39e-Normalisierung
function normalizeTitle(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
function normalizePublisher(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s.replace(/[!.,]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function fetchAll(supaUrl, serviceKey, pathRel, selectStr) {
  const out = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const url = supaUrl.replace(/\/+$/, '') + pathRel +
      (pathRel.includes('?') ? '&' : '?') + 'select=' + encodeURIComponent(selectStr);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey':        serviceKey,
        'authorization': 'Bearer ' + serviceKey,
        'accept':        'application/json',
        'range-unit':    'items',
        'range':         from + '-' + (from + pageSize - 1),
      },
    });
    if (res.status !== 200 && res.status !== 206) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' on ' + pathRel + ': ' + body.slice(0, 300));
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('Expected array from ' + pathRel);
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function main() {
  const supaUrl    = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!fs.existsSync(QUEUE_FILE)) throw new Error('Queue-Datei nicht gefunden: ' + QUEUE_FILE);
  const queueRaw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  if (!Array.isArray(queueRaw.queue)) throw new Error('queue[]-Array fehlt');

  const candidates = await fetchAll(supaUrl, serviceKey,
    '/rest/v1/manga_catalog_candidates',
    'normalized_series_title,normalized_publisher,volume_number,status,candidate_key');
  const entries = await fetchAll(supaUrl, serviceKey,
    '/rest/v1/manga_catalog_entries?verified=eq.true',
    'normalized_series_title,normalized_publisher,volume_number');

  const candKey = (t, p, v) => t + '|' + (p || '') + '|' + v;
  const candMap   = new Map(candidates.map((c) => [candKey(c.normalized_series_title, c.normalized_publisher, c.volume_number), c]));
  const verifMap  = new Map(entries.map((e)    => [candKey(e.normalized_series_title, e.normalized_publisher, e.volume_number), e]));

  const inQueueAndVerifiedEntry = [];
  const inQueueAndCandidate     = [];
  const inQueueOnly             = [];

  for (const item of queueRaw.queue) {
    const nt = normalizeTitle(item.seriesTitle);
    const np = normalizePublisher(item.publisher);
    const vol = Number(item.volumeNumber);
    const k = candKey(nt, np, vol);
    const ref = {
      queueKey: item.queueKey, reviewStatus: item.reviewStatus, priority: item.priority,
      normalizedSeriesTitle: nt, normalizedPublisher: np, volumeNumber: vol,
    };
    if (verifMap.has(k))       inQueueAndVerifiedEntry.push(ref);
    else if (candMap.has(k))   inQueueAndCandidate.push({ ...ref, candidateStatus: candMap.get(k).status });
    else                       inQueueOnly.push(ref);
  }

  const coverage = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'report-review-queue-supabase-coverage.js',
    queueTotal:        queueRaw.queue.length,
    candidatesTotal:   candidates.length,
    verifiedEntriesTotal: entries.length,
    counts: {
      inQueueAndVerifiedEntry: inQueueAndVerifiedEntry.length,
      inQueueAndCandidate:     inQueueAndCandidate.length,
      inQueueOnly:             inQueueOnly.length,
    },
    inQueueAndVerifiedEntry,
    inQueueAndCandidate,
    inQueueOnly,
  };

  fs.mkdirSync(path.dirname(COVERAGE_FILE), { recursive: true });
  fs.writeFileSync(COVERAGE_FILE, JSON.stringify(coverage, null, 2) + '\n', 'utf-8');

  console.log('Coverage: ' + COVERAGE_FILE);
  console.log('  queueTotal:              ' + coverage.queueTotal);
  console.log('  candidatesTotal:         ' + coverage.candidatesTotal);
  console.log('  verifiedEntriesTotal:    ' + coverage.verifiedEntriesTotal);
  console.log('  inQueueAndVerifiedEntry: ' + coverage.counts.inQueueAndVerifiedEntry);
  console.log('  inQueueAndCandidate:     ' + coverage.counts.inQueueAndCandidate);
  console.log('  inQueueOnly:             ' + coverage.counts.inQueueOnly);
}

main().catch((err) => {
  console.error('report-review-queue-supabase-coverage.js: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
