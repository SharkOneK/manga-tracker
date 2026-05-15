# Manga Tracker

Statische Browser-App zum Verwalten physischer Manga-Ausgaben.

## Architektur (ab Phase 10)

**Supabase ist die führende Datenquelle.**

- Supabase = Source of Truth
- localStorage = Cache und Backup
- Ohne Login ist Bearbeitung blockiert (Read-only)
- Änderungen werden automatisch in Supabase gespeichert (Auto-Save, 3 Sekunden Debounce)
- Beim Start werden Cloud-Daten geladen
- JSONBin wurde entfernt. Bestehende JSONBin-Daten im Browser werden ignoriert

## Projektstruktur

```text
.
|-- index.html
|-- src
|   |-- app.js
|   `-- styles.css
|-- supabase
|   `-- migrations
`-- data
    |-- release-sources.json
    `-- release-cache.json
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

## Supabase Cloud-Sync

### Ersteinrichtung

1. Neues Supabase-Projekt erstellen.
2. Authentication > Providers > Email aktiv lassen.
3. Authentication > URL Configuration setzen:
   - Site URL: `https://sharkonek.github.io/manga-tracker/`
   - Redirect URL: `https://sharkonek.github.io/manga-tracker/`
   - Fuer lokale Tests optional zusaetzlich die lokale URL eintragen, z. B. `http://localhost:8000/`.
4. SQL-Migrationen aus `supabase/migrations` im Supabase SQL Editor oder per Supabase MCP/CLI anwenden.
5. Settings > API Keys oeffnen und nur die **Project URL** und den **Public/Anon Key** in der App unter `Einstellungen > Supabase Cloud-Sync` eintragen.

**Niemals** einen `service_role` Key in der Browser-App eintragen. Dieser Key gehoert nicht in GitHub Pages, `localStorage`, Screenshots oder Commits.

### Datenmodell

- Tabelle: `public.manga_tracker_databases`
- Ein Datensatz pro angemeldetem Supabase-User
- Spalte `database` enthaelt die komplette Manga-Tracker-Datenbank mit `series` und `volumes`
- Row Level Security ist aktiv
- `authenticated` darf per RLS nur den eigenen Datensatz lesen, einfuegen, aktualisieren und loeschen
- `anon` hat keine Tabellenrechte fuer Nutzerdaten

### App-Modi

| Modus | Zustand | Bearbeitung |
|-------|---------|-------------|
| `cloud` | Angemeldet, Cloud-Daten geladen | Vollständig, Auto-Save aktiv |
| `readonly` | Nicht angemeldet oder Cloud leer mit lokalen Daten | Blockiert, letzter Cache sichtbar |
| `setup` | Supabase nicht konfiguriert | Blockiert, Einstellungen-Hinweis |
| `offline` | Supabase nicht erreichbar | Blockiert, letzter Cache sichtbar |
| `loading` | Startet / lädt Cloud-Daten | Übergang |

### Auto-Save

Änderungen werden automatisch nach **3 Sekunden** in Supabase gespeichert (Debounce). Der Header zeigt den aktuellen Status:

- `Gespeichert` — Cloud ist aktuell
- `Speichern läuft…` — Upload läuft
- `Nicht gespeichert ⚠` — Upload fehlgeschlagen (Schaltfläche "Erneut speichern" erscheint in Einstellungen)

### Erster Start nach Login

Wenn noch keine Cloud-Daten in Supabase vorhanden sind, aber lokale Daten existieren, erscheint ein Dialog:

1. **Lokale Daten nach Supabase übernehmen** — erstellt Backup, lädt lokale Daten hoch
2. **Nur ansehen (kein Upload)** — letzter lokaler Cache read-only sichtbar, kein Upload
3. **Abbrechen** — wie Option 2, Dialog erneut nach Ab- und Wiederanmeldung

### Aktionen in den Einstellungen

- **Supabase-Einstellungen speichern** — speichert Konfiguration und stellt Verbindung her
- **Login-Link senden** — Magic Link an eingetragene E-Mail
- **Logout** — abmelden, App wechselt in Read-only-Modus
- **Jetzt speichern** — sofortiger manueller Upload zum Cloud
- **Cloud-Daten neu laden** — lädt Cloud-Stand und ersetzt lokalen Arbeitsspeicher (erstellt Backup)
- **Cloud-Status prüfen** — vergleicht Zeitstempel, verändert keine Daten

