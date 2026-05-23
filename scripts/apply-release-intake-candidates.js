#!/usr/bin/env node
'use strict';

/**
 * apply-release-intake-candidates.js — Phase 36b
 *
 * Reads pending release intake candidates from Supabase staging and merges
 * any new, valid entries into data/release-watchlist.json.
 *
 * After processing each candidate the script updates its status in Supabase:
 *   'adopted'   — added to the watchlist
 *   'duplicate' — already present in watchlist (no change)
 *   'blocked'   — failed hard validation (never written)
 *
 * Required env vars (provided as GitHub Secrets in CI):
 *   SUPABASE_URL               — e.g. https://xxx.supabase.co
 *   SUPABASE_INTAKE_KEY        — a Supabase key with SELECT/UPDATE on
 *                                release_intake_candidates (service role in CI)
 *
 * Dry-run mode:
 *   When either env var is missing the script exits 0 without fetching or
 *   writing anything. This allows local syntax checks to pass cleanly.
 *
 * Exit codes:
 *   0 — success (or dry-run / no-op)
 *   1 — hard validation failure or file write error
 *
 * Usage:
 *   node scripts/apply-release-intake-candidates.js
 */

const fs   = require('fs');
const path = require('path');

const repoRoot      = path.resolve(__dirname, '..');
const watchlistPath = path.join(repoRoot, 'data', 'release-watchlist.json');

// ── Env / Dry-run ─────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL        || '';
const SUPABASE_INTAKE_KEY = process.env.SUPABASE_INTAKE_KEY || '';

const DRY_RUN = !SUPABASE_URL || !SUPABASE_INTAKE_KEY;

if (DRY_RUN) {
  console.log('[apply-release-intake] Dry-run mode: SUPABASE_URL or SUPABASE_INTAKE_KEY not set.');
  console.log('[apply-release-intake] No Supabase requests will be made. Exit 0.');
  process.exit(0);
}

// ── Hard-blocked field names — must never appear in a staging row ─────────────
const PRIVATE_FIELDS_BLOCKED = new Set([
  'bands', 'owned', 'readStatus', 'collectionStatus', 'startedAt', 'finishedAt',
  'boughtAt', 'readAt', 'isbn13', 'mpEditionId', 'owner_token', 'view_token',
  'collection_id', 'supabase', 'privateNotes', 'data',
]);

// ── Allowlist for intake row fields from Supabase ─────────────────────────────
// Only these fields are read from the staging table.
const INTAKE_ROW_ALLOWED_FIELDS = new Set([
  'id', 'candidate_key', 'series_title', 'publisher', 'volume_number',
  'source_url', 'notes', 'enabled', 'status',
  'first_seen_at', 'last_seen_at', 'seen_count',
]);

// ── Dummy / test title detection (mirrors app.js isPendingCoverageDummyTitle) ──
function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublisher(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDummyTitle(title) {
  const norm = normalizeTitle(title || '');
  return /^zzz(?:\s|-|_)*test/.test(norm) || /\btest(?:\s|-|_)*serie\b/.test(norm);
}

function intakeDedupKey(seriesTitle, publisher, volumeNumber) {
  return normalizeTitle(seriesTitle) + '|' + normalizePublisher(publisher) + '|' + Number(volumeNumber);
}

// ── Validation: checks a single staging row is safe to process ────────────────
function validateIntakeRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not-an-object' };

  // Private field leak check — hard block
  for (const field of PRIVATE_FIELDS_BLOCKED) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      return { ok: false, reason: `private-field:${field}` };
    }
  }

  const seriesTitle  = String(row.series_title  || '').trim();
  const publisher    = String(row.publisher     || '').trim();
  const volumeNumber = Number(row.volume_number);

  if (!seriesTitle)                                return { ok: false, reason: 'empty-series-title' };
  if (!publisher)                                  return { ok: false, reason: 'empty-publisher' };
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return { ok: false, reason: 'invalid-volume-number' };
  if (isDummyTitle(seriesTitle))                   return { ok: false, reason: 'dummy-title' };

  // source_url must be null/absent or start with https://
  if (row.source_url !== null && row.source_url !== undefined) {
    if (typeof row.source_url !== 'string' || !row.source_url.startsWith('https://')) {
      return { ok: false, reason: 'invalid-source-url' };
    }
  }

  return { ok: true };
}

// ── Watchlist helpers ─────────────────────────────────────────────────────────
function readWatchlist() {
  if (!fs.existsSync(watchlistPath)) {
    throw new Error(`data/release-watchlist.json not found at: ${watchlistPath}`);
  }
  const raw = fs.readFileSync(watchlistPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error('data/release-watchlist.json has unexpected structure');
  }
  return parsed;
}

