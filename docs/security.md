# Sicherheitshinweise — Manga Tracker

## Zweck und Geltungsbereich

Diese Datei beschreibt den Ist-Stand der Sicherheitsarchitektur des Manga Trackers:
Auth-Modell, Datenzugriff (RLS/Public Projection), RPC-Rechte, Client-Härtung (CSP/SRI),
PWA/Service-Worker-Verhalten, den Umgang mit Secrets sowie die automatischen Guards, die
Regressionen verhindern. Sie richtet sich an Maintainer und an Reviewer künftiger Phasen.

Frühere Fassungen dieser Datei beschrieben ein Owner-Token-Modell (Schreibgeheimnis im
Browser-localStorage). Dieses Modell ist seit Phase 51 als Autorisierungsmechanismus
serverseitig abgeschafft (gedroppt); Phase 84 hat zusätzlich die letzten Client-Reste
entfernt und einen davon abhängigen Import-Sync-Bug behoben — siehe „Auth-Modell". Jede
Aussage in dieser Datei ist gegen den Code-/Migrationsstand von Phase 84 verifiziert; wo
Unsicherheit bestand, wurde die Aussage weggelassen statt geraten.

## Auth-Modell

Seit Phase 51 ist der **aktive Schreib-/Lesepfad session-only**; ein `x-owner-token` wird
nicht mehr gesendet. Seit Phase 84 ist der Client zusätzlich **vollständig token-frei**: Es
gibt weder eine URL-Adopt-Funktion, die ein Token in `localStorage` schreibt, noch einen
Header, der eines mitsendet — siehe Ist-Stand unten.

- **Passkey (WebAuthn)** ist der primäre Anmeldeweg — `signInWithPasskey()`
  (`src/auth.js:127`) bzw. `registerPasskey()` (`src/auth.js:131`). Die RP-ID wird nicht im
  Client-Code konfiguriert; die Passkey-Behandlung liegt vollständig in supabase-js und
  ergibt sich aus dem ausliefernden Origin (`https://sharkonek.github.io/manga-tracker/`,
  `.github/workflows/live-smoke.yml:9`).
- **E-Mail-OTP** dient als Bootstrap/Fallback — `startEmailOtp()` (`src/auth.js:119`) bzw.
  `verifyEmailOtp()` (`src/auth.js:123`), z. B. für die Erstregistrierung eines Passkeys.
