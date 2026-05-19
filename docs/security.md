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
