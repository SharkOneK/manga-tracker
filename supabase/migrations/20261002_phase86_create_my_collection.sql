-- Phase 86 — Self-Service-Erstellung der eigenen Sammlung (Backlog 4.9)
--
-- APPLIED 2026-10-03 to project sssxiqtnkctvyghyrqff via MCP apply_migration
-- (version 20261002235829). Haertungs-Folgemigration siehe
-- 20261003_phase86b_revoke_service_role.sql (version 20261003000238).
-- Nachgemessen 2026-10-03: has_function_privilege anon=false, authenticated=true,
-- service_role=false (nach der Folgemigration). Echter Testaufruf als
-- angemeldeter Nutzer: 'created', zweiter Aufruf 'exists' mit identischer ID,
-- count(*) genau +1. Alle Vorbedingungen unten vorher verifiziert.
--
-- Vorbedingungen und Nachmess-Queries: siehe Apply-Checkliste am Dateiende.
--
-- Warum:
--   public.collections hat kein INSERT-Policy und keinen INSERT-Grant
--   (`revoke insert, delete on table public.collections from anon, authenticated`,
--   phase27b_public_projection_rls_hardening.sql:68). Ein angemeldeter Nutzer
--   ohne eigene Zeile konnte deshalb gar keine Sammlung bekommen — der Button
--   „Eigene Sammlung starten" lief im Client in einen toten Hinweistext.
--   Diese Migration oeffnet genau EINEN kontrollierten Entstehungspfad: eine
--   SECURITY-DEFINER-RPC, die ausschliesslich fuer die eigene auth.uid() genau
--   eine Zeile anlegt.
--
-- Bewusst NICHT Teil dieser Migration:
--   - Ein INSERT-Policy bzw. ein INSERT-Recht auf public.collections. Der INSERT
--     laeuft ausschliesslich unter dem Funktions-Owner (SECURITY DEFINER =>
--     RLS-Bypass als Tabellen-Owner). Genau das ist der Punkt dieser Phase; ein
--     breites Schreibrecht auf die Tabelle waere die weitaus groessere
--     Angriffsflaeche.
--   - Jede Aenderung an public.collection_public_projection (Phase 21b/27b/72)
--     oder an den Spalten-Grants fuer anon/authenticated.
--   - Ein Loeschpfad (delete_my_collection()) — ein zusaetzlicher Loeschpfad auf
--     einer oeffentlich erreichbaren App braucht eine eigene Risikobetrachtung.
--
-- Voraussetzungen, die diese Migration stillschweigend annimmt (vor dem
-- Anwenden pruefen, Queries am Dateiende):
--   - Die anwendende Rolle ist Eigentuemerin von public.collections. Nur dann
--     laeuft der INSERT der Funktion als Tabellen-Owner und ist damit von RLS
--     ausgenommen; bei abweichendem Owner schlaegt der INSERT fehl (ohne
--     `when others`-Handler kommt beim Client HTTP 500 statt eines Result-Codes).
--   - Es gibt heute keine zwei Zeilen mit derselben user_id, sonst scheitert der
--     Unique-Index und die komplette Migration rollt zurueck.
--   - Im Supabase-Auth-Setup ist „Confirm email" aktiv — sonst ist das Konto-Gate
--     unten (Guard 2) wirkungslos.
--
-- Alles hier ist idempotent (`add column if not exists`,
-- `create unique index if not exists`, `create or replace function`,
-- Revokes/Grants) — ein zweites Anwenden ist unschaedlich.

begin;

-- ── 1. created_at als Basis fuer das Rate-Limit ──────────────────────────────
-- Bewusst OHNE jeden Grant (weder select noch update): die Spalte bleibt fuer
-- anon/authenticated unsichtbar und ist nicht Teil der Public Projection.
-- Bestandszeilen erhalten now() als Default — das verfaelscht das Rate-Limit
-- beim allerersten Anwenden um maximal eine Stunde; bei einer Handvoll
-- Bestandszeilen fachlich irrelevant.
alter table public.collections
  add column if not exists created_at timestamptz not null default now();

-- ── 2. DB-seitiger „1 Sammlung pro Nutzer"-Guard ─────────────────────────────
-- Der `not exists`-Vorabcheck in der Funktion allein ist bei zwei parallelen
-- Aufrufen nicht dicht (Doppelklick, Doppel-Request). Der Unique-Index macht die
-- Invariante race-condition-sicher; die Funktion faengt den Konflikt als
-- unique_violation ab und antwortet idempotent mit 'exists'.
--
-- Bewusst reversibel: sollen spaeter Mehrfach-Sammlungen pro Nutzer moeglich
-- sein, ist dieser Index einzeln droppbar (get_my_collection_ids() gibt bereits
-- eine Liste zurueck). Der bestehende Nicht-Unique-Index collections_user_id_idx
-- (phase51_auth_user_migration.sql:34) bleibt unberuehrt.
create unique index if not exists collections_user_id_unique
  on public.collections (user_id);