### Konflikte

Wenn lokaler Stand und Cloud-Stand unterschiedliche Zeitstempel haben, zeigt die App ein Konfliktpanel:

1. `Lokale Daten behalten und Cloud überschreiben`
2. `Cloud laden und lokales Backup behalten`
3. `Abbrechen`

Bei Abbrechen werden keine Manga-Daten verändert.

### Mehrgerätenutzung

1. Gerät A: anmelden → Cloud-Daten werden beim Start automatisch geladen
2. Gerät A: Daten ändern → Auto-Save pusht nach 3 Sekunden
3. Gerät B: anmelden → Cloud-Daten werden beim Start automatisch geladen, Gerät-A-Daten sind sofort sichtbar

### Supabase-Ausfall

Wenn Supabase beim Start nicht erreichbar ist:

- App zeigt den letzten lokalen Cache (read-only)
- Bearbeitung ist deaktiviert
- Banner: "Supabase nicht erreichbar — letzter Cache wird angezeigt"
- Beim nächsten App-Neustart wird der Verbindungsversuch wiederholt

### Backup und Restore

**Backup:** Vor jedem Cloud-Pull, Import und Migration wird automatisch ein Backup in `localStorage` angelegt.

**Export:** Im Tab `Import/Export` → `JSON Export` lädt den aktuellen Cloud-Stand als Datei herunter.

**Import:** Im Tab `Import/Export` → JSON-Datei auswählen. Nach Validierung wird die Datenbank lokal geladen und bei aktivem Cloud-Modus automatisch nach Supabase gespeichert.

**Restore:** JSON-Datei importieren (erstellt automatisch Backup des vorherigen Stands).

## Phase 10 Smoke-Test-Checkliste

Manuell nach Deployment prüfen:

1. App ohne Supabase-Konfiguration öffnen → Banner "Supabase noch nicht eingerichtet" erscheint
2. Supabase URL und Public Key eintragen, speichern → Status wechselt
3. Ohne Login → Banner "Nicht angemeldet" erscheint, Bearbeitung blockiert
4. Login-Link senden → Magic Link aus E-Mail öffnen
5. Nach Rückkehr zur App: Anmeldestatus, E-Mail/User-ID korrekt angezeigt
6. Cloud-Daten werden geladen, Status wechselt auf "Gespeichert"
7. Lokaler Cache wird mit Cloud-Daten aktualisiert
8. Kleine Änderung machen → Status wechselt auf "Speichern läuft…" → dann "Gespeichert"
9. Seite neu laden → Änderung kommt aus Supabase zurück
10. Zweites Gerät/Inkognito: Gleiche Konfiguration, anmelden → selber Cloud-Stand erscheint
11. "Cloud-Daten neu laden" → Backup-Meldung erscheint, Cloud-Stand wird geladen
12. JSON-Import → Backup wird angelegt, Daten werden nach Supabase gespeichert
13. JSON-Export → Datei mit aktuellem Cloud-Stand wird heruntergeladen
14. Obsidian-Export → Funktioniert mit aktuellem Stand
15. Kein JSONBin-Bereich mehr sichtbar in Einstellungen
16. Keine JSONBin-Logs in Browser-Konsole
17. Konflikt-Test: Zwei Geräte, verschiedene Stände → Konfliktpanel erscheint, kein automatisches Überschreiben
18. Supabase-Ausfall simulieren (Netzwerk offline) → Banner "nicht erreichbar", Bearbeitung blockiert

## Phase 11 UI-Smoke-Test-Checkliste

Manuell im Browser prüfen (Desktop und Mobile-Viewport):

