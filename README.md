# Manga Tracker

Statische Browser-App zum Verwalten physischer Manga-Ausgaben.

## Projektstruktur

```text
.
|-- index.html
`-- src
    |-- app.js
    `-- styles.css
```

Die App hat keinen Build-Schritt und benoetigt kein Backend. GitHub Pages kann den Repo-Root direkt aus `main` veroeffentlichen.

## GitHub Pages Deployment

Geplante URL:

```text
https://sharkonek.github.io/manga-tracker/
```

GitHub-Einstellungen:

1. Repository: `sharkonek/manga-tracker`
2. Settings > Pages
3. Source: `Deploy from a branch`
4. Branch: `main`
5. Folder: `/root`
6. Speichern und den Pages-Build abwarten

## JSONBin Sync

Es werden keine JSONBin Keys, Bin-IDs oder Secrets im Repository gespeichert.

Der Nutzer traegt Bin-ID und `X-Access-Key` spaeter im Browser unter Einstellungen ein. Der Key wird standardmaessig nur in `sessionStorage` gespeichert. Optional kann der Nutzer ihn lokal auf dem Geraet speichern.

Fuer den produktiven Einsatz sollte ein eingeschraenkter JSONBin Access Key verwendet werden:

- `bins.read`
- `bins.update`
- keine Create/Delete-Rechte

JSONBin bleibt ab Phase 8 als `Legacy JSONBin Sync` erhalten, bis Supabase im Alltag stabil getestet ist.

## Phase 8: Supabase Cloud-Sync

Supabase ist optional. Die App startet und funktioniert weiterhin lokal mit `localStorage`, auch wenn keine Supabase-Konfiguration gesetzt ist.

### Supabase-Projekt vorbereiten

1. Neues Supabase-Projekt erstellen.
2. Authentication > Providers > Email aktiv lassen.
3. Authentication > URL Configuration setzen:
   - Site URL: `https://sharkonek.github.io/manga-tracker/`
   - Redirect URL: `https://sharkonek.github.io/manga-tracker/`
   - Fuer lokale Tests optional zusaetzlich die lokale URL eintragen, z. B. `http://localhost:8000/`.
4. SQL-Migrationen aus `supabase/migrations` im Supabase SQL Editor oder per Supabase MCP/CLI anwenden.
5. Settings > API Keys oeffnen und nur die Project URL und den Public/Anon bzw. Publishable Key in der App unter `Einstellungen > Supabase Cloud-Sync` eintragen.

Niemals einen `service_role` Key in der Browser-App eintragen. Dieser Key gehoert nicht in GitHub Pages, `localStorage`, Screenshots oder Commits.

### Datenmodell

Phase 8 nutzt bewusst ein simples JSONB-Modell:

- Tabelle: `public.manga_tracker_databases`
- ein Datensatz pro angemeldetem Supabase-User
- Spalte `database` enthaelt die komplette Manga-Tracker-Datenbank mit `series` und `volumes`
- Row Level Security ist aktiv
- `authenticated` darf per RLS nur den eigenen Datensatz lesen, einfuegen, aktualisieren und loeschen
- `anon` hat keine Tabellenrechte fuer Nutzerdaten

### Migration von JSONBin zu Supabase

1. In der App einen JSON Export herunterladen oder sicherstellen, dass ein aktuelles lokales Backup existiert.
2. Supabase URL und Public/Anon Key eintragen und Supabase Cloud-Sync aktivieren.
3. Per `Login-Link senden` anmelden und den Magic Link aus der E-Mail oeffnen.
4. Optional `JSONBin zu Supabase migrieren` verwenden. Die App erstellt vorher ein lokales Backup.
5. Wenn JSONBin konfiguriert ist, kann optional zuerst JSONBin geladen werden.
6. Danach speichert die App die lokale Datenbank in Supabase.
7. JSONBin-Konfiguration und lokale Daten werden nicht automatisch geloescht.

### Supabase Smoke-Tests

Manuell nach der Migration pruefen:

1. App ohne Supabase Config starten: lokale Tabs und localStorage funktionieren normal.
2. Supabase Config speichern, ohne Login `Cloud speichern` ausfuehren: Aktion wird blockiert.
3. Ohne Login `Cloud laden` ausfuehren: Aktion wird blockiert.
4. Magic-Link-Login ausfuehren und angemeldete E-Mail/User-ID anzeigen lassen.
5. Logout ausfuehren und Status pruefen.
6. Erster `Cloud speichern` legt den Datensatz in `manga_tracker_databases` an.
7. Nach einer lokalen Aenderung aktualisiert ein zweiter `Cloud speichern` denselben Datensatz.
8. `Cloud laden` erstellt vor lokalem Ueberschreiben ein Backup.
9. Bei neuerem Cloud-Stand fragt die App vor Uebernahme; bei Abbruch bleibt lokal alles erhalten.
10. Bei neuerem lokalem Stand blockiert `Cloud laden`, speichert den Cloud-Stand als Backup und ueberschreibt nichts blind.
11. `Legacy JSONBin Sync` bleibt sichtbar und unveraendert.

### Schritt-fuer-Schritt-Test im normalen Browser

Wenn der integrierte Preview-Browser `localhost` oder `file://` blockiert, den Test im normalen Browser ausfuehren:

1. Supabase Dashboard oeffnen.
2. Project Settings > API oeffnen.
3. `Project URL` kopieren.
4. Unter API Keys den `anon`/`publishable` Key kopieren. Keinen `service_role` oder Secret Key verwenden.
5. Authentication > URL Configuration oeffnen.
6. Site URL auf `https://sharkonek.github.io/manga-tracker/` setzen.
7. Redirect URLs um `https://sharkonek.github.io/manga-tracker/` ergaenzen.
8. App unter `https://sharkonek.github.io/manga-tracker/` oeffnen.
9. Einstellungen oeffnen und pruefen, dass `Supabase Cloud-Sync` oberhalb von `Legacy JSONBin Sync` sichtbar ist.
10. Ohne Supabase Config `Cloud speichern`, `Cloud laden` und `Sync testen` anklicken: es muss eine verstaendliche Blockade wegen fehlender Config/Login erscheinen.
11. Supabase Cloud-Sync aktivieren, Project URL und Public/Anon Key eintragen, Login-E-Mail eintragen.
12. `Login-Link senden` klicken und den Magic Link aus der E-Mail oeffnen.
13. Nach der Rueckkehr zur App Einstellungen oeffnen: E-Mail oder User-ID muss als angemeldet angezeigt werden.
14. `Cloud speichern` klicken: in Supabase muss genau ein Datensatz fuer den User in `manga_tracker_databases` entstehen.
15. Lokal eine kleine Test-Serie oder einen Test-Band aendern und erneut `Cloud speichern` klicken: derselbe Datensatz muss aktualisiert werden, kein zweiter Datensatz.
16. JSON Export herunterladen oder ein Backup im localStorage bestaetigen.
17. `Cloud laden` klicken: vor einer lokalen Uebernahme muss ein Backup gemeldet werden.
18. Konflikt testen: In einem zweiten Browser/Profil denselben User anmelden, Daten aendern und in Supabase speichern. Danach im ersten Profil mit aelterem Stand `Cloud laden` testen. Die App darf nicht ohne Nachfrage/Backup ueberschreiben.
19. `Logout` klicken: Status muss auf abgemeldet wechseln.
20. JSONBin-Konfiguration bleibt erhalten; keine JSONBin-Werte werden automatisch entfernt.

## Phase 4b PoC: Manga-Passion-JSON

Release-Daten und Cover werden im PoC nur ueber eine manuelle JSON-Datei pro Serie geprueft. Es gibt keinen direkten Browser-Fetch auf Manga Passion, keinen Proxy, keine GitHub Action und kein Massenupdate.

Unter `Serien` kann bei einer Serie `Release-Daten pruefen` gewaehlt werden. Die Datei sollte eine `volumes`-Liste enthalten:

```json
{
  "source": "manga-passion",
  "series": {
    "title": "Chainsaw Man",
    "mangaPassionUrl": "https://www.manga-passion.de/editions/269/chainsaw-man"
  },
  "volumes": [
    {
      "title": "Chainsaw Man, Band 22",
      "volumeNumber": 22,
      "editionType": "standard",
      "publisher": "Egmont Manga",
      "releaseDate": "2026-08-04",
      "isbn13": "9783755506805",
      "coverUrl": "https://media.manga-passion.de/volume/cover/example.jpg",
      "coverConfidence": 90,
      "mangaPassionUrl": "https://www.manga-passion.de/volumes/29431/chainsaw-man-band-22"
    }
  ]
}
```