-- ── 3. Die RPC ───────────────────────────────────────────────────────────────
-- Gibt IMMER ein jsonb-Objekt {"result": <text>, "collection_id": <uuid|null>}
-- zurueck, nie eine Exception an den Client — der Client soll stabile Codes
-- bekommen statt HTTP-Fehlertexte parsen zu muessen.
--   result ∈ created | exists | unauthenticated | not_allowed | rate_limited
--            | capacity_reached | error
-- ('error' nur im Sonderfall des unique_violation-Handlers, s. u. — der Client
--  kennt den Code ohnehin als Sammelfall fuer Netzwerk-/HTTP-Fehler.)
create or replace function public.create_my_collection()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Spam-Deckel bei offener Registrierung. Beide Zaehlungen sind GLOBAL (nicht
  -- pro Nutzer), weil der Missbrauchsvektor „viele frische Accounts" ist und
  -- nicht „ein Account ruft oft auf" (das deckt Guard 3 samt Unique-Index ab).
  -- Sie lesen nur count(*), geben also keine Zeilendaten preis. Anpassung der
  -- Grenzen per Folgemigration.
  max_per_hour constant int := 5;
  max_total    constant int := 50;
  -- Kanonische leere Sammlung — wortgleich zu dem, was buildPublicCollectionData()
  -- im Client fuer eine leere Sammlung liefert (SCHEMA_VERSION = 3, leeres
  -- m-Array). Keine weiteren Felder.
  empty_collection constant jsonb :=
    jsonb_build_object('schemaVersion', 3, 'm', jsonb_build_array());
  caller      uuid := auth.uid();
  existing_id uuid;
  new_id      uuid;