1. App öffnet ohne Console-Fehler — `index.html`, `src/styles.css`, `src/app.js` laden mit HTTP 200.
2. Ohne Konfiguration: gelber Setup-Banner sichtbar, Bearbeitung blockiert.
3. Ohne Login: gelber Read-only-Banner sichtbar, Cloud-Statuspill zeigt „Read-only".
4. Login funktioniert, App-Modus wechselt auf `cloud`, Statuspill zeigt grün „Cloud gespeichert".
5. Auto-Save sichtbar: Statuspill wechselt sichtbar zwischen „Speichern läuft…" (blau, pulsierend) und „Cloud gespeichert" (grün).
6. Bei Fehler: Statuspill wechselt auf roten „Nicht gespeichert" und der Retry-Button erscheint in Einstellungen.
7. Tab-Navigation: aktiver Tab visuell deutlich (Akzent-Hintergrund + Text), Hover/Focus sichtbar, Tastatur-Tab funktioniert.
8. Dashboard: Stat-Cards zeigen große Zahlen, Insights-Cards (Top Verlag, Bände pro Verlag, Editionen) lesbar, Bar-Listen ohne Überlauf.
9. Serien-Tab: Status- und Sammlungsstatus erscheinen als farbige Status-Pills (gelesen=grün, am Lesen=blau, geplant=violett, fehlt/kaufbar=gelb).
10. Band-Tabelle: Gekauft/offen und gelesen/ungelesen sind klar farbcodiert; Badges (Vorbestellbar, Jetzt kaufbar, Release verschoben) haben passende Variante.
11. Sammlung & Kaufen: Karten mit Cover-Vorschau, gleichmäßige Abstände, Empty States lesbar.
12. Einstellungen: Sektionen klar getrennt (Datenbank-Übersicht, Release-Daten, Supabase Cloud-Sync). Verbindung/Sync/Konfiguration als Sub-Header.
13. Service-Role-Warnung als rot umrandete Box im Supabase-Bereich sichtbar.
14. Import/Export-Tab: drei Karten (JSON Export, JSON Import, Obsidian Export) erkennbar und bedienbar.
15. Kein JSONBin-Bereich, keine JSONBin-Logs in der Konsole.
16. Formulare: Inputs und Selects haben Focus-Ring, Checkboxen sind als Custom-Boxen mit Häkchen sichtbar.
17. Mobile (≤ 480 px): Karten stapeln in einer Spalte, Tabs scrollen horizontal, Buttons strecken über die volle Breite.
18. Keine horizontalen Scrollbalken auf 320/375/414 px breiten Viewports.
19. Modal-Dialog beim ersten Cloud-Login: zentriert, abgedunkelter Hintergrund, deutlich lesbar.
20. Alle Buttons bleiben klickbar; `data-action`-Handler für Serien, Bände, Cover-Prüfung und Supabase-Aktionen funktionieren wie vorher.

## Phase 4b PoC: Manga-Passion-JSON

Release-Daten und Cover werden im PoC nur über eine manuelle JSON-Datei pro Serie geprüft. Es gibt keinen direkten Browser-Fetch auf Manga Passion, keinen Proxy, keine GitHub Action und kein Massenupdate.

Unter `Serien` kann bei einer Serie `Release-Daten prüfen` gewählt werden. Die Datei sollte eine `volumes`-Liste enthalten:

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

Die App zeigt nur eine Vorschau. Übernommen wird erst nach Auswahl einzelner Felder und Klick auf `Ausgewählte übernehmen`. `owned`, `read`, `boughtAt` und `readAt` werden nie geändert. Manuell gesetzte Cover (`coverManuallySet`) werden nicht ersetzt.

## Phase 4c PoC: Release-Cache per GitHub Action

Die Datei `data/release-sources.json` enthält eine manuell gepflegte, kuratierte Liste von Manga-Passion-Quellen. Es wird nicht frei gecrawlt.

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

Der Workflow `Update release cache` läuft nur manuell per `workflow_dispatch`. Das Script `scripts/update-release-cache.js` ruft die kuratierten Manga-Passion-Seiten serverseitig ab, wartet zwischen Requests und schreibt öffentliche Release-Daten nach `data/release-cache.json`.

`release-cache.json` enthält keine Nutzerdaten und keine Secrets.

## Phase 5: Auto-Cover aus Release-Cache

Unter `Serien` kann bei einer Serie `Cover prüfen` gewählt werden. Die App nutzt dafür ausschließlich `./data/release-cache.json`; es gibt keine Live-Webscraper, keine Publisher-Requests und keine Manga-Passion-Abfragen aus der Web-App.

Cover werden nur als Vorschau angezeigt und erst nach Auswahl einzelner Bände mit `Ausgewählte Cover übernehmen` gespeichert.

## Sicherheitshinweise

- Niemals `service_role` Key in der App, in Commits oder Screenshots
- Public/Anon Key ist clientseitig sichtbar — das ist by Design (RLS schützt die Daten)
- Alle Nutzerdaten werden per Row Level Security geschützt: Jeder Nutzer sieht nur seinen eigenen Datensatz
- Tokens werden nicht im Code gespeichert; Supabase verwaltet Sessions intern
