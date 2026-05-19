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
