-- Phase 39b: Browser-Intake nach manga_catalog_candidates
-- Folgt dem Phase-36b-Pattern (SECURITY DEFINER + search_path='' + owner-token-Pflicht).
-- Schreibt NUR in manga_catalog_candidates + manga_catalog_audit_log, niemals in entries.

create or replace function public.submit_manga_catalog_candidate(
  p_series_title  text,
  p_publisher     text,
  p_volume_number integer,
  p_source_url    text  default null,
  p_source_key    text  default null,
  p_release_date  date  default null,
  p_isbn13        text  default null,
  p_cover_url     text  default null,
  p_origin        text  default 'browser',
  p_metadata      jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_owner_token    text;
  v_owner_valid    boolean := false;
  v_candidate_key  text;
  v_norm_title     text;
  v_norm_pub       text;
  v_submitted_hash text;
  v_source_id      uuid := null;
  v_existing_id    uuid;
  v_existing_stat  text;
begin
  -- 1. Input validation -----------------------------------------------------
  if p_series_title  is null or trim(p_series_title)  = '' then return 'blocked'; end if;
  if p_publisher     is null or trim(p_publisher)     = '' then return 'blocked'; end if;
  if p_volume_number is null or p_volume_number < 0       then return 'blocked'; end if;
  if p_source_url is not null and p_source_url !~ '^https://' then return 'blocked'; end if;
  if p_cover_url  is not null and p_cover_url  !~ '^https://' then return 'blocked'; end if;
  if p_isbn13     is not null and p_isbn13     !~ '^[0-9Xx]{10,13}$' then return 'blocked'; end if;
  if p_origin not in ('browser','pending-queue','coverage-gap','watchlist','provider','manual','intake')
    then return 'blocked'; end if;

  -- 2. Owner-token check (identisch zu Phase 36b) ---------------------------
  v_owner_token := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token';
  if v_owner_token is null or length(v_owner_token) < 10 then return 'blocked'; end if;

  select exists(
    select 1 from public.collections c
    where c.owner_token::text = v_owner_token
    limit 1
  ) into v_owner_valid;
  if not v_owner_valid then return 'blocked'; end if;

  -- 3. Normalisierung (spiegelt src/app.js normalizeReleaseTitle/Publisher) -
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

  -- 4. Source-Key -> source_id (nur freigegebene Quellen) ------------------
  if p_source_key is not null then
    select id into v_source_id
    from public.manga_catalog_sources
    where source_key = p_source_key and enabled = true
    limit 1;
    if v_source_id is null then return 'blocked'; end if;
  end if;

  v_submitted_hash := md5(v_owner_token);

  -- 5. Bereits in entries verifiziert? ------------------------------------
  if exists(
    select 1 from public.manga_catalog_entries e
    where e.normalized_series_title = v_norm_title
      and coalesce(e.normalized_publisher,'') = v_norm_pub
      and e.volume_number = p_volume_number
      and e.verified = true
  ) then
    return 'already_verified';
  end if;

  -- 6. Upsert in candidates ------------------------------------------------
  select id, status into v_existing_id, v_existing_stat
  from public.manga_catalog_candidates
  where candidate_key = v_candidate_key
  limit 1;

  if v_existing_id is null then
    insert into public.manga_catalog_candidates (
      candidate_key, source_id, origin,
      series_title, normalized_series_title,
      publisher,    normalized_publisher,
      volume_number, release_date, isbn13, cover_url, source_url,
      status, submitted_by_hash, metadata,
      first_seen_at, last_seen_at, seen_count
    ) values (
      v_candidate_key, v_source_id, p_origin,
      p_series_title, v_norm_title,
      p_publisher,    v_norm_pub,
      p_volume_number, p_release_date, p_isbn13, p_cover_url, p_source_url,
      'pending', v_submitted_hash, coalesce(p_metadata, '{}'::jsonb),
      now(), now(), 1
    );

    insert into public.manga_catalog_audit_log
      (actor_role, actor_hash, action, entity_table, reason, diff)
    values
      ('intake', v_submitted_hash, 'create-candidate',
       'manga_catalog_candidates', 'browser-intake',
       jsonb_build_object(
         'candidate_key', v_candidate_key,
         'origin',        p_origin,
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
           cover_url    = coalesce(cover_url,    p_cover_url),
           release_date = coalesce(release_date, p_release_date),
           isbn13       = coalesce(isbn13,       p_isbn13),
           status       = case when status = 'blocked' then 'pending' else status end
     where id = v_existing_id;

    insert into public.manga_catalog_audit_log
      (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
    values
      ('intake', v_submitted_hash, 'touch-candidate',
       'manga_catalog_candidates', v_existing_id, 'browser-intake-revisit',
       jsonb_build_object(
         'candidate_key', v_candidate_key,
         'prev_status',   v_existing_stat
       ));

    return 'updated';
  end if;
end;
$function$;

comment on function public.submit_manga_catalog_candidate(
  text, text, integer, text, text, date, text, text, text, jsonb
) is 'Phase 39b: Browser-Intake -> manga_catalog_candidates. Schreibt nur Kandidaten, niemals entries. Owner-Token-Pflicht via x-owner-token.';

-- Execute-Rechte: identisch zu Phase 36b (anon+authenticated duerfen aufrufen;
-- Owner-Token-Check innerhalb der Funktion ist die eigentliche Autorisierung).
grant execute on function public.submit_manga_catalog_candidate(
  text, text, integer, text, text, date, text, text, text, jsonb
) to anon, authenticated;
