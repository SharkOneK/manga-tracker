-- Phase 39c: Review-System fuer manga_catalog_candidates
-- Reviewer-Tabelle + fuenf RPCs (start/approve/reject/block/mark_duplicate)
-- + service_role-only View manga_catalog_review_queue.
-- Pattern identisch zu Phase 36b / 39b: SECURITY DEFINER + search_path=''
-- + Header-Pflicht (x-reviewer-token). Approve mergt bei Identity-Konflikt.

-- =========================================================================
-- 1. REVIEWERS
-- =========================================================================
create table public.manga_catalog_reviewers (
  id              uuid primary key default gen_random_uuid(),
  reviewer_token  uuid not null unique,
  display_name    text not null,
  enabled         boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.manga_catalog_reviewers is
  'Phase 39c: Reviewer-Identitaeten fuer Katalog-Review-RPCs. Strikt getrennt von public.collections.';

create trigger trg_manga_catalog_reviewers_updated_at
  before update on public.manga_catalog_reviewers
  for each row execute function public.tg_manga_catalog_set_updated_at();

alter table public.manga_catalog_reviewers enable row level security;
revoke all on public.manga_catalog_reviewers from anon, authenticated;
-- keine Policies -> default-deny, nur service_role kann lesen/schreiben.

-- =========================================================================
-- 2. REVIEW QUEUE VIEW (service_role-only durch fehlende Grants)
-- =========================================================================
create or replace view public.manga_catalog_review_queue
with (security_invoker = true) as
select
  c.id,
  c.candidate_key,
  c.status,
  c.origin,
  c.series_title,
  c.publisher,
  c.volume_number,
  c.release_date,
  c.isbn13,
  c.source_url,
  c.cover_url,
  c.confidence,
  c.first_seen_at,
  c.last_seen_at,
  c.seen_count,
  c.reviewed_at,
  c.blocked_reason,
  s.source_key,
  s.display_name      as source_display_name,
  s.trust_level       as source_trust_level,
  extract(epoch from (now() - c.first_seen_at))::bigint as age_seconds
from public.manga_catalog_candidates c
left join public.manga_catalog_sources s on s.id = c.source_id
where c.status in ('pending','reviewing');

comment on view public.manga_catalog_review_queue is
  'Phase 39c: Pending/reviewing Kandidaten mit Source-Trust-Level. Default-deny, service_role-only.';

revoke all on public.manga_catalog_review_queue from anon, authenticated;

-- =========================================================================
-- 3. HELPER: Reviewer-Token-Check
-- =========================================================================
create or replace function public.tg_manga_catalog_resolve_reviewer()
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token text;
  v_uuid  uuid;
  v_id    uuid;
begin
  v_token := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-reviewer-token';
  if v_token is null or length(v_token) < 10 then return null; end if;

  begin
    v_uuid := v_token::uuid;
  exception when others then
    return null;
  end;

  select id into v_id
  from public.manga_catalog_reviewers
  where reviewer_token = v_uuid and enabled = true
  limit 1;

  return v_id;  -- null wenn unbekannt/disabled
end;
$function$;

comment on function public.tg_manga_catalog_resolve_reviewer() is
  'Phase 39c: Liest x-reviewer-token, prueft Existenz in manga_catalog_reviewers, returns id oder null.';

revoke all on function public.tg_manga_catalog_resolve_reviewer() from public, anon, authenticated;

-- =========================================================================
-- 4. RPC: review_candidate_start
-- =========================================================================
create or replace function public.review_candidate_start(
  p_candidate_key text
) returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reviewer_id uuid;
  v_reviewer_hash text;
  v_existing record;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;

  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;

  select id, status into v_existing
  from public.manga_catalog_candidates
  where candidate_key = p_candidate_key
  limit 1;

  if v_existing.id is null then return 'not_found'; end if;
  if v_existing.status <> 'pending' then return 'invalid_status'; end if;

  v_reviewer_hash := md5(v_reviewer_id::text);

  update public.manga_catalog_candidates
     set status = 'reviewing'
   where id = v_existing.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'start-review',
     'manga_catalog_candidates', v_existing.id, 'review-start',
     jsonb_build_object('candidate_key', p_candidate_key, 'prev_status', v_existing.status));

  return 'reviewing';
end;
$function$;

comment on function public.review_candidate_start(text) is
  'Phase 39c: pending -> reviewing. Header x-reviewer-token erforderlich.';

grant execute on function public.review_candidate_start(text) to authenticated;

