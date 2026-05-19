# Phase 24 - Release-Cache Manual Source Review Queue

Stand: 2026-05-19

Phase 24 fuehrt einen kontrollierten Review-Workflow fuer die verbleibenden 34 `source-data-gap`-Luecken ein. Ziel ist nicht, die Luecken automatisch zu schliessen, sondern jede fehlende Release-Information nachvollziehbar zu pruefen und erst danach als patchbar zu markieren.

Wichtig: `data/release-cache.json` bleibt in dieser Phase unangetastet. Es werden keine Release-Daten geraten und keine Platzhalterdaten in den Cache uebernommen.

## Dateien

| Datei | Zweck |
|---|---|
| `docs/release-cache-source-gap-analysis.md` | Maschinenlesbare Phase-23-Analyse der 34 bekannten Source-Gaps. |
| `data/release-source-review-queue.json` | Arbeitsliste fuer die manuelle Quellenpruefung. |
| `scripts/write-release-source-review-queue.js` | Erzeugt/aktualisiert die Queue aus der Analyse und erhaelt manuelle Review-Felder. |
| `scripts/validate-release-source-review-queue.js` | Validiert Schema, Vollstaendigkeit und Patch-Sicherheitsregeln. |

## Review-Prozess

1. Queue aktualisieren:

   ```bash
   node scripts/write-release-source-review-queue.js
   ```

2. Einen Queue-Eintrag in `data/release-source-review-queue.json` auswaehlen.
3. Die Serie, den Verlag und die Bandnummer gegen erlaubte Quellen pruefen.
4. Nur wenn ein echtes, verifizierbares Release-Datum gefunden wurde, die manuellen Review-Felder pflegen:
   - `sourceUrl`: konkrete URL zur Quelle
   - `releaseDate`: echtes Datum im Format `YYYY-MM-DD`
   - `checkedAt`: Pruefdatum im Format `YYYY-MM-DD` oder ISO-Zeitstempel
   - `evidence`: kurze Belegnotiz, die beschreibt, was die Quelle bestaetigt
   - `notes`: optionale Zusatznotizen, z. B. Editions-/Publisher-Hinweis
   - `reviewStatus`: `ready-to-patch`, wenn der Eintrag fuer einen spaeteren Cache-Patch bereit ist
   - `safeToPatch`: erst dann `true`, wenn alle Bedingungen unten erfuellt sind
5. Queue validieren:

   ```bash
   node scripts/validate-release-source-review-queue.js
   ```

6. Ein spaeterer Patch darf nur Eintraege uebernehmen, die validiert `safeToPatch: true` sind. Dieser spaetere Patch ist nicht Teil von Phase 24.

## Erlaubte Quellen

Erlaubt sind nur nachvollziehbare, oeffentliche Quellen, die die konkrete Ausgabe/Bandnummer belegen:

1. Offizielle Verlagsseiten oder offizielle Verlags-Shops.
2. Bereits im Projekt erlaubte vertrauenswuerdige Release-Quellen, z. B. Manga Passion, wenn die Edition und Bandnummer eindeutig passen.
3. Offizielle Distributor-/ISBN-/Buchhandelsdaten nur als Zusatzbeleg, wenn sie Titel, Verlag/Imprint, Bandnummer und Datum eindeutig abgleichen lassen.

Nicht ausreichend sind:

- Schaetzungen aus Reihenfolge, Rhythmus oder Nachbarbaenden.
- Platzhalterdaten oder Dummy-Daten.
- Unbelegte Foren-/Social-Media-Aussagen.
- Quellen, die eine andere Edition, ein anderes Format oder eine abweichende Bandzaehlung zeigen, solange die Abweichung nicht in `notes` nachvollziehbar geklaert ist.

## Wann `safeToPatch: true` erlaubt ist

Ein Eintrag darf nur dann auf `safeToPatch: true` gesetzt werden, wenn alle folgenden Bedingungen erfuellt sind:

- `sourceUrl` ist gesetzt und verweist auf eine konkrete erlaubte Quelle.
- `releaseDate` ist gesetzt, echt und im Format `YYYY-MM-DD`.
- `checkedAt` ist gesetzt.
- `evidence` ist gesetzt und beschreibt den Beleg knapp, aber nachvollziehbar.
- Serie, Verlag/Imprint, Edition und Bandnummer stimmen mit dem Queue-Eintrag ueberein oder Abweichungen sind in `notes` erklaert.
- `reviewStatus` ist `ready-to-patch` (oder nach einem spaeteren Cache-Patch `patched`).

Der Validator erzwingt diese Mindestbedingungen. `safeToPatch: true` ohne Quelle, Datum, Pruefzeitpunkt und Evidenz ist ungueltig.

## Ungueltige Platzhalterdaten

Platzhalterdaten sind keine Release-Daten. Insbesondere `2999-12-31` ist ungueltig und darf weder in der Queue als geprueftes `releaseDate` noch spaeter im Cache verwendet werden.

Die Queue darf fuer ungepruefte Eintraege `releaseDate: null` enthalten. Das ist korrekt und bedeutet: Es wurde noch kein echtes Datum gefunden.

## Grenzen dieser Phase

- Keine Aenderung an `data/release-cache.json`.
- Kein automatisches Scraping neuer Quellen.
- Keine geratenen Release-Daten.
- Keine App-UI.
- Keine Supabase-Aenderung.
- Keine privaten Nutzerdaten.

Phase 24 erstellt nur den Review-Rahmen. Die eigentlichen Cache-Patches muessen in einer spaeteren Phase separat und anhand validierter Queue-Eintraege erfolgen.
