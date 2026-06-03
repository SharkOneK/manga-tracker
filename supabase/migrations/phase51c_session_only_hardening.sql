-- Phase 51c (Etappe 7/2b): session-only hardening.
--
-- APPLIED 2026-06-02 to project sssxiqtnkctvyghyrqff via MCP apply_migration
-- (migration name: phase51c_session_only_hardening), after the client became
-- session-only and was verified live.
--
-- Removes the legacy x-owner-token branch from owner RLS so only the Supabase
-- session (auth.uid() = user_id) authorizes owner read/write. Makes user_id NOT
-- NULL and drops the token-based data-read RPC. Public projection untouched.

-- 1) Owner SELECT: auth.uid() only.
drop policy if exists collections_select_owner on public.collections;
create policy collections_select_owner
  on public.collections
  for select
  to authenticated
  using (user_id is not null and user_id = auth.uid());

-- 2) Owner UPDATE: auth.uid() only (using + with check).
drop policy if exists collections_update_owner on public.collections;
create policy collections_update_owner
  on public.collections
  for update
  to authenticated
  using (user_id is not null and user_id = auth.uid())
  with check (user_id is not null and user_id = auth.uid());

-- 3) Enforce ownership at the column level.
alter table public.collections alter column user_id set not null;

-- 4) Remove the token-based owner data-read RPC (no longer used; was the main
--    x-owner-token data-access vector). get_owner_collection_for_user remains.
drop function if exists public.get_owner_collection(uuid);
