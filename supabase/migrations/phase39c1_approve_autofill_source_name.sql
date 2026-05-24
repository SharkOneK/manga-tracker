-- Phase 39c.1: review_candidate_approve fuellt source_name automatisch
-- aus manga_catalog_sources.display_name, wenn der Reviewer source_id gesetzt
-- aber source_name leer gelassen hat. Verhindert leere sourceName-Felder im
-- 39d-Snapshot, ohne den Reviewer-Workflow zu aendern.
--
-- Aenderung vs. Phase 39c:
--   - neue Zeile in INSERT/UPDATE: coalesce(source_name, manga_catalog_sources.display_name)
--   - Rest unveraendert: Signatur, Returns, Audit-Entries, Merge-Verhalten.

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
  v_reviewer_id    uuid;
  v_reviewer_hash  text;
  v_cand           public.manga_catalog_candidates%rowtype;
  v_confidence     smallint;
  v_existing_id    uuid;
  v_new_entry_id   uuid;
  v_result         text;
  v_source_display text;
  v_effective_name text;
begin
  v_reviewer_id := public.tg_manga_catalog_resolve_reviewer();
  if v_reviewer_id is null then return 'blocked'; end if;
  if p_candidate_key is null or trim(p_candidate_key) = '' then return 'blocked'; end if;

  select * into v_cand from public.manga_catalog_candidates
   where candidate_key = p_candidate_key limit 1;
  if v_cand.id is null then return 'not_found'; end if;
  if v_cand.status not in ('pending','reviewing') then return 'invalid_status'; end if;

  if v_cand.publisher    is null or trim(v_cand.publisher) = '' then return 'missing_publisher'; end if;
  if v_cand.source_id    is null                                   then return 'missing_source';    end if;
  if v_cand.release_date is null                                   then return 'missing_release_date'; end if;
  if v_cand.volume_number is null                                  then return 'missing_volume';    end if;

  v_confidence := greatest(0, least(100, coalesce(p_confidence, 80)));
  v_reviewer_hash := md5(v_reviewer_id::text);

  -- Phase 39c.1: source_name aus Source-Tabelle ziehen, wenn am Candidate leer.
  select display_name into v_source_display
    from public.manga_catalog_sources where id = v_cand.source_id;
  v_effective_name := coalesce(nullif(trim(coalesce(v_cand.source_name,'')), ''), v_source_display);

  -- Identity-Konflikt? -> Merge
  select id into v_existing_id from public.manga_catalog_entries
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
           source_name     = coalesce(source_name,     v_effective_name),
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
      source_id, series_title, normalized_series_title, publisher, normalized_publisher,
      volume_number, release_date, isbn13, cover_url, source_url, source_name, provider_id,
      confidence, verified, verified_at, verified_by_hash, metadata
    ) values (
      v_cand.source_id, v_cand.series_title, v_cand.normalized_series_title,
      v_cand.publisher, v_cand.normalized_publisher,
      v_cand.volume_number, v_cand.release_date, v_cand.isbn13, v_cand.cover_url,
      v_cand.source_url, v_effective_name, v_cand.provider_id,
      v_confidence, true, now(), v_reviewer_hash, coalesce(v_cand.metadata, '{}'::jsonb)
    ) returning id into v_new_entry_id;
    v_result := 'verified';
  end if;

  update public.manga_catalog_candidates
     set status = 'verified', promoted_entry_id = v_new_entry_id,
         reviewed_at = now(), confidence = greatest(confidence, v_confidence)
   where id = v_cand.id;

  insert into public.manga_catalog_audit_log
    (actor_role, actor_hash, action, entity_table, entity_id, reason, diff)
  values
    ('reviewer', v_reviewer_hash, 'approve-candidate',
     'manga_catalog_candidates', v_cand.id, coalesce(p_reason, 'review-approve'),
     jsonb_build_object('candidate_key', p_candidate_key, 'prev_status', v_cand.status,
       'confidence', v_confidence, 'promoted_entry', v_new_entry_id, 'result', v_result,
       'effective_source_name', v_effective_name)),
    ('reviewer', v_reviewer_hash,
     case when v_result = 'merged' then 'merge-entry' else 'promote-entry' end,
     'manga_catalog_entries', v_new_entry_id, coalesce(p_reason, 'review-approve'),
     jsonb_build_object('candidate_key', p_candidate_key, 'volume_number', v_cand.volume_number,
       'confidence', v_confidence));

  return v_result;
end;
$function$;

comment on function public.review_candidate_approve(text, smallint, text) is
  'Phase 39c.1: approve mit auto-source_name aus manga_catalog_sources.display_name. Header x-reviewer-token erforderlich.';

grant execute on function public.review_candidate_approve(text, smallint, text) to authenticated;
