-- Phase 27a: Public Projection Columns
--
-- Ziel:
--   - Sichere Spalten fuer eine getrennte oeffentliche Projektion vorbereiten.
--   - Keine produktiven Daten loeschen oder ueberschreiben.
--   - Keine RLS-/Policy-/Grant-Verschaerfung in dieser Phase.
--
-- Wichtig:
--   Diese Migration ist bewusst idempotent und ergaenzt nur Spalten.
--   Phase 27b muss spaeter public_data backfillen/validieren und erst danach
--   RLS/Grants so verschaerfen, dass anon nicht mehr die private data-Spalte liest.

alter table public.collections
  add column if not exists public_data jsonb,
  add column if not exists visibility text not null default 'public',
  add column if not exists view_token_hash text,
  add column if not exists owner_token_hash text;