-- =========================================================================
-- 5. RPC: review_candidate_approve (mit Merge bei Identity-Konflikt)
-- =========================================================================
create or replace function public.review_candidate_approve(
  p_candidate_key text,
  p_confidence    smallint default 80,
  p_reason        text default null
) returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reviewer_id   uuid;
  v_reviewer_hash text;
  v_cand          public.manga_catalog_candidates%rowtype;
  v_confidence    smallint;
  v_existing_id   uuid;
  v_new_entry_id  uuid;
  v_result        text;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;

  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;

  select * into v_cand
  from public.manga_catalog_candidates
  where candidate_key = p_candidate_key
  limit 1;

  if v_cand.id is null then return 'not_found'; end if;
  if v_cand.status not in ('pending','reviewing') then return 'invalid_status'; end if;

  -- Pflichtfelder fuer einen veroeffentlichbaren Entry
  if v_cand.publisher    is null or trim(v_cand.publisher)    = '' then return 'missing_publisher';   end if;
  if v_cand.source_id    is null                                    then return 'missing_source';      end if;
  if v_cand.release_date is null                                    then return 'missing_release_date'; end if;
  if v_cand.volume_number is null                                   then return 'missing_volume';       end if;

  v_confidence := greatest(0, least(100, coalesce(p_confidence, 80)));
  v_reviewer_hash := md5(v_reviewer_id::text);

  -- Identity-Konflikt? -> Merge in bestehenden Entry
  select id into v_existing_id
  from public.manga_catalog_entries
  where normalized_series_title = v_cand.normalized_series_title
    and coalesce(normalized_publisher,'') = coalesce(v_cand.normalized_publisher,'')
    and volume_number = v_cand.volume_number
  limit 1;

  if v_existing_id is not null then
    update public.manga_catalog_entries
       set release_date    = coalesce(release_date,    v_cand.release_date),
           isbn13          = coalesce(isbn13,          v_cand.isbn13),
           cover_url       = coalesce(cover_url,       v_cand.cover_url),
           source_url      = coalesce(source_url,      v_cand.source_url),
           source_id       = coalesce(source_id,       v_cand.source_id),
           source_name     = coalesce(source_name,     v_cand.source_name),
           provider_id     = coalesce(provider_id,     v_cand.provider_id),
           confidence      = greatest(confidence, v_confidence),
           verified        = true,
           verified_at     = coalesce(verified_at, now()),
           verified_by_hash = coalesce(verified_by_hash, v_reviewer_hash),
           metadata        = metadata || coalesce(v_cand.metadata, '{}'::jsonb)
     where id = v_existing_id;

    v_new_entry_id := v_existing_id;
    v_result := 'merged';
  else
    insert into public.manga_catalog_entries (
      source_id,
      series_title, normalized_series_title,
      publisher,    normalized_publisher,
      volume_number, release_date, isbn13, cover_url,
      source_url, source_name, provider_id,
      confidence, verified, verified_at, verified_by_hash, metadata
    ) values (
      v_cand.source_id,
      v_cand.series_title, v_cand.normalized_series_title,
      v_cand.publisher,    v_cand.normalized_publisher,
      v_cand.volume_number, v_cand.release_date, v_cand.isbn13, v_cand.cover_url,
      v_cand.source_url, v_cand.source_name, v_cand.provider_id,
      v_confidence, true, now(), v_reviewer_hash, coalesce(v_cand.metadata, '{}'::jsonb)
    )
    returning id into v_new_entry_id;

    v_result := 'verified';
  end if;

  update public.manga_catalog_candidates
     set status            = 'verified',
         promoted_entry_id = v_new_entry_id,
         reviewed_at       = now(),
         confidence        = greatest(confidence, v_confidence)
   where id = v_cand.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'approve-candidate',
     'manga_catalog_candidates', v_cand.id, coalesce(p_reason, 'review-approve'),
     jsonb_build_object(
       'candidate_key',   p_candidate_key,
       'prev_status',     v_cand.status,
       'confidence',      v_confidence,
       'promoted_entry',  v_new_entry_id,
       'result',          v_result
     )),
    ('reviewer', v_reviewer_hash,
     case when v_result = 'merged' then 'merge-entry' else 'promote-entry' end,
     'manga_catalog_entries', v_new_entry_id, coalesce(p_reason, 'review-approve'),
     jsonb_build_object(
       'candidate_key', p_candidate_key,
       'volume_number', v_cand.volume_number,
       'confidence',    v_confidence
     ));

  return v_result;
end;
$function$;

comment on function public.review_candidate_approve(text, smallint, text) is
  'Phase 39c: candidate -> verified entry. Mergt bei Identity-Konflikt. Header x-reviewer-token erforderlich.';

