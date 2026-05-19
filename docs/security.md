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

## Phase 21b — Public Projection (in Vorbereitung)

Die Supabase-Migration `supabase/migrations/phase21b_public_projection_rls.sql`
bereitet eine sichere Public Projection vor.

Nach Anwendung gilt:
- Öffentliche Ansichten lesen nur `public_data`, nicht die komplette private `data`-Spalte.
- Private Felder (Notizen, isbn13, Lesedaten, Kaufdaten) werden nicht an `anon` ausgeliefert.
- Der Client verwendet `buildPublicCollectionData()` um `public_data` beim Cloud-Push zu befüllen.

Manuell anzuwenden:
1. `phase21_public_projection.sql` in Supabase SQL Editor ausführen.
2. `phase21b_public_projection_rls.sql` prüfen und ausführen.
3. Client-Code auf `public_data` umstellen (TODO-Kommentare in `src/app.js` und `src/supabase.js`).

## CSP-Status

Phase 21 hat eine pragmatische CSP eingeführt.
Phase 21b hat Inline-Handler analysiert und dokumentiert.

Restschuld: `unsafe-inline` ist noch in der CSP enthalten (script-src und style-src).
`index.html` enthält zahlreiche Inline-Event-Handler (onclick, oninput, onchange, onmouseover,
onmouseout) sowie Inline-Styles. Eine vollständige Entfernung von `unsafe-inline` würde das
komplette Umschreiben aller Inline-Handler auf Event-Delegation sowie das Auslagern aller
Inline-Styles in CSS-Klassen erfordern. Geplant für Phase 22.
