# Sicherheitshinweise — Manga Tracker

## Was ist öffentlich?

Eine Sammlung ist öffentlich zugänglich, wenn sie über einen Share-Link (`?view=<uuid>`) aufgerufen wird.
Die öffentliche Ansicht zeigt Titel, Bände, Sammlungsstatus und Cover.

## Was ist privat?

Notizen, Lesedaten, Kaufdaten, ISBN-13, interne Manga-Passion-IDs und der Owner-Token
werden nicht in der öffentlichen Ansicht angezeigt.

## Owner-Token

Der Owner-Token ist das Schreibgeheimnis für deine Sammlung. Er wird im Browser-localStorage gespeichert.

**Niemals weitergeben.**

Falls ein Token kompromittiert wurde: Owner-Token rotieren (in Planung als Phase 21b).

## Adopt-Link

Ein Adopt-Link überträgt den Zugang auf ein weiteres Gerät.
Adopt-Links sollten nur über sichere Kanäle geteilt werden (nicht per E-Mail oder öffentlich).
Aktuelle Version: Fragment-basiert (`#adopt=...`), wird nicht an Server gesendet.

## Publishable Key

Der Supabase Publishable Key (`sb_publishable_...`) ist öffentlich und darf im Frontend-Code stehen.

## Service-Role-Key

Der Supabase Service-Role-Key darf **niemals** in den Repository-Code oder Umgebungsvariablen
von öffentlichen CI-Workflows stehen. Er gehört nur in geheime CI-Secrets.

## Was tun bei Token-Leak?

1. Owner-Token rotieren (sobald verfügbar).
2. Supabase-Projekt-Keys rotieren, falls service_role betroffen.
3. GitHub Secret neu setzen.
4. Betroffene Commits rebasieren und History bereinigen.

## Phase 27a — Public Projection Client-Prep

Die öffentliche Share-Ansicht soll langfristig nicht mehr die komplette private
`data`-Spalte lesen. Phase 27a bereitet diesen Wechsel rückwärtskompatibel vor:

- Cloud-Push schreibt weiterhin `data`.
- Cloud-Push versucht zusätzlich `public_data = buildPublicCollectionData(db)` zu schreiben.
- Wenn `public_data` remote noch fehlt oder noch nicht freigegeben ist, fällt der Sync
  automatisch auf den bisherigen `data`-Write zurück.
- Public-Views lesen bevorzugt `public_data` und fallen nur solange auf `data` zurück,
  bis die Migration/Backfills/RLS-Umstellung vollständig abgeschlossen sind.

Die neue vorbereitende Migration ist:

`supabase/migrations/20260519233037_phase27a_public_projection_columns.sql`

Sie ergänzt nur sichere Spalten (`public_data`, `visibility`, `view_token_hash`,
`owner_token_hash`) und enthält bewusst keine RLS-/Policy-/Grant-Verschärfung.

## Phase 27b — Public Projection RLS-Härtung

Phase 27b bereitet die produktive Supabase-Härtung als ausführbare Migration vor:

`supabase/migrations/phase27b_public_projection_rls_hardening.sql`

Zielzustand nach Anwendung in Supabase:

- `public.collections.data` bleibt private Owner-Datenstruktur.
- Public Share-Views lesen nur `public.collection_public_projection` / `public_data`.
- `anon`/`authenticated` bekommen keinen SELECT-Grant auf `data`, `owner_token`,
  `owner_token_hash` oder `view_token_hash`.
- `anon`/`authenticated` bekommen keine INSERT-/DELETE-Rechte.
- Owner-Updates bleiben per `x-owner-token`-RLS-Policy geschützt.
- Owner-Pull läuft über `get_owner_collection(collection_id)` und gibt nur bei gültigem
  `x-owner-token` private `data` zurück.
- Bestehende Rows werden nur mit einer sanitisierten Projektion backfilled; `data` wird
  niemals wholesale nach `public_data` kopiert.

Wichtig: Diese Repository-Änderung bedeutet **Migration vorbereitet**. Sie bedeutet nicht
automatisch, dass die Migration bereits im Supabase-Projekt angewendet wurde. Nach manueller
Anwendung im SQL Editor müssen Live-Checks bestätigen, dass Public Requests keine private
`data`-Spalte mehr erhalten und Owner-Requests weiter funktionieren.

Manuelle Anwendung:

1. Backup/Export der Tabelle `public.collections` erstellen.
2. SQL aus `supabase/migrations/phase27b_public_projection_rls_hardening.sql` im Supabase
   SQL Editor prüfen und ausführen.
3. REST-Live-Checks ausführen:
   - Public Projection: `collection_public_projection?id=eq.<id>&select=public_data` liefert Daten.
   - Base Table Public: `collections?id=eq.<id>&select=data` wird verweigert.
   - Owner RPC: `rpc/get_owner_collection` mit gültigem `x-owner-token` liefert private Daten.
   - Owner PATCH mit gültigem `x-owner-token` schreibt `data` und `public_data`.
4. Browser-Smoke-Test auf GitHub Pages durchführen.