function buildWatchlistKeySet(watchlist) {
  const keys = new Set();
  for (const item of watchlist.items) {
    const vols = Array.isArray(item.volumeNumbers)
      ? item.volumeNumbers
      : (item.volumeNumber !== undefined ? [item.volumeNumber] : []);
    for (const vol of vols) {
      keys.add(intakeDedupKey(item.seriesTitle, item.publisher, vol));
    }
  }
  return keys;
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
function supabaseHeaders() {
  return {
    'apikey':        SUPABASE_INTAKE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_INTAKE_KEY,
    'Content-Type':  'application/json',
  };
}

async function fetchPendingCandidates() {
  const url = SUPABASE_URL + '/rest/v1/release_intake_candidates'
    + '?status=eq.pending&select='
    + Array.from(INTAKE_ROW_ALLOWED_FIELDS).join(',')
    + '&order=first_seen_at.asc';
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase fetch failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function updateCandidateStatus(id, status, extra = {}) {
  const url = SUPABASE_URL + '/rest/v1/release_intake_candidates?id=eq.' + encodeURIComponent(id);
  const body = Object.assign({ status, updated_at: new Date().toISOString() }, extra);
  const res = await fetch(url, {
    method:  'PATCH',
    headers: Object.assign({}, supabaseHeaders(), { 'Prefer': 'return=minimal' }),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`  ⚠ PATCH status failed for id ${id}: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n[apply-release-intake] Phase 36b — Release Intake Candidates\n');

  // ── 1. Read existing watchlist ──────────────────────────────────────────────
  let watchlist;
  try {
    watchlist = readWatchlist();
  } catch (e) {
    console.error('  ✗ ' + e.message);
    process.exit(1);
  }
  console.log(`  ✓ Watchlist read: ${watchlist.items.length} existing item(s)`);
  const watchlistKeys = buildWatchlistKeySet(watchlist);

  // ── 2. Fetch pending candidates from Supabase staging ──────────────────────
  let pending;
  try {
    pending = await fetchPendingCandidates();
  } catch (e) {
    console.error('  ✗ Supabase fetch error: ' + e.message);
    process.exit(1);
  }
  console.log(`  ✓ Supabase: ${pending.length} pending candidate(s) found`);

  if (!pending.length) {
    console.log('\n  ℹ No pending candidates — watchlist unchanged. Exit 0.\n');
    process.exit(0);
  }

  // ── 3. Process each candidate ───────────────────────────────────────────────
  let adopted   = 0;
  let duplicate = 0;
  let blocked   = 0;

  for (const row of pending) {
    const rowId = row.id || '(no-id)';

    // Validate
    const check = validateIntakeRow(row);
    if (!check.ok) {
      console.log(`  ✗ Blocked [${rowId}]: ${check.reason}`);
      await updateCandidateStatus(rowId, 'blocked', { blocked_reason: check.reason });
      blocked++;
      continue;
    }

    const seriesTitle  = String(row.series_title).trim();
    const publisher    = String(row.publisher).trim();
    const volumeNumber = Number(row.volume_number);
    const dedup        = intakeDedupKey(seriesTitle, publisher, volumeNumber);

    // Deduplicate
    if (watchlistKeys.has(dedup)) {
      console.log(`  ~ Duplicate [${rowId}]: ${seriesTitle} Bd.${volumeNumber} (${publisher})`);
      await updateCandidateStatus(rowId, 'duplicate');
      duplicate++;
      continue;
    }

    // Adopt: build a minimal watchlist entry from allowlist fields only
    const newEntry = {
      seriesTitle,
      publisher,
      volumeNumber,
      sourceUrl: (typeof row.source_url === 'string' && row.source_url.startsWith('https://'))
        ? row.source_url : null,
      notes: (typeof row.notes === 'string' && row.notes.trim())
        ? row.notes.trim().slice(0, 500) : 'Aus Release-Intake-Staging übernommen.',
      enabled: row.enabled !== false,
    };

    watchlist.items.push(newEntry);
    watchlistKeys.add(dedup);
    console.log(`  + Adopted  [${rowId}]: ${seriesTitle} Bd.${volumeNumber} (${publisher})`);
    await updateCandidateStatus(rowId, 'adopted', { adopted_at: new Date().toISOString() });
    adopted++;
  }

  // ── 5. Write updated watchlist if anything was adopted ─────────────────────
  if (adopted === 0) {
    console.log(`\n  ℹ No new entries to adopt (${duplicate} duplicate(s), ${blocked} blocked). Exit 0.\n`);
    process.exit(0);
  }

  watchlist.generatedAt = new Date().toISOString();
  const output = JSON.stringify(watchlist, null, 2) + '\n';
  fs.writeFileSync(watchlistPath, output, 'utf-8');

  console.log(`\n  ✓ data/release-watchlist.json updated:`);
  console.log(`      adopted:   ${adopted}`);
  console.log(`      duplicate: ${duplicate}`);
  console.log(`      blocked:   ${blocked}`);
  console.log('');
}

main().catch(e => {
  console.error('\n[apply-release-intake] Unexpected error:', e.message || e);
  process.exit(1);
});
