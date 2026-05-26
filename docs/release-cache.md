# Release-Cache-Dokumentation

> **Phase 38 – Hinweis zum Serienstatus:** Das Feld `ongoing` einer Serie beschreibt
> seit Phase 38 ausschließlich den Stand der **deutschsprachigen** Veröffentlichung,
> nicht den japanischen/originalen Status. Details siehe
> [`german-publication-status-audit.md`](./german-publication-status-audit.md).

## Überblick

Der Release-Cache (`data/release-cache.json`) enthält vorberechnete Release-Informationen für Manga-Serien. Die App liest diese Datei read-only. Nutzerdaten werden nicht automatisch verändert.

## Phase 22: Sammlungsweite Release-Cache-Coverage

### Problem

Einzelne Bände einer Sammlung können im Release-Cache fehlen, wenn sie nicht durch App-Seeds oder Watchlist-Einträge abgedeckt sind. Bisher mussten fehlende Bände manuell als Einzel-Hotfixes ergänzt werden.

### Lösung

Phase 22 führte einen sammlungsweiten Coverage-Report ein. Seit Phase 25/26 ist er im Browser vor allem Diagnose:

1. Die App analysiert die lokale Sammlung und vergleicht jeden fehlenden Band gegen den Release-Cache.
2. Bände ohne Cache-Eintrag werden als Kandidaten gelistet.
3. Das Dashboard zeigt die Lücken lokal an.
4. Bekannte Watchlist- und Review-Queue-Fälle werden durch die automatische GitHub-Action/Pipeline verarbeitet.
5. Manuelles Kopieren ist nur noch Diagnose-/Legacy-Fallback, nicht der normale Hauptprozess.

### Sicherheitsprinzipien

- **Keine automatischen Schreibvorgänge**: Die Browser-App schreibt niemals in `release-watchlist.json` oder `release-cache.json`.
- **Kein Supabase-Write**: Der Coverage-Report führt keinen Cloud-Write durch.
- **Keine neuen externen Dependencies**: Rein client-seitige Logik.
- **Diagnose statt Normalprozess**: Die lokale UI zeigt Coverage-Lücken, empfiehlt aber kein manuelles Watchlist-Einfügen mehr als Hauptworkflow.

### Flow

```
Watchlist / Review-Queue (data/release-watchlist.json, data/release-source-review-queue.json)
      ↓
  GitHub Action „Update Release Cache"
      ↓
  node scripts/run-release-cache-pipeline.js
  node scripts/validate-release-cache-pipeline-report.js
      ↓
  PR mit sicheren Cache-Patches und Review-Queue-Diagnose
```

Phase-44a-followup-Hinweis: Der lokale Dashboard-Button „Cache-Coverage prüfen" und die zugehörigen Helfer (`buildReleaseCacheCoverageReport`, `copyReleaseCacheCoverageBatch`, `renderReleaseCacheCoveragePreview`) wurden entfernt. Source-Gaps werden ausschließlich über die Pipeline (Phase 25/32/42) und `data/release-watchlist.json` / `data/release-source-review-queue.json` gepflegt. Die lokale App zeigt seit Phase 43/44b nur noch Read-only-Werte aus dem zentralen Cache an.

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
Historisches Watchlist-Beispiel aus dem Coverage-Report:

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
| `scripts/update-release-cache.js` | Legacy-Updatepfad: expandiert `volumeNumbers` zu Einzelkandidaten |
| `scripts/audit-release-cache-coverage.js` | Prüft Coverage pro Band (auch `volumeNumbers`) |
| `scripts/write-release-source-review-queue.js` | Erzeugt die manuelle Source-Review-Queue aus der Phase-23-Analyse |
| `scripts/validate-release-source-review-queue.js` | Validiert die Source-Review-Queue und `safeToPatch`-Regeln |
| `scripts/release-confidence.js` | Zentrale Confidence-Regeln für automatische Quellenprüfung |
| `scripts/run-release-cache-pipeline.js` | Vollautomatische Phase-25-Pipeline für Cache, Queue und Report |
| `scripts/validate-release-cache-pipeline-report.js` | Validiert den Pipeline-Report und Cache-Patch-Sicherheitsregeln |

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

## Phase 23a: Source-Gap-Ursachenanalyse

Phase 23a reduziert nicht kuenstlich die Gap-Zahl, sondern dokumentiert die Ursache jeder einzelnen Luecke in `docs/release-cache-source-gap-analysis.md`.

Die Analyse ist maschinenlesbar validiert und haelt fest:

