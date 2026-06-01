-- Phase 51 (DRAFT — NOT YET APPLIED): Supabase Auth user + passkey enablement
--
-- Scope:
--   Introduce real Supabase Auth users alongside the existing owner-token model,
--   so that passkeys (which require a confirmed, non-anonymous auth user) become
--   possible. This migration is ADDITIVE and keeps the legacy x-owner-token path
--   fully working during a dual-auth transition window. It does NOT remove the
--   token policies — that hardening is a deliberate later step (see plan note),
--   only after the auth.uid() path is verified live.
--
-- Design goals:
--   - Add public.collections.user_id (nullable during transition).
--   - Allow owner reads/writes via EITHER x-owner-token OR auth.uid() = user_id.
--   - Provide a one-shot "claim" RPC that binds an existing token-owned row to the
--     currently signed-in auth user (proves ownership via the owner token header).
--   - Leave the public projection (Phase 27b) completely untouched.
--
-- Application note:
--   The Supabase CLI is not used in this project. Apply this file deliberately in
--   the Supabase SQL Editor AFTER review, and only once the auth/login flow exists.
--   Verify row counts and owner read/write as a signed-in user BEFORE dropping any
--   legacy token policy (separate follow-up migration).

-- ── 1. Additive schema ──────────────────────────────────────────────────────
alter table public.collections
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists collections_user_id_idx
  on public.collections (user_id);

-- authenticated callers need to read/write their own user_id binding.
grant select (id, public_data, updated_at, visibility, user_id) on public.collections to authenticated;
grant update (data, public_data, updated_at, user_id) on public.collections to authenticated;

-- ── 2. Dual-auth RLS (token OR auth.uid()) ──────────────────────────────────
-- Replace the owner SELECT policy so a row is visible either via the legacy
-- owner-token header OR because it already belongs to the signed-in user.
drop policy if exists collections_select_owner on public.collections;
create policy collections_select_owner
  on public.collections
  for select
  to anon, authenticated
  using (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
    or (user_id is not null and user_id = auth.uid())
  );

-- Same for owner UPDATE. with check mirrors using so a caller cannot move a row
-- to a user_id that is not their own and cannot escape the token proof.
drop policy if exists collections_update_owner on public.collections;
create policy collections_update_owner
  on public.collections
  for update
  to anon, authenticated
  using (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
    or (user_id is not null and user_id = auth.uid())
  )
  with check (
    owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
    or (user_id is not null and user_id = auth.uid())
  );

-- ── 3. One-shot owner claim ─────────────────────────────────────────────────
-- Binds a token-owned, not-yet-claimed collection to the signed-in auth user.
-- Proof of ownership = matching x-owner-token header. Idempotent: re-claiming a
-- row already owned by the same user is a no-op success. Refuses to steal a row
-- already claimed by a different user.
--
-- Returns the collection id on success, null when no eligible row matched.
create or replace function public.claim_collection_for_current_user(collection_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
  caller uuid := auth.uid();
begin
  if caller is null then
    return null; -- must be signed in
  end if;

  update public.collections c
    set user_id = caller
  where c.id = collection_id
    and c.owner_token::text =
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-owner-token'
    and (c.user_id is null or c.user_id = caller)
  returning c.id into claimed_id;

  return claimed_id;
end;
$$;

revoke all on function public.claim_collection_for_current_user(uuid) from public;
grant execute on function public.claim_collection_for_current_user(uuid) to authenticated;

-- ── 4. Owner read for signed-in users (no token header) ─────────────────────
-- Mirror of get_owner_collection (Phase 27b) for the auth.uid() path, so a
-- signed-in user can pull private data without sending an owner token.
create or replace function public.get_owner_collection_for_user(collection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.data
  from public.collections as c
  where c.id = collection_id
    and c.user_id is not null
    and c.user_id = auth.uid()
  limit 1
$$;

revoke all on function public.get_owner_collection_for_user(uuid) from public;
grant execute on function public.get_owner_collection_for_user(uuid) to authenticated;

-- ── 5. NOT in this migration (deliberate follow-ups) ────────────────────────
--   - Dropping collections_select_owner / collections_update_owner token branch.
--   - Making user_id NOT NULL.
--   - Removing x-owner-token client paths.
--   Do these only AFTER the claim + auth.uid() path is verified live, with a
--   row-count + sample comparison and a tested rollback, analogous to Phase 27b.
