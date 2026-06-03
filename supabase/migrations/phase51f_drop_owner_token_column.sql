-- Phase 51f: the owner_token column is no longer referenced by any policy, view or
-- function (intake RPCs now authorize via auth.uid() — see phase51e). Drop it.
--
-- APPLIED 2026-06-02 to project sssxiqtnkctvyghyrqff via MCP apply_migration
-- (migration name: phase51f_drop_owner_token_column).
alter table public.collections drop column if exists owner_token;
