# Release-Cache-Dokumentation

## Überblick

Der Release-Cache (`data/release-cache.json`) enthält vorberechnete Release-Informationen für Manga-Serien. Die App liest diese Datei read-only. Nutzerdaten werden nicht automatisch verändert.

## Phase 22: Sammlungsweite Release-Cache-Coverage

### Problem

Einzelne Bände einer Sammlung können im Release-Cache fehlen, wenn sie nicht durch App-Seeds oder Watchlist-Einträge abgedeckt sind. Bisher mussten fehlende Bände manuell als Einzel-Hotfixes ergänzt werden.

### Lösung

Phase 22 führt einen sammlungsweiten Coverage-Report ein:

1. Die App analysiert die lokale Sammlung und vergleicht jeden fehlenden Band gegen den Release-Cache.
2. Bände ohne Cache-Eintrag werden als Kandidaten gelistet.
3. Der Nutzer kann einen kopierbaren Watchlist-Batch generieren.
4. Der Batch wird manuell in `data/release-watchlist.json` eingefügt.
5. Der CI-Workflow verarbeitet die Watchlist und aktualisiert den Cache.

### Sicherheitsprinzipien

- **Keine automatischen Schreibvorgänge**: Die Browser-App schreibt niemals in `release-watchlist.json` oder `release-cache.json`.
- **Kein Supabase-Write**: Der Coverage-Report führt keinen Cloud-Write durch.
- **Keine neuen externen Dependencies**: Rein client-seitige Logik.
- **Explizite Nutzeraktion erforderlich**: Der Nutzer muss den Batch kopieren und manuell in die Watchlist einfügen.

### Flow

```
App-Dashboard
  → "Coverage prüfen" → Vorschau der fehlenden Bände
  → "Watchlist-Batch kopieren" → JSON in Clipboard
      ↓ (manuell)
  data/release-watchlist.json ergänzen
      ↓ (CI-Workflow)
  node scripts/validate-release-watchlist.js
  node scripts/update-release-cache.js
  node scripts/audit-release-cache-coverage.js
      ↓
  data/release-cache.json aktualisiert
```

## Watchlist-Schema

`data/release-watchlist.json` unterstützt ab Phase 22 zwei Formate:

### Einzelband (`volumeNumber`)

```json
{
  "seriesTitle": "Vermeil in Gold",
  "publisher": "Manga Cult",
  "volumeNumber": 2,
  "sourceUrl": null,
  "notes": "Aus App-Cache-Miss ergänzt.",
  "enabled": true
}
```

### Mehrband (`volumeNumbers`)

```json
{
  "seriesTitle": "Vagabond – Master Edition",
  "publisher": "Egmont Manga",
  "volumeNumbers": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  "sourceUrl": null,
  "notes": "Aus App-Coverage-Report ergänzt. Sammlungsstand: 7/19.",
  "enabled": true
}
```

**Regeln:**
- Entweder `volumeNumber` ODER `volumeNumbers` – nicht beide gleichzeitig.
- `volumeNumbers` muss ein nicht-leeres Array positiver Integer ohne Duplikate sein.
- Duplikate werden auch über Formate hinweg erkannt (z. B. `volumeNumber: 10` und `volumeNumbers: [8, 9, 10]` für die gleiche Serie ist ein Duplikat).

## Vagabond-Beispiel

Sammlungsstand: 7 von 19 Bänden besessen (Bände 1–7).
Fehlende Bände: 8–19 (12 Bände).
Watchlist-Batch vom Coverage-Report:

```json
{
  "seriesTitle": "Vagabond – Master Edition",
  "publisher": "Egmont Manga",
  "volumeNumbers": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  "sourceUrl": null,
  "notes": "Aus App-Coverage-Report ergänzt. Sammlungsstand: 7/19.",
  "enabled": true
}
```

Der Update-Script expandiert diesen Eintrag zu 12 einzelnen Kandidaten, die dann gegen die Manga-Passion-API geprüft werden.

## Skripte

| Skript | Funktion |
|--------|----------|
| `scripts/validate-release-watchlist.js` | Validiert Schema inkl. `volumeNumbers` |
| `scripts/update-release-cache.js` | Expandiert `volumeNumbers` zu Einzelkandidaten |
| `scripts/audit-release-cache-coverage.js` | Prüft Coverage pro Band (auch `volumeNumbers`) |

## Audit-Modi

```bash
# Warnmodus (Exit 0 auch bei fehlenden Einträgen)
node scripts/audit-release-cache-coverage.js

# Strict-Modus (Exit 1 wenn Einträge fehlen)
node scripts/audit-release-cache-coverage.js --strict
```

## Private Sammlungsdaten

Die lokale Sammlung des Nutzers (welche Bände besessen werden) ist **nicht** in diesem Repository gespeichert. Der Coverage-Report liest die lokale Sammlung nur zur Laufzeit im Browser. Nur aggregierte Watchlist-Einträge (Serientitel, Verlag, Bandnummern) landen in `release-watchlist.json` – ohne persönliche Daten wie Besitzstatus, Kaufdatum oder Lesestatus.
