-- Phase 51d (cleanup): remove inert token artifacts left over after the
-- session-only hardening.
--
-- APPLIED 2026-06-02 to project sssxiqtnkctvyghyrqff via MCP apply_migration
-- (migration name: phase51d_cleanup_inert_token_artifacts).
--
--   - claim_collection_for_current_user: token-proof claim RPC; the single
--     collection is already claimed and a session-only browser cannot call it.
--   - owner_token_hash column: referenced by no function, policy or view.
--
-- Kept on purpose (separate later migration if desired): the owner_token column +
-- submit_release_intake_candidate / submit_manga_catalog_candidate still use the
-- x-owner-token header (intake feature), and view_token_hash.
drop function if exists public.claim_collection_for_current_user(uuid);

alter table public.collections drop column if exists owner_token_hash;
