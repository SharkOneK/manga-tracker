'use strict';

/**
 * sync-review-queue-to-supabase.js — Phase 39e
 *
 * Liest data/release-source-review-queue.json und ruft fuer jedes Item
 * public.import_pending_queue_candidate per service_role auf.
 * Idempotent: mehrfacher Lauf erzeugt keine Drift.
 *
 * Schreibt data/release-source-review-queue-sync-report.json mit Counts und
 * pro-Item-Resultaten.
 *
 * Filter: nur reviewStatus in {auto-blocked, auto-not-yet-released, needs-source}
 * werden importiert. patched/deferred bleiben in JSON.
 *
 * Aufruf:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/sync-review-queue-to-supabase.js
 *   node scripts/sync-review-queue-to-supabase.js --dry-run
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE  = path.join(REPO_ROOT, 'data', 'release-source-review-queue.json');
const REPORT_FILE = path.join(REPO_ROOT, 'data', 'release-source-review-queue-sync-report.json');

const ELIGIBLE_STATUSES = new Set(['auto-blocked', 'auto-not-yet-released', 'needs-source']);

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error('ENV "' + name + '" fehlt. Phase 39e Sync erfordert SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  }
  return String(v).trim();
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) throw new Error('Queue-Datei nicht gefunden: ' + QUEUE_FILE);
  const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  if (!raw || !Array.isArray(raw.queue)) throw new Error('Queue-Datei hat kein queue[]-Array.');
  return raw.queue;
}

function pickEligible(items) {
  return items.filter((it) => ELIGIBLE_STATUSES.has(String(it.reviewStatus || '')));
}

function buildPayload(item) {
  return {
    p_queue_key:     String(item.queueKey || ''),
    p_series_title:  String(item.seriesTitle || ''),
    p_publisher:     String(item.publisher || ''),
    p_volume_number: Number(item.volumeNumber),
    p_source_url:    typeof item.sourceUrl === 'string' && /^https:\/\//.test(item.sourceUrl) ? item.sourceUrl : null,
    p_source_key:    typeof item.providerId === 'string' && item.providerId ? item.providerId : null,
    p_release_date:  typeof item.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.releaseDate) ? item.releaseDate : null,
    p_metadata:      {
      priority:        item.priority || null,
      classification:  item.classification || null,
      review_status:   item.reviewStatus || null,
      suspected_cause: item.suspectedCause || null,
      evidence:        item.evidence || null,
      source_name:     item.sourceName || null,
    },
  };
}

async function callRpc(supaUrl, serviceKey, payload) {
  const url = supaUrl.replace(/\/+$/, '') + '/rest/v1/rpc/import_pending_queue_candidate';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':        serviceKey,
      'authorization': 'Bearer ' + serviceKey,
      'content-type':  'application/json',
      'accept':        'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new Error('RPC HTTP ' + res.status + ': ' + body.slice(0, 300));
  }
  const result = await res.json();
  return typeof result === 'string' ? result : JSON.stringify(result);
}

async function main() {
  const args = parseArgs(process.argv);
  const supaUrl    = requireEnv('SUPABASE_URL');
  const serviceKey = args.dryRun ? '' : requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const all = loadQueue();
  const eligible = pickEligible(all);

  console.log('Phase 39e Sync: queue=' + all.length + ', eligible=' + eligible.length + (args.dryRun ? ' (DRY-RUN)' : ''));

  const counts = { submitted: 0, updated: 0, already_verified: 0, already_rejected: 0, blocked: 0, error: 0, dry_run: 0 };
  const perItem = [];

  for (const item of eligible) {
    const payload = buildPayload(item);
    if (args.dryRun) {
      counts.dry_run++;
      perItem.push({ queueKey: payload.p_queue_key, result: 'dry_run' });
      continue;
    }
    try {
      const result = await callRpc(supaUrl, serviceKey, payload);
      counts[result] = (counts[result] || 0) + 1;
      perItem.push({ queueKey: payload.p_queue_key, result });
    } catch (e) {
      counts.error++;
      perItem.push({ queueKey: payload.p_queue_key, result: 'error', message: e.message });
      console.error('  ERROR ' + payload.p_queue_key + ': ' + e.message);
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'sync-review-queue-to-supabase.js',
    dryRun: args.dryRun,
    queueTotal: all.length,
    eligibleTotal: eligible.length,
    counts,
    perItem,
  };

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  console.log('Report: ' + REPORT_FILE);
  console.log('Counts: ' + JSON.stringify(counts));

  if (counts.error > 0) process.exit(2);
}

main().catch((err) => {
  console.error('sync-review-queue-to-supabase.js: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
