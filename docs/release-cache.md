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

## Phase 22a: Sanitierter Coverage-Batch

Phase 22a übernimmt den aus Phase 22 erzeugten Coverage-Batch sicher in `data/release-watchlist.json`.

### Warum private Sammlungsstände nie committet werden

`buildReleaseCacheCoverageReport()` hatte ursprünglich `Sammlungsstand: x/y` im `notes`-Feld (z. B. "7 von 19 Bänden besessen"). **Diese Information ist privat und darf nie öffentlich committet werden:**

1. `release-watchlist.json` liegt in einem öffentlichen Repository.
2. Besitzstatus (wie viele Bände man hat) sind persönliche Daten.
3. Das Watchlist-Schema hat absichtlich kein Ownership-Feld.

Ab Phase 22a lautet das `notes`-Feld immer nur `"Aus App-Coverage-Report ergänzt."` – ohne Sammlungsstand.

### Importierter Batch (Phase 22a)

29 neue Einträge wurden in `release-watchlist.json` ergänzt, darunter:
Adou, Arifureta Zero, August 9th, Berserk ME, Blood Blade, Brynhildr, Chainsaw Man, Dai Dark, Demon King of God Killing, Die letzte Elfe, Fairy Tail, From the Red Fog, Gushing over Magical Girls, Isekai Soapland, Jujutsu Kaisen, Kaiju No.8, Kijin Gentosho, Lili-Men, Maria's Judgement, Mirai Nikki NE, Mujina into the Deep, Nagatoro-san, Real Account, Reincarnated as a Sword: AW, Spy x Family, Tokyo Revengers DBE, Witch and Hound, Yakuza Reincarnation, Yandere Dark Elf.

Nicht eingeschlossen (bereits vollständig durch Cache abgedeckt): Colorless, Kagurabachi, Dandadan, The Eminence in Shadow.

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
  "notes": "Aus App-Coverage-Report ergänzt.",
  "enabled": true
}
```

**Regeln:**
- Entweder `volumeNumber` ODER `volumeNumbers` – nicht beide gleichzeitig.
- `volumeNumbers` muss ein nicht-leeres Array positiver Integer ohne Duplikate sein.
- Duplikate werden auch über Formate hinweg erkannt (z. B. `volumeNumber: 10` und `volumeNumbers: [8, 9, 10]` für die gleiche Serie ist ein Duplikat).

## Vagabond-Beispiel

Fehlende Bände: 8–19 (12 Bände).
Watchlist-Batch vom Coverage-Report:

```json
{
  "seriesTitle": "Vagabond – Master Edition",
  "publisher": "Egmont Manga",
  "volumeNumbers": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  "sourceUrl": null,
  "notes": "Aus App-Coverage-Report ergänzt.",
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

# Maschinenlesbarer JSON-Report fuer Klassifizierung/CI-Auswertung
node scripts/audit-release-cache-coverage.js --json
```

## Phase 22c: Verbleibende Coverage-Luecken

Die nach dem Bot-Update verbleibenden 34 Luecken sind in `docs/release-cache-coverage-gaps.md` als `source-data-gap` klassifiziert. Sie sind keine App-Fehler mehr, sondern Quellen-/Datenqualitaetsfaelle. Es werden dafuer keine Fake-Daten und keine geratenen Release-Daten ergaenzt.

Phase 22d stabilisiert diesen Stand fuer CI und Dokumentation. Phase 22e schreibt zusaetzlich pro CI-Lauf ein JSON-Artefakt, das aktuelle, neue und verschwundene Gaps gegen den dokumentierten Stand vergleichbar macht. Phase 22f rendert diesen Stand direkt in die GitHub-Actions-Summary, damit der Status ohne Artefakt-Download sichtbar ist:

```bash
node scripts/validate-release-cache-coverage-gaps.js

# CI-/Artefakt-Report mit Verlauf gegen docs/release-cache-coverage-gaps.md
node scripts/write-release-cache-coverage-report.js

# GitHub-Actions-Summary aus dem Artefakt-Report rendern
node scripts/write-release-cache-coverage-summary.js
```

## Private Sammlungsdaten

Die lokale Sammlung des Nutzers (welche Bände besessen werden) ist **nicht** in diesem Repository gespeichert. Der Coverage-Report liest die lokale Sammlung nur zur Laufzeit im Browser. Nur aggregierte Watchlist-Einträge (Serientitel, Verlag, Bandnummern) landen in `release-watchlist.json` – ohne persönliche Daten wie Besitzstatus, Kaufdatum oder Lesestatus.

Ab Phase 22a gilt: Das `notes`-Feld enthält ausschließlich `"Aus App-Coverage-Report ergänzt."` – kein `Sammlungsstand`, kein Ownership-Zähler, keine Leseinformation.