begin
  -- Guard 1: ohne Session kein Schreibpfad. anon kommt hier ohnehin nicht an
  -- (EXECUTE ist entzogen, s. u.) — zweiter Guertel.
  if caller is null then
    return jsonb_build_object('result', 'unauthenticated', 'collection_id', null);
  end if;

  -- Guard 2: Konto-Gate. Nur bestaetigte E-Mail-Adressen duerfen anlegen; das
  -- blockt unbestaetigte Adressen und anonyme Supabase-Sign-ins (die haben keine
  -- bestaetigte E-Mail). Der E-Mail-OTP-Bootstrap bestaetigt die Adresse,
  -- Passkey-Nutzer sind darueber ohnehin schon bestaetigt. Bewusst OHNE die
  -- is_anonymous-Spalte, um keine Versionsabhaengigkeit einzubauen.
  --
  -- WICHTIG — dieses Gate haengt an einer Projekteinstellung: ist „Confirm email"
  -- im Supabase-Auth-Dashboard AUS, setzt Supabase email_confirmed_at direkt bei
  -- der Registrierung, und der Check hier ist ein No-Op. Bei offener Registrierung
  -- ohne Allowlist ist das der Unterschied zwischen „nur erreichbare Adressen"
  -- und „jeder". Vor dem Anwenden pruefen (Apply-Checkliste am Dateiende).
  if not exists (
    select 1
    from auth.users as u
    where u.id = caller
      and u.email_confirmed_at is not null
  ) then
    return jsonb_build_object('result', 'not_allowed', 'collection_id', null);
  end if;

  -- Guard 3: eine Sammlung pro Nutzer. Kein Fehler, sondern idempotente Antwort
  -- mit der bestehenden ID — der Client kann sie direkt verwenden (Fall
  -- „frischer Browser, mtCollId fehlt").
  select c.id into existing_id
  from public.collections as c
  where c.user_id = caller
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('result', 'exists', 'collection_id', existing_id);
  end if;

  -- Guard 4: Rate-Limit (neue Sammlungen pro Stunde, global).
  if (
    select count(*)
    from public.collections as c
    where c.created_at > now() - interval '1 hour'
  ) >= max_per_hour then
    return jsonb_build_object('result', 'rate_limited', 'collection_id', null);
  end if;

  -- Guard 5: Gesamtcap (Zeilen insgesamt, global).
  if (select count(*) from public.collections) >= max_total then
    return jsonb_build_object('result', 'capacity_reached', 'collection_id', null);
  end if;

  begin
    -- id explizit per gen_random_uuid() (seit PG13 in pg_catalog, also auch mit
    -- search_path = '' aufloesbar) — damit ist die RPC unabhaengig davon, ob die
    -- Spalte einen Default traegt. visibility explizit 'public' statt Verlass auf
    -- den Spalten-Default: es gibt (noch) keine Sichtbarkeits-UI, shareProfile()
    -- im Client wuerde mit 'private' ins Leere zeigen.
    insert into public.collections (
      id, user_id, data, public_data, visibility, updated_at, created_at
    )
    values (
      gen_random_uuid(), caller, empty_collection, empty_collection,
      'public', now(), now()
    )
    returning id into new_id;
  exception
    when unique_violation then
      -- Paralleler Doppelklick/Doppel-Request: der Unique-Index auf user_id hat
      -- die zweite Zeile verhindert. Vorhandene ID nachlesen und idempotent als
      -- 'exists' melden, statt den Client mit einem Fehler zu behelligen.
      select c.id into existing_id
      from public.collections as c
      where c.user_id = caller
      limit 1;
      -- Findet der Re-Select keine Zeile (z. B. PK-Kollision auf id oder die
      -- Gegenzeile wurde zwischenzeitlich geloescht), waere 'exists' ohne ID
      -- widerspruechlich: der Client zeigte einen Erfolgs-Toast und direkt
      -- danach einen Fehlerstatus. Dann lieber ehrlich 'error'.
      if existing_id is null then
        return jsonb_build_object('result', 'error', 'collection_id', null);
      end if;
      return jsonb_build_object('result', 'exists', 'collection_id', existing_id);
  end;

  return jsonb_build_object('result', 'created', 'collection_id', new_id);
end;
$$;

-- ── 4. Rechte ────────────────────────────────────────────────────────────────
-- WICHTIG — warum FROM public und nicht nur FROM anon:
-- Postgres vergibt EXECUTE auf neue Funktionen per Default an PUBLIC (in der ACL
-- als fuehrendes "=X/postgres"). anon haelt das Recht also gar nicht direkt,
-- sondern erbt es ueber PUBLIC — ein `revoke execute ... from anon` allein ist
-- wirkungslos. Genau darauf ist Phase 51e hereingefallen (nachgezogen in
-- 20260926_phase81_audit_hardening.sql:39).
revoke execute on function public.create_my_collection() from public, anon;

-- Nur angemeldete Nutzer. Bewusst ohne weitere Rolle (abweichend von Phase 81):
-- die Funktion haengt vollstaendig an auth.uid() und waere fuer eine
-- Server-Rolle ohne Session wirkungslos (auth.uid() ist null -> 'unauthenticated').
-- Analog begruendet in phase51b_get_my_collection_ids.sql:23-26.
grant execute on function public.create_my_collection() to authenticated;

commit;

-- ── Apply-Checkliste ─────────────────────────────────────────────────────────
--
-- VORHER pruefen (sonst faellt es erst beim Anwenden auf):
--
--   1. Keine Duplikate — sonst scheitert der Unique-Index und die komplette
--      Migration rollt mit einer nackten Index-Fehlermeldung zurueck:
--        select user_id, count(*)
--        from public.collections
--        group by 1
--        having count(*) > 1;
--      -> muss leer sein.
--
--   2. Owner-Annahme — der SECURITY-DEFINER-INSERT umgeht RLS nur, wenn der
--      Funktions-Owner auch Eigentuemer der Tabelle ist:
--        select tableowner from pg_tables
--        where schemaname = 'public' and tablename = 'collections';
--        select pg_get_userbyid(proowner) from pg_proc
--        where oid = 'public.create_my_collection()'::regprocedure;
--      -> beide Rollen muessen uebereinstimmen (bzw. der Funktions-Owner muss
--         von RLS auf public.collections ausgenommen sein).
--
--   3. Auth-Einstellungen im Supabase-Dashboard verifizieren:
--      „Confirm email" = ON (sonst ist Guard 2 ein No-Op, weil Supabase
--      email_confirmed_at direkt bei der Registrierung setzt) und
--      „Anonymous sign-ins" = OFF.
--
-- NACHHER nachmessen (nicht auf `success` vertrauen):
--
--   4. select has_function_privilege('anon', 'public.create_my_collection()', 'EXECUTE');
--        -> muss false sein
--      select has_function_privilege('authenticated', 'public.create_my_collection()', 'EXECUTE');
--        -> muss true sein
--      select has_function_privilege('service_role', 'public.create_my_collection()', 'EXECUTE');
--        -> diese Migration vergibt der Rolle nichts; haelt sie das Recht
--           trotzdem (Altvergabe/PUBLIC), ist ein
--           `revoke execute on function public.create_my_collection() from service_role;`
--           per Folgemigration die saubere Reaktion.
--
--   5. Echter Testaufruf als angemeldeter Nutzer (deckt zugleich Punkt 2 und den
--      Fall ab, dass `create unique index if not exists` einen gleichnamigen,
--      nicht-unique Bestandsindex still uebersprungen haette):
--        select count(*) from public.collections;   -- vorher
--        select public.create_my_collection();      -- -> 'created'
--        select public.create_my_collection();      -- -> 'exists', gleiche ID
--        select count(*) from public.collections;   -- genau +1 gegenueber vorher
--
-- ── Ergebnis (2026-10-03) ────────────────────────────────────────────────────
-- Alle 5 Punkte durchlaufen: keine Duplikate, Owner uebereinstimmend (beide
-- `postgres`), Auth-Settings bestaetigt. Nachmessung: anon=false,
-- authenticated=true, service_role zunaechst true (Supabase-Standardvergabe,
-- nicht aus dieser Migration) -> per 20261003_phase86b_revoke_service_role.sql
-- auf false gehaertet. Echter Testaufruf fuer einen realen zweiten Nutzer ohne
-- Sammlung: 'created', dann 'exists' mit identischer ID, count(*) +1.
