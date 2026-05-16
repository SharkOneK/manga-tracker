-- Phase 11: Owner-Token-Modell fuer public.collections
--
-- Ziel:
--   - Collection-ID ist kein Schreib-Geheimnis mehr (UUID = oeffentlicher Share-Key).
--   - Schreib-Geheimnis ist ein separates owner_token, das nur der Owner-Browser kennt.
--   - SELECT bleibt oeffentlich, damit ?view=<uuid> Share-Links weiter funktionieren.
--   - UPDATE nur, wenn der Client den passenden HTTP-Header `x-owner-token` mitsendet.
--   - INSERT/DELETE bleiben weiter verboten.
--   - Keine Aenderung an Schema oder Inhalt der Spalte `data`.
--   - Keine bestehenden Rows werden geloescht oder ueberschrieben.

-- 1) Owner-Token-Spalte (UUID v4 per Default).
--    Bestehende Row erhaelt automatisch ein zufaelliges Token aus gen_random_uuid().
alter table public.collections
  add column if not exists owner_token uuid not null default gen_random_uuid();

-- 2) Spaltengranulare Rechte:
--    anon/auth duerfen nur id, data, updated_at lesen, NICHT owner_token.
--    Schreibzugriff geht ausschliesslich auf data.
revoke all on public.collections from anon, authenticated;
grant  select (id, data, updated_at) on public.collections to anon, authenticated;
grant  update (data)                  on public.collections to anon, authenticated;
-- INSERT/DELETE: bewusst nicht granted.

-- 3) Alte unsichere UPDATE-Policy entfernen.
drop policy if exists collections_update_anyone on public.collections;

-- 4) Neue UPDATE-Policy: nur mit passendem x-owner-token Header.
create policy collections_update_owner
  on public.collections
  for update
  to anon, authenticated
  using (
    owner_token::text =
      current_setting('request.headers', true)::json ->> 'x-owner-token'
  )
  with check (
    owner_token::text =
      current_setting('request.headers', true)::json ->> 'x-owner-token'
  );

-- SELECT-Policy bleibt unveraendert: collections_select_anyone (USING true).
-- Es existieren bewusst keine INSERT/DELETE-Policies => Operationen sind verboten.
