# Sicherheitshinweise — Manga Tracker

## Zweck und Geltungsbereich

Diese Datei beschreibt den Ist-Stand der Sicherheitsarchitektur des Manga Trackers:
Auth-Modell, Datenzugriff (RLS/Public Projection), RPC-Rechte, Client-Härtung (CSP/SRI),
PWA/Service-Worker-Verhalten, den Umgang mit Secrets sowie die automatischen Guards, die
Regressionen verhindern. Sie richtet sich an Maintainer und an Reviewer künftiger Phasen.

Frühere Fassungen dieser Datei beschrieben ein Owner-Token-Modell (Schreibgeheimnis im
Browser-localStorage). Dieses Modell ist seit Phase 51 als Autorisierungsmechanismus
abgeschafft (serverseitig gedroppt); zu den verbliebenen Client-Resten siehe „Auth-Modell"
und „Bekannte Einschränkungen". Jede Aussage in dieser Datei ist gegen den
Code-/Migrationsstand von Phase 82 verifiziert; wo Unsicherheit bestand, wurde
die Aussage weggelassen statt geraten.

## Auth-Modell

Seit Phase 51 ist der **aktive Schreib-/Lesepfad session-only**; ein `x-owner-token` wird
nicht mehr gesendet. Im Client-Code liegen weiterhin inerte Reste des alten Modells — siehe
Präzisierung unten.

- **Passkey (WebAuthn)** ist der primäre Anmeldeweg (`src/auth.js:127`, `signInWithPasskey()`
  bzw. `src/auth.js:131`, `registerPasskey()`). Die RP-ID wird nicht im Client-Code
  konfiguriert; die Passkey-Behandlung liegt vollständig in supabase-js und ergibt sich aus
  dem ausliefernden Origin (`https://sharkonek.github.io/manga-tracker/`, siehe
  `.github/workflows/live-smoke.yml:9`).
- **E-Mail-OTP** dient als Bootstrap/Fallback (`src/auth.js:119`, `startEmailOtp()` /
  `src/auth.js:123`, `verifyEmailOtp()`), z. B. für die Erstregistrierung eines Passkeys.
- Autorisierung auf Datenbankebene läuft ausschließlich über `auth.uid()` (siehe
  „Datenmodell und RLS"), nicht über einen mitgesendeten Token-Header.
- Der Client hält die Session im `localStorage` und holt vor jedem privilegierten Request
  ein frisches Access-Token über `ensureFreshAccessToken()` (`src/supabase.js:131`), das bei
  Bedarf per Refresh-Token erneuert wird. Aufrufer sind u. a. `fetchCollection()`
  (`src/supabase.js:191`), `submitReleaseIntakeCandidate` (`:259`),
  `submitMangaCatalogCandidate` (`:339`) und `patchCollection()` (`:378`). Liefert die
  Funktion `null`, gilt der Nutzer als nicht angemeldet — es gibt keinen automatischen
  Token-Fallback mehr.

**Präzisierung (Phase 82-Fix)**: Der aktive Schreibpfad ist wie oben beschrieben session-only,
ohne Token-Fallback — `patchCollection()` (`src/supabase.js:378`) hängt ausschließlich an
`ensureFreshAccessToken()` und wirft ohne gültiges Session-Token. Das ist die
sicherheitsrelevante Aussage.

Im Client-Code liegen aber weiterhin **inerte Reste** des früheren Owner-Token-Modells,
serverseitig ohne Wirkung, aber nicht entfernt:

- `src/supabase.js:16-42` (`adoptOwnerIfPresent()`) liest `adopt`/`token` aus URL-Fragment
  bzw. Query-String und schreibt sie via `localStorage.setItem('mtOwnerToken', …)`; läuft bei
  jedem Seitenaufruf (`src/app.js:15`).
- `src/supabase.js:46-50` (`getOwnerState()`) liest `mtOwnerToken` aus `localStorage` zurück.
- `src/supabase.js:53-59` (`headers(ownerToken, write)`) setzt bei `write && ownerToken` den
  Header `x-owner-token`; der zugehörige Kopf-Kommentar (`src/supabase.js:8-9`) beschreibt ihn
  sogar noch als aktiven Fallback, was dem tatsächlichen Schreibpfad widerspricht.
- `src/app.js:19` (`_ownerToken`) und `src/app.js:21-23` (`supaHead()`) existieren als
  Wrapper um diese Funktionen.
- `src/auth.js:281` räumt `mtOwnerToken` beim Logout mit auf.

Diese Reste sind serverseitig wirkungslos: Die Spalte `owner_token` ist gedroppt
(`supabase/migrations/phase51f_drop_owner_token_column.sql`), und die RLS-Policies auf
`public.collections` werten ausschließlich `auth.uid()` aus (siehe „Datenmodell und RLS") —
ein mitgesendeter `x-owner-token`-Header hätte serverseitig keinerlei Effekt mehr, selbst wenn
er gesendet würde.

Sie sind trotzdem Restschuld, kein rein kosmetisches Detail: `adoptOwnerIfPresent()` schreibt
weiterhin Tokens aus URL-Parametern in `localStorage`, und `src/app.js:2281` gated den
Cloud-Sync nach einem Import mit `if (_collId && _ownerToken)` — für reine Session-Nutzer
(Passkey/E-Mail-OTP, kein Adopt-Link) ist `_ownerToken` `null`, wodurch der Sync an dieser
Stelle übersprungen wird (latenter Bug, keine Sicherheitslücke). Die Bereinigung dieser Reste
ist als eigene Phase 84 vorgesehen; bis dahin gilt: kein aktiver `x-owner-token`-Versand auf
dem echten Schreibpfad, aber auch kein vollständig token-freier Client.

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

Aktueller CSP-Ist-Stand, wörtlich aus `index.html:5`:

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

## PWA und Service Worker

Seit Phase 69 liefert `sw.js` einen Service Worker aus, Phase 73 hat ihn an die erweiterte
CSP angepasst. Aktuell: `CACHE_VERSION = 'mt-pwa-v7'` (`sw.js:19`).

- Non-GET-Requests werden nie abgefangen (`sw.js:71`, `request.method !== 'GET'` →
  `return`) — Supabase-Writes und RPC-POSTs laufen am Service Worker vorbei.
- Cross-Origin-Requests werden durchgelassen (`sw.js:85`,
  `url.origin !== self.location.origin` → `return`): Supabase-Antworten und Auth-Token
  werden dadurch **niemals** gecacht.
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
  publikationsstatusbezogenen Checks 57/57e und die PWA-Checks 69a–69g.
- `scripts/smoke-test-static.js` — statische Struktur, Doku-Inhaltsprüfungen (u. a. diese
  Datei) und der Phase-82-Orphan-Guard (siehe „Pflege").
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
Owner-Token abgeschafft) → Phase 64 (JSZip-SRI) → Phase 69 (Service Worker/PWA) → Phase 73
(CSP-Bump für AniList) → Phase 81 (RPC-`anon`-Härtung, RLS-InitPlan) → Phase 82 (diese
Doku neu geschrieben, Smoke-Test prüft Inhalt statt Existenz).
