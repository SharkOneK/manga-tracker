-- Phase 39e: JSON-Review-Queue -> manga_catalog_candidates
-- Service-role-only RPC, spiegelt 39b-Normalisierung. Kein Owner-Token-Check,
-- daher EXECUTE ausschliesslich an service_role. anon/authenticated/PUBLIC bleiben raus.
-- Idempotent: existierende candidate_keys werden geupdated, verifizierte/rejected entries
-- werden uebersprungen. Audit-Log mit actor_role='system'.

create or replace function public.import_pending_queue_candidate(
  p_queue_key     text,
  p_series_title  text,
  p_publisher     text,
  p_volume_number integer,
  p_source_url    text  default null,
  p_source_key    text  default null,
  p_release_date  date  default null,
  p_metadata      jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_candidate_key  text;
  v_norm_title     text;
  v_norm_pub       text;
  v_source_id      uuid := null;
  v_existing_id    uuid;
  v_existing_stat  text;
  v_meta           jsonb;
begin
  -- 1. Input validation -----------------------------------------------------
  if p_queue_key     is null or trim(p_queue_key)     = '' then return 'blocked'; end if;
  if p_series_title  is null or trim(p_series_title)  = '' then return 'blocked'; end if;
  if p_publisher     is null or trim(p_publisher)     = '' then return 'blocked'; end if;
  if p_volume_number is null or p_volume_number < 0       then return 'blocked'; end if;
  if p_source_url is not null and p_source_url !~ '^https://' then return 'blocked'; end if;

  -- 2. Normalisierung (identisch zu Phase 39b) ------------------------------
  v_norm_title := lower(p_series_title);
  v_norm_title := replace(replace(replace(replace(
    v_norm_title, 'ä','ae'), 'ö','oe'), 'ü','ue'), 'ß','ss');
  v_norm_title := regexp_replace(v_norm_title, '[^a-z0-9[:space:]]', ' ', 'g');
  v_norm_title := trim(regexp_replace(v_norm_title, '[[:space:]]+', ' ', 'g'));

  v_norm_pub := lower(p_publisher);
  v_norm_pub := replace(replace(replace(replace(
    v_norm_pub, 'ä','ae'), 'ö','oe'), 'ü','ue'), 'ß','ss');
  v_norm_pub := replace(replace(replace(v_norm_pub, '!',''), '.',''), ',','');
  v_norm_pub := trim(regexp_replace(v_norm_pub, '[[:space:]]+', ' ', 'g'));

  v_candidate_key := v_norm_title || '|' || v_norm_pub || '|' || p_volume_number::text;

  -- 3. Source-Key -> source_id (nur enabled) --------------------------------
  if p_source_key is not null then
    select id into v_source_id
    from public.manga_catalog_sources
    where source_key = p_source_key and enabled = true
    limit 1;
    -- ungueltige source wird tolerant ignoriert (queue-Import laeuft trotzdem)
  end if;

  v_meta := coalesce(p_metadata, '{}'::jsonb)
            || jsonb_build_object(
                 'queue_key',     p_queue_key,
                 'imported_from', 'release-source-review-queue.json'
               );

  -- 4. Bereits in entries verifiziert? --------------------------------------
  if exists(
    select 1 from public.manga_catalog_entries e
    where e.normalized_series_title = v_norm_title
      and coalesce(e.normalized_publisher,'') = v_norm_pub
      and e.volume_number = p_volume_number
      and e.verified = true
  ) then
    return 'already_verified';
  end if;

  -- 5. Upsert in candidates ------------------------------------------------
  select id, status into v_existing_id, v_existing_stat
  from public.manga_catalog_candidates
  where candidate_key = v_candidate_key
  limit 1;

  if v_existing_id is null then
    insert into public.manga_catalog_candidates (
      candidate_key, source_id, origin,
      series_title, normalized_series_title,
      publisher,    normalized_publisher,
      volume_number, release_date, source_url,
      status, submitted_by_hash, metadata,
      first_seen_at, last_seen_at, seen_count
    ) values (
      v_candidate_key, v_source_id, 'pending-queue',
      p_series_title, v_norm_title,
      p_publisher,    v_norm_pub,
      p_volume_number, p_release_date, p_source_url,
      'pending', 'queue-import', v_meta,
      now(), now(), 1
    );

    insert into public.manga_catalog_audit_log
      (actor_role, actor_hash, action, entity_table, reason, diff)
    values
      ('system', 'queue-import', 'import-pending-queue',
       'manga_catalog_candidates', 'phase39e-sync',
       jsonb_build_object(
         'candidate_key', v_candidate_key,
         'queue_key',     p_queue_key,
         'source_key',    p_source_key
       ));

    return 'submitted';
  else
    if v_existing_stat in ('verified','rejected') then
      return 'already_' || v_existing_stat;
    end if;

    update public.manga_catalog_candidates
       set last_seen_at = now(),
           seen_count   = seen_count + 1,
           source_url   = coalesce(source_url,   p_source_url),
           release_date = coalesce(release_date, p_release_date),
           metadata     = metadata || v_meta,
           status       = case when status = 'blocked' then 'pending' else status end
     where id = v_existing_id;

    insert into public.manga_catalog_audit_log
      (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
    values
      ('system', 'queue-import', 'touch-pending-queue',
       'manga_catalog_candidates', v_existing_id, 'phase39e-sync-revisit',
       jsonb_build_object(
         'candidate_key', v_candidate_key,
         'queue_key',     p_queue_key,
         'prev_status',   v_existing_stat
       ));

    return 'updated';
  end if;
end;
$function$;

comment on function public.import_pending_queue_candidate(
  text, text, text, integer, text, text, date, jsonb
) is 'Phase 39e: JSON-Review-Queue -> manga_catalog_candidates. service_role only, idempotent.';

-- Strikt service_role-only: kein PUBLIC/anon/authenticated EXECUTE.
revoke all on function public.import_pending_queue_candidate(
  text, text, text, integer, text, text, date, jsonb
) from public, anon, authenticated;

grant execute on function public.import_pending_queue_candidate(
  text, text, text, integer, text, text, date, jsonb
) to service_role;