grant execute on function public.review_candidate_approve(text, smallint, text) to authenticated;

-- =========================================================================
-- 6. RPC: review_candidate_reject
-- =========================================================================
create or replace function public.review_candidate_reject(
  p_candidate_key text,
  p_reason        text
) returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reviewer_id   uuid;
  v_reviewer_hash text;
  v_existing      record;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;

  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;
  if p_reason is null or trim(p_reason) = '' then return 'blocked'; end if;

  select id, status into v_existing
  from public.manga_catalog_candidates
  where candidate_key = p_candidate_key
  limit 1;

  if v_existing.id is null then return 'not_found'; end if;
  if v_existing.status not in ('pending','reviewing') then return 'invalid_status'; end if;

  v_reviewer_hash := md5(v_reviewer_id::text);

  update public.manga_catalog_candidates
     set status         = 'rejected',
         blocked_reason = p_reason,
         reviewed_at    = now()
   where id = v_existing.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'reject-candidate',
     'manga_catalog_candidates', v_existing.id, p_reason,
     jsonb_build_object('candidate_key', p_candidate_key, 'prev_status', v_existing.status));

  return 'rejected';
end;
$function$;

comment on function public.review_candidate_reject(text, text) is
  'Phase 39c: candidate -> rejected. Header x-reviewer-token + Reason erforderlich.';

grant execute on function public.review_candidate_reject(text, text) to authenticated;

-- =========================================================================
-- 7. RPC: review_candidate_block
-- =========================================================================
create or replace function public.review_candidate_block(
  p_candidate_key text,
  p_reason        text
) returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reviewer_id   uuid;
  v_reviewer_hash text;
  v_existing      record;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;

  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;
  if p_reason is null or trim(p_reason) = '' then return 'blocked'; end if;

  select id, status into v_existing
  from public.manga_catalog_candidates
  where candidate_key = p_candidate_key
  limit 1;

  if v_existing.id is null then return 'not_found'; end if;
  if v_existing.status not in ('pending','reviewing') then return 'invalid_status'; end if;

  v_reviewer_hash := md5(v_reviewer_id::text);

  update public.manga_catalog_candidates
     set status         = 'blocked',
         blocked_reason = p_reason,
         reviewed_at    = now()
   where id = v_existing.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'block-candidate',
     'manga_catalog_candidates', v_existing.id, p_reason,
     jsonb_build_object('candidate_key', p_candidate_key, 'prev_status', v_existing.status));

  return 'blocked';
end;
$function$;

comment on function public.review_candidate_block(text, text) is
  'Phase 39c: candidate -> blocked. Re-aktivierbar via Intake (pattern aus 39b).';

grant execute on function public.review_candidate_block(text, text) to authenticated;

-- =========================================================================
-- 8. RPC: review_candidate_mark_duplicate
-- =========================================================================
create or replace function public.review_candidate_mark_duplicate(
  p_candidate_key text,
  p_entry_id      uuid,
  p_reason        text
) returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reviewer_id   uuid;
  v_reviewer_hash text;
  v_existing      record;
  v_entry         record;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;

  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;
  if p_entry_id is null then return 'blocked'; end if;
  if p_reason is null or trim(p_reason) = '' then return 'blocked'; end if;

  select id, status into v_existing
  from public.manga_catalog_candidates
  where candidate_key = p_candidate_key
  limit 1;

  if v_existing.id is null then return 'not_found'; end if;
  if v_existing.status not in ('pending','reviewing') then return 'invalid_status'; end if;

  select id, verified into v_entry
  from public.manga_catalog_entries
  where id = p_entry_id
  limit 1;

  if v_entry.id is null then return 'entry_not_found'; end if;
  if v_entry.verified is not true then return 'target_not_verified'; end if;

  v_reviewer_hash := md5(v_reviewer_id::text);

  update public.manga_catalog_candidates
     set status       = 'duplicate',
         duplicate_of = p_entry_id,
         reviewed_at  = now(),
         blocked_reason = p_reason
   where id = v_existing.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'duplicate-candidate',
     'manga_catalog_candidates', v_existing.id, p_reason,
     jsonb_build_object(
       'candidate_key', p_candidate_key,
       'prev_status',   v_existing.status,
       'duplicate_of',  p_entry_id
     ));

  return 'duplicate';
end;
$function$;

comment on function public.review_candidate_mark_duplicate(text, uuid, text) is
  'Phase 39c: candidate -> duplicate, verlinkt auf existierenden verifizierten Entry.';

grant execute on function public.review_candidate_mark_duplicate(text, uuid, text) to authenticated;
