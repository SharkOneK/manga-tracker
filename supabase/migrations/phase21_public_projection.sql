-- Phase 21: Public Projection Migration
-- ACHTUNG: Manuell anwenden nach sorgfältiger Prüfung.
-- Diese Migration ergänzt eine public_data-Spalte und bereitet
-- das Privacy-Modell vor. Nicht automatisch in CI ausführen.

-- Neue Spalten
ALTER TABLE public.collections
  ADD COLUMN IF NOT EXISTS public_data jsonb,
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS view_token_hash text,
  ADD COLUMN IF NOT EXISTS owner_token_hash text;

-- owner_token_hash befüllen (sha256 via pgcrypto)
-- Voraussetzung: pgcrypto Extension muss aktiviert sein
-- UPDATE public.collections
--   SET owner_token_hash = encode(digest(owner_token::text, 'sha256'), 'hex')
--   WHERE owner_token_hash IS NULL;

-- TODO Phase 21b: RLS Policies überarbeiten
-- TODO Phase 21b: SELECT auf private data für anon einschränken
-- TODO Phase 21b: View oder Endpoint für public_data erstellen
