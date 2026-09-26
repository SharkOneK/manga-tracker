# supabase/migrations — Stand und bekannte Abweichungen

Dieses Verzeichnis ist **nicht** vollstaendig deckungsgleich mit der angewendeten
Migrationshistorie des Projekts `sssxiqtnkctvyghyrqff`. Das ist bekannt, gewollt
dokumentiert und im Gesamtaudit 2026-09-26 als Befund 15 erfasst.

**Wichtig: Das reale Schema ist korrekt.** Geprueft am 2026-09-26 — `public_data`,
`visibility` und `view_token_hash` existieren, `owner_token` ist gedroppt, die
Public Projection liefert nur oeffentliche Felder. Die Abweichung betrifft
ausschliesslich die Buchfuehrung, nicht den Zustand der Datenbank.

## Angewendet, aber ohne Datei hier

Diese fuenf Migrationen stehen in `supabase_migrations.schema_migrations`, haben
aber keine Entsprechung im Repo. Sie stammen aus der Phase-8-Aera, die spaeter
komplett verworfen wurde (`drop_phase8_and_create_collections`):

| Version | Name |
|---|---|
| 20260513141346 | `phase8_manga_tracker_database` |
| 20260513141421 | `phase8_harden_manga_tracker_grants` |
| 20260513142052 | `phase8_preserve_app_updated_at` |
| 20260513150244 | `phase8_fix_rls_and_function_lints` |
| 20260515205653 | `drop_phase8_and_create_collections` |

Ein Rebuild from scratch allein aus diesem Verzeichnis erzeugt daher **nicht**
bitgenau den heutigen Stand. Wer das braucht, muss die Phase-8-Kette aus der
Supabase-Migrationshistorie nachziehen.

## Datei hier, aber nicht in der Historie

Diese vier Dateien wurden ueber die Supabase-Oberflaeche bzw. ausserhalb der
CLI angewendet und sind deshalb nicht als Version registriert:

| Datei | Inhalt real vorhanden? |
|---|---|
| `phase21_public_projection.sql` | ja — `public_data`, `visibility` |
| `phase21b_public_projection_rls.sql` | ja — Policy `collections_select_public_projection` |
| `20260519233037_phase27a_public_projection_columns.sql` | ja |
| `20260719_phase72_public_projection_mediatype.sql` | ja |

## Regel fuer neue Migrationen

Neue Migrationen bitte ausschliesslich versioniert anlegen
(`YYYYMMDD_phaseNN_kurzbeschreibung.sql`) **und** ueber die CLI bzw. das
Migrations-Tooling anwenden, damit Datei und Historie nicht erneut auseinander
laufen.

## Fallstrick: EXECUTE-Rechte richtig entziehen

Postgres vergibt `EXECUTE` auf neue Funktionen per Default an `PUBLIC`. In der
ACL (`pg_proc.proacl`) steht das als fuehrendes `=X/postgres`. Die Rollen `anon`
und `authenticated` halten das Recht dann gar nicht direkt, sondern erben es
ueber `PUBLIC`.

**Ein `revoke execute ... from anon` ist in diesem Fall wirkungslos** —
`has_function_privilege('anon', ..., 'EXECUTE')` bleibt `true`. Genau darauf ist
Phase 51e bei `submit_manga_catalog_candidate` hereingefallen; die Funktion war
danach weiterhin fuer `anon` aufrufbar (behoben in
`20260926_phase81_audit_hardening.sql`).

Richtig ist:

```sql
revoke execute on function public.beispiel(text) from public, anon;
grant  execute on function public.beispiel(text) to authenticated, service_role;
```

Und danach **immer nachmessen**, nicht auf `success` vertrauen:

```sql
select has_function_privilege('anon', 'public.beispiel(text)', 'EXECUTE');
```