- Autorisierung auf Datenbankebene läuft ausschließlich über `auth.uid()` (siehe
  „Datenmodell und RLS"), nicht über einen mitgesendeten Token-Header.
- Der Client hält die Session im `localStorage` und holt vor jedem privilegierten Request
  ein frisches Access-Token über `ensureFreshAccessToken()` (`src/supabase.js:126`), das bei
  Bedarf per Refresh-Token erneuert wird. Aufrufer sind u. a. `fetchCollection()`
  (`src/supabase.js:183`), `submitReleaseIntakeCandidate()` (`src/supabase.js:220`),
  `submitMangaCatalogCandidate()` (`src/supabase.js:294`) und `patchCollection()`
  (`src/supabase.js:371`). Liefert die Funktion `null`, gilt der Nutzer als nicht
  angemeldet — es gibt keinen automatischen Token-Fallback mehr.

**Ist-Stand (Phase 84)**: Der aktive Schreibpfad ist wie oben beschrieben session-only, ohne
Token-Fallback — `patchCollection()` (`src/supabase.js:371`) hängt ausschließlich an
`ensureFreshAccessToken()` und wirft ohne gültiges Session-Token. Bis Phase 83 lagen im
Client-Code zusätzlich inerte Reste des früheren Owner-Token-Modells (Adopt-Funktion,
Token-Header, Wrapper-Variablen); Phase 84 hat sie entfernt, statt sie ersatzlos stehen zu
lassen (Audit-Befund 22):

- `clearLegacyOwnerToken()` (`src/supabase.js:22-42`) räumt bei jedem Seitenaufruf — Aufruf
  `SupabaseAdapter.clearLegacyOwnerToken()` in `src/app.js:15` — den alten
  Schreibgeheimnis-Schlüssel `mtOwnerToken` aus `localStorage` auf Bestandsgeräten auf,
  reiner Migrationsschritt, kein aktiver Autorisierungspfad. Ein
  noch aufgerufener Legacy-Adopt-Link (Fragment-Form `#adopt=…&token=…` oder die deprecated
  Query-Parameter-Variante mit denselben zwei Parametern) wird aus der URL entfernt, **ohne**
  die Parameter zu speichern.
- `mtCollId` bleibt davon unberührt: Das ist kein Token-Rest, sondern der Cache der eigenen
  Collection-ID, gelesen über `getStoredCollectionId()` (`src/supabase.js:44-48`). Für
  angemeldete Owner wird er über `fetchMyCollectionIds()`/`discoverAndLoadOwnCollection()`
  gesetzt, nicht mehr über einen Adopt-Link.
- `anonHeaders()` (`src/supabase.js:50-55`) ersetzt die frühere `headers(ownerToken, write)` —
  es gibt keinen `x-owner-token`-Zweig mehr, nur noch `apikey` + `Authorization` mit dem
  publishable Key (einziger Aufrufer: `fetchPublicCollection()`, `src/supabase.js:195`).

Diese Bereinigung war nicht nur kosmetisch: Der alte Import-Sync-Gate in `handleImportFile()`
(`src/app.js:2224`) prüfte `if (_collId && _ownerToken)` — für reine Session-Nutzer
(Passkey/E-Mail-OTP, kein Adopt-Link) war `_ownerToken` immer `null`, wodurch der Cloud-Sync
nach einem Import **still übersprungen** wurde, obwohl der Erfolgs-Toast erschien (stiller
Datenverlust, Audit-Befund 22). Seit Phase 84 entscheidet die reine Funktion
`importSyncDecision(mode, collId)` (`src/app.js:2284`, aufgerufen mit `getAppMode()` und
`_collId`) dreiwertig: `'sync'` löst `pushCloud()` aus, `'no-collection'` zeigt einen
Hinweis-Toast statt stillem Skip, `'skip'` verhindert jeden Schreibversuch außerhalb von
`cloud-owner-edit`. `canWriteCloud()` bleibt am Aufrufort zusätzlich als zweiter Gürtel stehen.

## Datenmodell und RLS

`public.collections` trägt pro Zeile eine private `data`-Spalte (vollständiger
Sammlungsstand, nur für den Owner lesbar) sowie `public_data`, `visibility` und
`view_token_hash`.

Owner-Zugriff läuft über zwei Policies, `collections_select_owner` und
`collections_update_owner`, beide `to authenticated` und geprüft gegen `user_id = auth.uid()`
(eingeführt in Phase 51c, nachdem der `x-owner-token`-Zweig entfernt wurde). Phase 81 hat
beide Policies rein nicht-funktional umgestellt: `auth.uid()` wird jetzt als
`(select auth.uid())` ausgewertet, also einmal pro Query als InitPlan statt pro Zeile
(`supabase/migrations/20260926_phase81_audit_hardening.sql:72-77`, Behebung von Supabase-Lint
`0003_auth_rls_initplan`). Die Prädikatslogik selbst ist unverändert geblieben.

`view_token_hash` ist **bewusst belassen** — er gehört zum Sharing-Pfad und wird, anders als
der frühere `owner_token`/`owner_token_hash`, nicht als tot behandelt
(`supabase/migrations/phase51d_cleanup_inert_token_artifacts.sql:11-13`). Er wird der Public
Projection (siehe unten) nie ausgeliefert.

## Public Projection

Die öffentliche Share-Ansicht liest nicht die private `data`-Spalte, sondern ausschließlich
die View `public.collection_public_projection`
(`supabase/migrations/phase27b_public_projection_rls_hardening.sql:112-120`):

- Definiert mit `security_invoker = true` (läuft mit den Rechten des Aufrufers, nicht des
  View-Erstellers).
- Liefert **nur** die Spalten `id, public_data, updated_at, visibility`.
- Gefiltert auf `visibility = 'public' and public_data is not null`.
- `revoke all` auf die View, danach gezielt `grant select` an `anon, authenticated` — kein
  breiter Grant auf die Basistabelle `public.collections`.

Der Client baut die ausgelieferte Projektion serverseitig-kompatibel mit
`buildPublicCollectionData()` (`src/app.js`), das nur unkritische Felder (Titel, Bände,
Sammlungsstatus, Cover) in `public_data` schreibt — Notizen, Lesedaten, Kaufdaten, ISBN-13
und interne Manga-Passion-IDs bleiben ausschließlich in der privaten `data`-Spalte.

## RPC-Rechte

Phase 81 hat `anon` das `EXECUTE`-Recht auf sechs `security definer`-Funktionen entzogen:
`review_candidate_start`, `review_candidate_approve`, `review_candidate_reject`,
`review_candidate_block`, `review_candidate_mark_duplicate` und
`submit_manga_catalog_candidate`. `authenticated` und `service_role` behalten das Recht
(`supabase/migrations/20260926_phase81_audit_hardening.sql`).

**Fallstrick beim Entziehen von `EXECUTE`**: Postgres vergibt `EXECUTE` auf neue Funktionen
per Default an `PUBLIC`. `anon`/`authenticated` erben das Recht dann über `PUBLIC`, nicht
direkt — ein `revoke execute … from anon` allein ist deshalb wirkungslos
(`has_function_privilege('anon', …, 'EXECUTE')` bleibt `true`). Richtig ist `revoke … from
public, anon`, danach **immer** mit `has_function_privilege()` nachmessen statt auf den
`success`-Status des Statements zu vertrauen. Das ausführliche Beispiel und die
Nachmess-Query stehen in `supabase/migrations/README.md` (Abschnitt „Fallstrick: EXECUTE-
Rechte richtig entziehen") und werden hier bewusst nicht dupliziert.

## Client-Härtung

Aktueller CSP-Ist-Stand, wörtlich aus `index.html:5` (`Content-Security-Policy`):

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
connect-src 'self' https://sssxiqtnkctvyghyrqff.supabase.co https://api.manga-passion.de
https://graphql.anilist.co; img-src 'self' data: https:; script-src 'self';
style-src 'self'; upgrade-insecure-requests;
```

- **Kein** `unsafe-inline`, weder für `script-src` noch für `style-src`. Inline-Script-
  Handler (`onclick` usw.) wurden in Phase 21c durch zentrale Event-Listener und Event-
  Delegation ersetzt; verbliebene Inline-Styles wurden in Phase 30 entfernt.
  `scripts/security-audit-static.js` (Check 20/21) schlägt fehl, falls `unsafe-inline` in
  eine der beiden Direktiven zurückkehrt.
- `Referrer-Policy` ist auf `no-referrer` gesetzt (`index.html`, `<meta name="referrer">`).
- JSZip wird lokal aus `vendor/jszip.min.js` geladen (nicht von einem CDN) und trägt ein
  `integrity="sha384-…"`-Attribut plus `crossorigin="anonymous"` (Phase 64,
  `scripts/security-audit-static.js` Check 40).
- **npm-gestützter Vendor-Sync (Phase 83).** `vendor/jszip.min.js` wird nicht mehr manuell
  gepflegt, sondern mit `node scripts/sync-vendor-jszip.js` byteweise aus dem gepinnten
  npm-Paket (`node_modules/jszip/dist/jszip.min.js`) erzeugt. Das Skript schreibt
  `vendor/jszip.sri.json` (Paket, Version, Quelldatei, `sha384`-Hash, `syncedAt`) und zieht das
  `integrity`-Attribut in `index.html` nach. Ändern sich dabei die Bytes der Vendor-Datei, ist
  ein `CACHE_VERSION`-Bump in `sw.js` Pflicht.
- **Drift-Checks.** `scripts/validate-vendor-jszip.js` (in `run-all-checks`, offline) prüft:
  Datei vorhanden und plausibel, Hash === `integrity` in `index.html`, `vendor/jszip.sri.json`
  passt zu Hash **und** zur in `package.json` gepinnten Version, und — falls `node_modules`
  installiert ist — Byte-Gleichheit mit dem npm-Paket. Genau dieser Check wird rot, wenn
  Dependabot die Version anhebt, ohne dass neu vendort wird (Audit-Befund 12).
  Ergänzend prüft `scripts/security-audit-static.js` Check **40b** den Hash der ausgelieferten
  Datei gegen das `integrity`-Attribut. Aufgabenteilung: Check 40/40b = „ausgelieferte Datei
  passt zum SRI"; `validate-vendor-jszip.js` = „ausgelieferte Datei passt zum npm-Paket und zur
  gepinnten Version". Der JSZip-Banner ist dabei **nie** die Versionsquelle (er ist innerhalb
  der 3.10.x-Reihe nicht zuverlässig), es zählen ausschließlich Inhalts-Hashes.

## PWA und Service Worker

Seit Phase 69 liefert `sw.js` einen Service Worker aus, Phase 73 hat ihn an die erweiterte
CSP angepasst. Aktuell: `CACHE_VERSION = 'mt-pwa-v8'` (Phase 83: neu erzeugte `vendor/jszip.min.js` samt neuem SRI-Hash).

- Non-GET-Requests werden nie abgefangen — `request.method !== 'GET'` (`sw.js:75`) führt zu
  `return` — Supabase-Writes und RPC-POSTs laufen am Service Worker vorbei.
- Cross-Origin-Requests werden durchgelassen — `url.origin !== self.location.origin`
  (`sw.js:89`) führt ebenfalls zu `return`: Supabase-Antworten und Auth-Token werden dadurch
  **niemals** gecacht.
- `data/*.json` läuft Network-First mit Cache-Fallback, die App-Shell (`index.html` und
  statische Assets) läuft Cache-First.
- **Bump-Pflicht**: Weil `index.html` cache-first ausgeliefert wird, erzwingt jede
  CSP-Änderung einen `CACHE_VERSION`-Bump — sonst laufen Bestandsgeräte mit der alten CSP
  weiter, bis der Cache anderweitig invalidiert wird.

## Secrets

Im Client-Bundle liegt ausschließlich der publishable Supabase-Key
(`sb_publishable_...`) — niemals ein Service-Role- oder sonstiger Secret-Key. Secrets für
CI-Workflows (z. B. für die Release-Cache-Pipeline) leben ausschließlich in GitHub-Secrets,
nicht im Repository.

`scripts/check-secrets.js` scannt `src/`, `data/`, `docs/`, `scripts/`, `.github/` und
`index.html` nach verbotenen Mustern.

**Wichtig**: `docs/security.md` — diese Datei — steht in `EXCLUDED_FILES`
(`scripts/check-secrets.js:53-55`) und wird deshalb bewusst *nicht* gescannt (sie enthält
sonst die Muster selbst als Dokumentation). Das bedeutet: Ein hier versehentlich
eingefügter echter Schlüssel würde **nicht** erkannt. In diese Datei gehören ausschließlich
Platzhalter (wie oben `sb_publishable_...`), niemals echte Schlüssel oder Token.

## Automatische Guards

Mehrere statische Prüfungen laufen gebündelt über `scripts/run-all-checks.js`:

- `scripts/security-audit-static.js` — CSP-/SRI-/Härtungs-Checks 1–40 plus die
  publikationsstatusbezogenen Checks 57/57e und die PWA-Checks 69a–69g. Check 12 prüft seit
  Phase 84 den Anti-Regressions-Guard „`src/app.js` und `src/supabase.js` enthalten keine
  Owner-Token-Autorisierung" (keine Treffer für `x-owner-token`, `_ownerToken`,
  `getOwnerState`, `supaHead`; `mtOwnerToken` nur als `removeItem`-Argument).
- `scripts/smoke-test-static.js` — statische Struktur, Doku-Inhaltsprüfungen (u. a. diese
  Datei) und der Phase-82-Orphan-Guard (siehe „Pflege").
- `scripts/test-owner-token-cleanup-phase84.js` — Regressionstest für das Import-Sync-Gate
  (`importSyncDecision()`), die Token-Freiheit von `src/app.js`/`src/supabase.js`/`src/auth.js`
  und die `src/…:ZEILE`-Referenzen in dieser Datei (verhindert die Zeilen-Drift, die in
  Phase 82/83 Reviewer-Blocker war).
- `scripts/check-secrets.js` — Secret-Scan (siehe oben).

Zusätzlich in CI: CodeQL-Code-Scanning (`.github/workflows/codeql.yml`, wöchentlicher
Schedule plus Push/PR) und `npm audit --audit-level=high` (`.github/workflows/ci.yml`).

## Bekannte Einschränkungen

- Die CSP wird nur als `<meta http-equiv="Content-Security-Policy">` ausgeliefert, nicht als
  echter HTTP-Response-Header. Dadurch ist `frame-ancestors` in der Praxis wirkungslos
  (Browser ignorieren diese Direktive im Meta-Tag). Nachverfolgt im Backlog als Punkt 1.3 /
  7.1 (`02 Projekte/Manga Tracker/Verbesserungen und Automationen 2.md`).
- `supabase/migrations/` ist **nicht** vollständig deckungsgleich mit der tatsächlich
  angewendeten Migrationshistorie des Supabase-Projekts (Audit-Befund 15). Details, Ursache
  und der bestätigte reale Schema-Stand stehen in `supabase/migrations/README.md`.

## Pflege

`scripts/smoke-test-static.js` prüft diese Datei automatisiert: Mindestlänge und das
Vorhandensein von acht Pflichtabschnitten (Auth, Datenmodell/RLS, Public Projection,
RPC-Rechte, Client-Härtung, PWA/Service Worker, Secrets, Automatische Guards — siehe die
Überschriften oben in dieser Datei). Wird einer dieser Abschnitte entfernt oder die Datei
geleert, schlägt der Smoke-Test rot. Zusätzlich sorgt der Orphan-Guard (ebenfalls in
`scripts/smoke-test-static.js`) dafür, dass jedes neue `scripts/test-*.js` oder
`scripts/validate-*.js` in `scripts/run-all-checks.js` referenziert sein muss.

Änderungshistorie in Stichworten: Phase 21 (erste CSP) → Phase 51 (session-only Auth,
Owner-Token serverseitig abgeschafft) → Phase 64 (JSZip-SRI) → Phase 69 (Service Worker/PWA)
→ Phase 73 (CSP-Bump für AniList) → Phase 81 (RPC-`anon`-Härtung, RLS-InitPlan) → Phase 82
(diese Doku neu geschrieben, Smoke-Test prüft Inhalt statt Existenz) → Phase 84 (letzte
Client-seitige Owner-Token-Reste entfernt, Import-Sync-Gate auf Session-Modus umgestellt).
