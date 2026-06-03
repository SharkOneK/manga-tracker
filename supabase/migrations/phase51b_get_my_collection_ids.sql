-- Phase 51b: discover the signed-in user's collection ids by auth.uid().
--
-- APPLIED 2026-06-02 to project sssxiqtnkctvyghyrqff via MCP apply_migration
-- (migration name: phase51b_get_my_collection_ids).
--
-- Why: a fresh browser has a valid Supabase session but no adopt link / owner
-- token in localStorage, so the app does not know which collection to load.
-- This RPC lets the signed-in owner discover the collection(s) bound to their
-- auth.uid(), independent of any local owner token.
create or replace function public.get_my_collection_ids()
returns table(id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.collections as c
  where c.user_id is not null
    and c.user_id = auth.uid()
$$;

revoke all on function public.get_my_collection_ids() from public;
-- Signed-in users only (relies on auth.uid()); revoke the implicit anon default grant.
revoke execute on function public.get_my_collection_ids() from anon;
grant execute on function public.get_my_collection_ids() to authenticated;
