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