Bekannte Restschuld: Die Owner-RPC-Funktion ist ein bewusst eng begrenzter `security definer`,
weil der statische GitHub-Pages-Client ohne Supabase Auth weiterhin private Owner-Daten mit
`x-owner-token` laden können muss. Die Funktion gibt keine Token-Spalten zurück und nutzt
`set search_path = ''`.

## Phase 46d — CodeQL / GitHub Code Scanning

Phase 46d aktiviert native GitHub-Code-Scanning-Analyse mit CodeQL als eigenen Workflow:

- Workflow: `.github/workflows/codeql.yml`
- Trigger: `push` auf `main`, `pull_request`, wöchentlicher Schedule montags um `05:23 UTC`
- Sprache: `javascript-typescript`
- Build-Modus: `none` (statische JavaScript-/TypeScript-Analyse ohne Build-Schritt)
- Konfiguration: `.github/codeql/codeql-config.yml`
- Berechtigungen: `contents: read`, `actions: read`, `security-events: write`

CodeQL schreibt Findings in GitHub unter **Security → Code scanning**. Der Workflow ergänzt die
bestehenden lokalen Prüfungen; er ersetzt ausdrücklich nicht `node scripts/security-audit-static.js`
oder den Gesamt-Runner `node scripts/run-all-checks.js`.

`vendor/**` ist in der CodeQL-Konfiguration ausgeschlossen, damit die lokal vendored JSZip-Datei
nicht als First-Party-Quellcode bewertet wird. Die Supply-Chain-Absicherung für JSZip bleibt im
statischen Audit erhalten: Existenz der lokalen Datei und lokale Einbindung statt CDN werden dort
weiterhin geprüft.

## Phase 50 — Triage der CodeQL-High-Alerts

Der erste CodeQL-Lauf (Phase 46d) erzeugte 16 offene High-Alerts. Phase 50 hat sie bewertet und
behoben bzw. begründet geschlossen:

- **`js/xss-through-dom` (11):** Die betroffenen `innerHTML`-Render-Pfade (`mangaCard`, `buyCard`,
  `volumeRow`, `buyPreviewRow`, `buildReleasePreview`) und die in Leerzustände eingesetzte
  Suchanfrage (`searchQ`) leiten Nutzdaten jetzt konsequent durch `escapeHtml()`. Damit ist die
  `innerHTML`-Injektion auch dann ausgeschlossen, wenn Sammlungs- oder Release-Cache-Daten künftig
  fremde Inhalte enthalten. (Real-World-Risiko war wegen Single-User-Charakter überwiegend
  Self-XSS, die Härtung ist trotzdem umgesetzt.)
- **`js/incomplete-sanitization` (2):** Der Obsidian-YAML-Export escaped Titel/Verlag über die neue
  Hilfsfunktion `escapeYamlString()` (erst Backslash, dann Anführungszeichen, Zeilenumbrüche → Space),
  abgesichert durch einen Regressionstest in `scripts/test-data-integrity.js`.
- **`js/double-escaping` (2):** Die `decodeHtml()`-Funktionen in `carlsen-provider.js` und
  `generic-publisher-provider.js` dekodieren `&amp;` jetzt zuletzt, damit verschachtelte Entities
  nicht doppelt aufgelöst werden.
- **`js/incomplete-url-substring-sanitization` (1, `scripts/security-audit-static.js`):** bewusst als
  *false positive* im Security-Tab geschlossen — die Stelle ist eine **Erkennungs-Heuristik**, die im
  eigenen statischen `index.html` nach einer CDN-Referenz (`cdn.jsdelivr.net` + `jszip`) sucht; sie
  sanitisiert keine externe Eingabe. Eine „Subdomain-Umgehung" ist hier kein Angriffsvektor.

Ziel/Ergebnis: 0 unbewertete offene High-Alerts im Security-Tab.

## CSP-Status

Phase 21 hat eine pragmatische CSP eingeführt.
Phase 21b hat Inline-Handler analysiert und dokumentiert.
Phase 21c hat die Inline-Script-Handler aus `index.html` und den dynamisch gerenderten
Templates in `src/app.js` entfernt.

Aktueller Stand nach Phase 21c:
- Inline-Script-Handler (`onclick`, `oninput`, `onchange`, `onmouseover`, `onmouseout` usw.)
  wurden durch zentrale Event-Listener und Event-Delegation ersetzt.
- `script-src` läuft ohne `'unsafe-inline'` und ist auf `'self'` gehärtet.
- Der statische Security-Audit schlägt fehl, falls `script-src` wieder `'unsafe-inline'`
  enthält oder Inline-Script-Handler zurückkehren.

Restschuld: `style-src 'unsafe-inline'` bleibt vorerst bewusst erlaubt, weil `index.html` und
Templates noch Inline-Styles für Layout-/Statuswerte enthalten. Diese Restschuld ist von
Inline-Script-Handlern getrennt und wird nur als WARN behandelt.

Nächster möglicher Schritt: Inline-Styles schrittweise in CSS-Klassen bzw. Custom Properties
überführen und danach auch `style-src 'unsafe-inline'` entfernen.
