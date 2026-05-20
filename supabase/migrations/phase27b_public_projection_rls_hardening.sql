-- Phase 27b: Public Projection RLS hardening
--
-- Goal:
--   - Keep private owner data in public.collections.data.
--   - Expose public share views only through public_data / collection_public_projection.
--   - Do not expose owner_token, owner_token_hash or view_token_hash to anon/authenticated.
--   - Keep owner writes protected by the existing x-owner-token proof.
--
-- Application note:
--   The Supabase CLI is not available in this environment, so this file was created
--   manually. Apply it deliberately in the Supabase SQL Editor after review.

alter table public.collections
  add column if not exists public_data jsonb,
  add column if not exists visibility text not null default 'public',
  add column if not exists view_token_hash text,
  add column if not exists owner_token_hash text;

alter table public.collections enable row level security;

-- Backfill only a sanitized public projection. Never copy data wholesale into public_data.
update public.collections c
set public_data = jsonb_build_object(
  'schemaVersion', coalesce(c.data -> 'schemaVersion', '2'::jsonb),
  'm', coalesce((
    select jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'id', item -> 'id',
        'title', item -> 'title',
        'pub', coalesce(item -> 'pub', '""'::jsonb),
        'bands', coalesce(item -> 'bands', '{}'::jsonb),
        'total', item -> 'total',
        'ongoing', item -> 'ongoing',
        'nextDate', item -> 'nextDate',
        'cover', case
          when item ->> 'cover' like 'https://%' then item -> 'cover'
          else '""'::jsonb
        end,
        'bandCovers', coalesce((
          select jsonb_object_agg(cover.key, to_jsonb(cover.value))
          from jsonb_each_text(coalesce(item -> 'bandCovers', '{}'::jsonb)) as cover(key, value)
          where cover.value like 'https://%'
        ), '{}'::jsonb),
        'genres', case
          when jsonb_typeof(item -> 'genres') = 'array' then item -> 'genres'
          else '[]'::jsonb
        end,
        'status', coalesce(item -> 'status', '""'::jsonb)
      ))
    )
    from jsonb_array_elements(coalesce(c.data -> 'm', '[]'::jsonb)) as item
  ), '[]'::jsonb)
)
where c.public_data is null
  and jsonb_typeof(c.data -> 'm') = 'array';

-- Ensure no old broad grants keep private fields readable or writable.
revoke all on table public.collections from anon, authenticated;

-- Public/public-projection reads: safe columns only. No data, owner_token,
-- owner_token_hash or view_token_hash grant is present.
grant select (id, public_data, updated_at, visibility) on public.collections to anon, authenticated;

-- Owner sync writes data + public_data, but remains guarded by RLS and x-owner-token.
grant update (data, public_data, updated_at) on public.collections to anon, authenticated;

-- Keep INSERT/DELETE unavailable to anon/authenticated.
revoke insert, delete on table public.collections from anon, authenticated;

-- Replace legacy broad public SELECT policies with explicit public/owner policies.
drop policy if exists collections_select_anyone on public.collections;
drop policy if exists anon_select_public on public.collections;
drop policy if exists anon_select_public_data_only on public.collections;
drop policy if exists collections_select_public_projection on public.collections;
drop policy if exists collections_select_owner on public.collections;

create policy collections_select_public_projection
  on public.collections
  for select
  to anon, authenticated
  using (visibility = 'public' and public_data is not null);

-- Needed by Postgres RLS for owner UPDATE evaluation and by owner-specific reads via RPC.
-- Column grants still prevent direct anon/authenticated SELECT of private data.
create policy collections_select_owner
  on public.collections
  for select
  to anon, authenticated
  using (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
  );

-- Keep owner update policy idempotent and limited to callers with the owner proof.
drop policy if exists collections_update_anyone on public.collections;
drop policy if exists collections_update_owner on public.collections;

create policy collections_update_owner
  on public.collections
  for update
  to anon, authenticated
  using (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
  )
  with check (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
  );

-- Public projection endpoint for GitHub Pages/static clients.
create or replace view public.collection_public_projection
with (security_invoker = true) as
select id, public_data, updated_at, visibility
from public.collections
where visibility = 'public'
  and public_data is not null;

revoke all on table public.collection_public_projection from anon, authenticated;
grant select on table public.collection_public_projection to anon, authenticated;

-- Owner-only data read. This exposes only data and only when x-owner-token matches.
-- It returns null on missing/invalid proof and never returns token columns.
create or replace function public.get_owner_collection(collection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.data
  from public.collections as c
  where c.id = collection_id
    and c.owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
  limit 1
$$;

revoke all on function public.get_owner_collection(uuid) from public;
grant execute on function public.get_owner_collection(uuid) to anon, authenticated;