Die App zeigt nur eine Vorschau. Uebernommen wird erst nach Auswahl einzelner Felder und Klick auf `Ausgewaehlte uebernehmen`. `owned`, `read`, `boughtAt` und `readAt` werden nie geaendert. Manuell gesetzte Cover (`coverManuallySet`) werden nicht ersetzt.

## Phase 4c PoC: Release-Cache per GitHub Action

Die Datei `data/release-sources.json` enthaelt eine manuell gepflegte, kuratierte Liste von Manga-Passion-Quellen. Es wird nicht frei gecrawlt.

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "seriesTitle": "Chainsaw Man",
      "publisher": "egmont",
      "mangaPassionUrl": "https://www.manga-passion.de/editions/269/chainsaw-man"
    }
  ]
}
```

Der Workflow `Update release cache` laeuft nur manuell per `workflow_dispatch`. Das Script `scripts/update-release-cache.js` ruft die kuratierten Manga-Passion-Seiten serverseitig ab, wartet zwischen Requests und schreibt oeffentliche Release-Daten nach `data/release-cache.json`.

`release-cache.json` enthaelt keine Nutzerdaten, keine JSONBin-Konfiguration und keine Secrets. Die Action committed nur `data/release-cache.json`, wenn sich diese Datei wirklich geaendert hat.

## Phase 5: Auto-Cover aus Release-Cache

Unter `Serien` kann bei einer Serie `Cover pruefen` gewaehlt werden. Die App nutzt dafuer ausschliesslich `./data/release-cache.json`; es gibt keine Live-Webscraper, keine Publisher-Requests und keine Manga-Passion-Abfragen aus der Web-App.

Cover werden nur als Vorschau angezeigt und erst nach Auswahl einzelner Baende mit `Ausgewaehlte Cover uebernehmen` gespeichert. Matching erfolgt ueber ISBN-13, Edition-Fingerprint oder `publisher + seriesTitle + volumeNumber + editionType`. Unterschiedliche Editionen werden nicht zusammengefuehrt.

Vorschlaege gelten nur bei vorhandener `coverUrl`, `confidence >= 70`, passendem Publisher und passender Edition. Manuell gesetzte Cover (`coverManuallySet`) werden nie ersetzt. Bestehende Auto-Cover werden nur ersetzt, wenn die neue Cover-Confidence hoeher ist. `owned`, `read`, `boughtAt`, `readAt` und `releaseDate` bleiben unveraendert.

## Smoke-Test-Plan

Nach dem Deployment auf GitHub Pages:

1. Seite unter `https://sharkonek.github.io/manga-tracker/` oeffnen.
2. Pruefen, dass Layout und Tabs ohne Konsolenfehler laden.
3. Neue Serie anlegen und speichern.
4. Neuen Band zur Serie anlegen und speichern.
5. Sammlung/Kaufen/Kalender pruefen und Statusaktionen ausfuehren.
6. JSON Export herunterladen.
7. JSON Import mit dem exportierten File testen.
8. App neu laden und pruefen, dass Daten aus `localStorage` erhalten bleiben.
9. JSONBin Sync aktivieren mit Test-Bin-ID und eingeschraenktem `X-Access-Key`.
10. "Jetzt in Cloud speichern" ausfuehren und erfolgreichen Status pruefen.
11. In einem zweiten Browser/Profil dieselbe Bin-ID und denselben Key eintragen.
12. "Jetzt synchronisieren" ausfuehren und pruefen, dass Cloud-Daten geladen werden.
13. Offline/Netzwerkfehler simulieren und pruefen, dass lokale Speicherung weiter funktioniert.
14. Sicherstellen, dass keine echten JSONBin Keys im Repository oder in GitHub Pages HTML/JS stehen.

## Lokale Nutzung

`index.html` kann direkt im Browser geoeffnet oder ueber einen beliebigen statischen Webserver ausgeliefert werden.
