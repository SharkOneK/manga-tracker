-- Phase 21b: Public Projection RLS-Erweiterung
-- MANUELL anwenden in Supabase Dashboard > SQL Editor
-- Voraussetzungen: phase21_public_projection.sql muss zuerst ausgeführt werden
-- Bitte vor Ausführung prüfen: Spalten public_data, visibility, owner_token_hash existieren

-- Schritt 1: RLS aktivieren (falls noch nicht aktiv)
-- ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

-- Schritt 2: Bestehende anon-SELECT-Policy auf public_data beschränken
-- (Beispiel — an tatsächliche Policy-Namen anpassen)
-- DROP POLICY IF EXISTS "anon_select_public" ON public.collections;
-- CREATE POLICY "anon_select_public_data_only" ON public.collections
--   FOR SELECT TO anon
--   USING (visibility = 'public')
--   WITH CHECK (false);
-- HINWEIS: Mit dieser Policy kann anon nur Zeilen lesen, bei denen visibility='public'.
-- Die Projektion (welche Spalten) wird durch GRANT gesteuert:
-- REVOKE SELECT ON public.collections FROM anon;
-- GRANT SELECT (id, public_data, updated_at) ON public.collections TO anon;

-- Schritt 3: owner_token_hash befüllen (erfordert pgcrypto)
-- Erst prüfen: SELECT extname FROM pg_extension WHERE extname = 'pgcrypto';
-- Falls nicht aktiv: CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- UPDATE public.collections
--   SET owner_token_hash = encode(digest(owner_token::text, 'sha256'), 'hex')
--   WHERE owner_token_hash IS NULL AND owner_token IS NOT NULL;

-- Schritt 4: Owner-Policy auf Hash-Vergleich umstellen (Phase 21c)
-- (Nicht in Phase 21b, da Clients erst auf Hash-Authentifizierung umgestellt werden müssen)

-- Manuelle Checkliste:
-- [ ] pgcrypto Extension aktiv?
-- [ ] visibility-Spalte mit DEFAULT 'public' korrekt?
-- [ ] public_data-Spalte vorhanden?
-- [ ] Bestehende anon-Policies geprüft?
-- [ ] Bestehende owner-Policies unverändert?
-- [ ] Deployment auf Staging getestet vor Production?
