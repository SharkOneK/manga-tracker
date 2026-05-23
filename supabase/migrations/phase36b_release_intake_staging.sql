-- Phase 36b: Release Intake Staging
-- Created: 2026-05-23
--
-- Adds release_intake_candidates staging table for the secure browser → Supabase → GitHub
-- Action → PR intake pipeline.
--
-- Browser sends only allowlist-sanitized watchlist candidates (series_title, publisher,
-- volume_number, source_url, notes, enabled). No collection data, no private fields.
-- GitHub Action reads pending rows with the SUPABASE_INTAKE_KEY secret (never in browser)
-- and creates a PR against data/release-watchlist.json.
--
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ IMPORTANT: Do NOT apply automatically. Review then apply manually via the   │
-- │ Supabase SQL Editor or CLI after verifying:                                  │
-- │ 1. owner_token column type matches your schema (uuid cast to text in policy) │
-- │ 2. The md5() function is available (built-in to PostgreSQL, no extension)    │
-- │ 3. Normalisation matches src/app.js normalizeReleaseTitle/Publisher           │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ── Table ─────────────────────────────────────────────────────────────────────
create table if not exists public.release_intake_candidates (
  id                uuid        primary key default gen_random_uuid(),

  -- Deduplication key: normalised_title|normalised_publisher|volume_number
  candidate_key     text        not null,

  -- Allowlist fields — the only data the browser may send
  series_title      text        not null,
  publisher         text        not null,
  volume_number     integer     not null check (volume_number >= 1),
  source_url        text,                             -- null or https://
  notes             text,
  enabled           boolean     not null default true,

  -- Internal lifecycle fields
  status            text        not null default 'pending'
                    check (status in ('pending', 'adopted', 'duplicate', 'blocked')),
  submitted_by_hash text,                             -- md5(owner_token) — pseudonymous
  blocked_reason    text,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  seen_count        integer     not null default 1 check (seen_count >= 1),
  adopted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per unique normalised candidate
create unique index if not exists release_intake_candidates_key_idx
  on public.release_intake_candidates (candidate_key);

-- Fast read for GitHub Action (select where status = 'pending')
create index if not exists release_intake_candidates_status_idx
  on public.release_intake_candidates (status);

-- ── RLS: deny direct table access from anon / authenticated ──────────────────
-- Service role bypasses RLS and can SELECT all rows (GitHub Action only).
-- Browser may only interact via the submit_release_intake_candidate RPC below.
alter table public.release_intake_candidates enable row level security;
revoke all on table public.release_intake_candidates from anon, authenticated;

-- ── RPC: submit_release_intake_candidate ─────────────────────────────────────
-- Validates that the caller holds a valid owner token, normalises the candidate
-- key, then inserts or updates the staging row.
--
-- Returns text:
--   'submitted'      — new pending row inserted
--   'updated'        — existing row updated (seen_count++)
--   'already_adopted'— candidate already adopted into watchlist, no change
--   'blocked'        — validation failed; nothing written
--
-- Security definer ensures the function can write to the table even though anon
-- role has no direct INSERT privilege.
create or replace function public.submit_release_intake_candidate(
  p_series_title   text,
  p_publisher      text,
  p_volume_number  integer,
  p_source_url     text    default null,
  p_notes          text    default null,
  p_enabled        boolean default true
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_token     text;
  v_owner_valid     boolean := false;
  v_candidate_key   text;
  v_existing_status text;
  v_norm_title      text;
  v_norm_pub        text;
  v_submitted_hash  text;
begin
  -- ── 1. Input validation ───────────────────────────────────────────────────
  if p_series_title is null or trim(p_series_title) = '' then return 'blocked'; end if;
  if p_publisher    is null or trim(p_publisher)    = '' then return 'blocked'; end if;
  if p_volume_number is null or p_volume_number < 1      then return 'blocked'; end if;
  -- source_url must be null or start with https://
  if p_source_url is not null and p_source_url !~ '^https://' then return 'blocked'; end if;

  -- ── 2. Verify owner token ─────────────────────────────────────────────────
  -- Extracts x-owner-token from PostgREST request headers (same mechanism as
  -- the existing collections_update_owner RLS policy in phase27b migration).
  v_owner_token := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token';
  if v_owner_token is null or length(v_owner_token) < 10 then return 'blocked'; end if;

  -- Token must match an existing collection to prove cloud-owner identity.
  select exists(
    select 1 from public.collections c
    where c.owner_token::text = v_owner_token
    limit 1
  ) into v_owner_valid;
  if not v_owner_valid then return 'blocked'; end if;

  -- ── 3. Normalise key — mirrors src/app.js normalizeReleaseTitle/Publisher ──
  -- Title: lowercase → umlaut digraphs → non-alphanumeric → space → collapse spaces
  v_norm_title := lower(p_series_title);
  v_norm_title := replace(replace(replace(replace(
    v_norm_title, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_norm_title := regexp_replace(v_norm_title, '[^a-z0-9[:space:]]', ' ', 'g');
  v_norm_title := trim(regexp_replace(v_norm_title, '[[:space:]]+', ' ', 'g'));

  -- Publisher: lowercase → umlaut digraphs → strip !., → collapse spaces
  v_norm_pub := lower(p_publisher);
  v_norm_pub := replace(replace(replace(replace(
    v_norm_pub, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_norm_pub := replace(replace(replace(v_norm_pub, '!', ''), '.', ''), ',', '');
  v_norm_pub := trim(regexp_replace(v_norm_pub, '[[:space:]]+', ' ', 'g'));

  v_candidate_key := v_norm_title || '|' || v_norm_pub || '|' || p_volume_number::text;

  -- ── 4. Pseudonymous submitted_by_hash ────────────────────────────────────
  -- md5() is built into PostgreSQL without any extension.
  -- The hash is one-way; the original token cannot be recovered from it.
  v_submitted_hash := md5(v_owner_token);

  -- ── 5. Upsert ─────────────────────────────────────────────────────────────
  select status into v_existing_status
  from public.release_intake_candidates
  where candidate_key = v_candidate_key
  limit 1;

  if v_existing_status = 'adopted' then
    return 'already_adopted';
  end if;

  if v_existing_status is null then
    insert into public.release_intake_candidates (
      candidate_key, series_title, publisher, volume_number,
      source_url, notes, enabled, status, submitted_by_hash,
      first_seen_at, last_seen_at, seen_count
    ) values (
      v_candidate_key, p_series_title, p_publisher, p_volume_number,
      p_source_url, p_notes, coalesce(p_enabled, true), 'pending',
      v_submitted_hash, now(), now(), 1
    );
    return 'submitted';
  else
    -- Re-open blocked/duplicate rows and increment seen_count.
    -- Preserve existing source_url/notes unless not yet set.
    update public.release_intake_candidates
    set
      last_seen_at = now(),
      seen_count   = seen_count + 1,
      updated_at   = now(),
      source_url   = coalesce(source_url, p_source_url),
      notes        = coalesce(notes, p_notes),
      status       = 'pending'
    where candidate_key = v_candidate_key;
    return 'updated';
  end if;
end;
$$;

revoke all on function public.submit_release_intake_candidate(text, text, integer, text, text, boolean) from public;
grant execute on function public.submit_release_intake_candidate(text, text, integer, text, text, boolean) to anon, authenticated;
