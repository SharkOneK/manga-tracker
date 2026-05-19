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

## Phase 27b — Public Projection RLS (später)

`supabase/migrations/phase21b_public_projection_rls.sql` ist aktuell keine echte
ausführbare Migration, sondern eine Checkliste mit kommentierten Beispiel-SQLs.
Sie darf nicht blind produktiv angewendet werden.

Phase 27b muss separat erfolgen:

1. `public_data` für bestehende Sammlungen backfillen und live testen.
2. Sicherstellen, dass der Client für Share-Views ohne Legacy-`data`-Fallback funktioniert.
3. Danach erst Grants/RLS verschärfen:
   - `anon` darf nicht mehr die private `data`-Spalte lesen.
   - Public-View darf nur noch `public_data` lesen.
4. Vor produktiver Anwendung Backup/Export erstellen.

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