- alle 34 bekannten `source-data-gap`-Einzelluecken sind abgedeckt
- kein Eintrag enthaelt ein geratenes Release-Datum
- kein Eintrag ist ohne weitere Quellenpruefung als sicher patchbar markiert
- MangaMoon/MANGAMOON und Editions-/Bandnummern-Faelle sind als naechste manuelle Pruefschritte sichtbar

Der bestehende Coverage-Gap-Validator prueft die Analyse mit:

```bash
node scripts/validate-release-cache-coverage-gaps.js
```

## Phase 24: Manual Source Review Queue

Phase 24 schreibt die verbleibenden 34 `source-data-gap`-Faelle in `data/release-source-review-queue.json`. Die Queue ist eine kontrollierte Arbeitsliste fuer manuelle Quellenpruefung und kein Cache-Patch.

Die Regeln stehen in `docs/release-cache-manual-source-review.md`:

- `data/release-cache.json` bleibt in dieser Phase unveraendert.
- `safeToPatch: true` ist nur mit `sourceUrl`, echtem `releaseDate`, `checkedAt` und `evidence` erlaubt.
- Platzhalterdaten wie `2999-12-31` sind ungueltig.

```bash
node scripts/write-release-source-review-queue.js
node scripts/validate-release-source-review-queue.js
```

## Phase 25: Vollautomatische Release-Cache-Pipeline

Phase 24 hat die kontrollierte Source-Review-Queue eingeführt. Phase 25 automatisiert darauf aufbauend den Normalfall: Watchlist, bestehende Gaps und Review-Queue werden automatisch geprüft, sichere Treffer werden in den öffentlichen Cache übernommen, unsichere Treffer bleiben automatisch in der Queue.

Neue Artefakte und Regeln sind in `docs/release-cache-automation.md` dokumentiert.

Kernpunkte:

- `scripts/run-release-cache-pipeline.js` liest Watchlist, Review-Queue und bestehenden Cache.
- `scripts/release-confidence.js` entscheidet konservativ zwischen `high`, `medium`, `low` und `blocked`.
- Nur `high`-Confidence-Kandidaten dürfen als Cache-Patches in `data/release-cache.json` landen.
- `medium`, `low` und `blocked` werden mit automatischen Statuswerten in `data/release-source-review-queue.json` geschrieben.
- `data/release-cache-pipeline-report.json` dokumentiert jeden Pipeline-Lauf maschinenlesbar.
- `.github/workflows/update-release-cache.yml` erstellt bei Änderungen einen PR und pusht nicht direkt auf `main`.
- Auto-Merge ist optional und nur für reine High-Confidence-Cache-Patches ohne Queue-/Blocked-Fälle vorgesehen.

Validierung:

```bash
node scripts/run-release-cache-pipeline.js
node scripts/validate-release-cache-pipeline-report.js
node scripts/validate-release-cache.js
node scripts/validate-release-source-review-queue.js
```

Die Automatisierung ersetzt keine Quellen-Sorgfalt: Platzhalterdaten wie `2999-12-31`, Publisher-Konflikte, Editions-Konflikte und Bandnummern-Konflikte werden blockiert und nicht in den Cache geschrieben.
## Private Sammlungsdaten

Die lokale Sammlung des Nutzers (welche Bände besessen werden) ist **nicht** in diesem Repository gespeichert. Der Coverage-Report liest die lokale Sammlung nur zur Laufzeit im Browser. Nur aggregierte Watchlist-Einträge (Serientitel, Verlag, Bandnummern) landen in `release-watchlist.json` – ohne persönliche Daten wie Besitzstatus, Kaufdatum oder Lesestatus.

Ab Phase 22a gilt: Das `notes`-Feld enthält ausschließlich `"Aus App-Coverage-Report ergänzt."` – kein `Sammlungsstand`, kein Ownership-Zähler, keine Leseinformation.

## Phase 26: Provider-System und Dashboard-Aktionszentrale

Phase 26 kapselt Quellenzugriffe in `scripts/release-providers/` und verlegt globale Wartungsaktionen in die Dashboard-Aktionszentrale.

Neue Doku: `docs/release-provider-system.md`.

Kernpunkte:

- Manga Passion ist der erste aktive Release-Provider.
- `scripts/run-release-cache-pipeline.js` ruft Provider über `scripts/release-providers/index.js` auf.
- Die Confidence-Regeln aus `scripts/release-confidence.js` bleiben konservativ.
- Provider-Konflikte werden als `provider-conflict` blockiert.
- Der globale Cover-Sync liegt nicht mehr in der Suchleiste, sondern im Dashboard.
- Coverage- und Cache-Miss-Anzeigen sind lokale Diagnose/Fallback-Hilfe und kein manueller Normalprozess zum Einfügen in `release-watchlist.json`.
