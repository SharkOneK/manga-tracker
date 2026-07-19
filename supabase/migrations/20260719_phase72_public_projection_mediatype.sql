-- Phase 72: mediaType-Fundament — Public-Projection-Backfill
--
-- Goal:
--   - Optionaler Backfill für Bestandssammlungen, deren Eigentümer seit dem
--     Deploy dieser Phase noch nicht synchronisiert haben: public_data enthält
--     bis zum nächsten pushCloud() sonst weiterhin die alte Projektion ohne
--     mediaType/seasons.
--   - Rein additiv, analog zum Backfill in phase27b_public_projection_rls_hardening.sql.
--   - Keine RLS-/Policy-/Grant-Änderung, keine neue oder geänderte Funktion
--     (create or replace function) — Public/Private-Trennung und das
--     Phase-51-Session-Auth-Modell bleiben unangetastet.
--
-- Application note:
--   The Supabase CLI is not available in this environment, so this file was created
--   manually. Apply it deliberately in the Supabase SQL Editor after review.

update public.collections c
set public_data = jsonb_set(
  jsonb_set(c.public_data, '{schemaVersion}', to_jsonb(3), true),
  '{m}',
  coalesce((
    select jsonb_agg(
      item || jsonb_build_object(
        'mediaType', case
          when item ->> 'mediaType' in ('manga', 'series', 'anime') then item -> 'mediaType'
          else '"manga"'::jsonb
        end,
        'seasons', coalesce((
          select jsonb_object_agg(season.key, to_jsonb(round((season.value)::numeric)::int))
          from jsonb_each_text(coalesce(item -> 'seasons', '{}'::jsonb)) as season(key, value)
          where season.value ~ '^-?\d+(\.\d+)?$'
        ), '{}'::jsonb)
      )
    )
    from jsonb_array_elements(coalesce(c.public_data -> 'm', '[]'::jsonb)) as item
  ), '[]'::jsonb),
  true
)
where c.public_data is not null
  and jsonb_typeof(c.public_data -> 'm') = 'array';
