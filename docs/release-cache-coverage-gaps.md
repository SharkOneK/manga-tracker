# Phase 22c - Klassifizierung verbleibender Release-Cache-Coverage-Luecken

Stand: nach Bot-Commit `d909f57` (`release-cache.json` aktualisiert).

## Zusammenfassung

| Kennzahl | Wert |
|---|---:|
| Aktivierte Watchlist-Eintraege | 32 |
| Expandierte Watchlist-Bandkandidaten | 186 |
| Release-Cache-Eintraege | 170 |
| Gefundene Cache-Eintraege | 152 |
| Verbleibende Luecken | 34 |
| Betroffene Serien | 12 |
| Betroffene Verlage | 8 |

## Klassifikation

Alle 34 verbleibenden Luecken sind als `source-data-gap` klassifiziert.

Bedeutung: Der Watchlist-Band wurde nach dem Cache-Update weiterhin nicht in `data/release-cache.json` gefunden. Diese Faelle sind Quellen-/Datenqualitaetsfaelle und duerfen nicht durch Fake-Daten geschlossen werden.

Empfohlener Umgang: manuell in verlaesslicher Quelle pruefen, erst danach echte Release-Daten ergaenzen. Wenn keine Quelle einen belastbaren Treffer liefert, bleibt die Luecke sichtbar.

## Luecken nach Serie

| Serie | Verlag | Fehlende Baende | Anzahl | Klassifikation |
|---|---|---:|---:|---|
| Vermeil in Gold | Manga Cult | 2 | 1 | source-data-gap |
| Meine Chefin kommt immer zuerst!! | MangaMoon | 2 | 1 | source-data-gap |
| Vagabond - Master Edition | Egmont Manga | 13-19 | 7 | source-data-gap |
| Adou | Altraverse | 12 | 1 | source-data-gap |
| Arifureta: Der Kampf zurueck in meine Welt - Zero | Altraverse | 4-8 | 5 | source-data-gap |
| Berserk Master Edition | Panini Manga | 7-14 | 8 | source-data-gap |
| Chainsaw Man | Egmont Manga | 23 | 1 | source-data-gap |
| Gushing over Magical Girls | MangaMoon | 4 | 1 | source-data-gap |
| Isekai Soapland | MANGAMOON | 3-8 | 6 | source-data-gap |
| Mirai Nikki - New Edition | Egmont Manga | 6 | 1 | source-data-gap |
| Neck mich nicht, Nagatoro-san | dani books | 6 | 1 | source-data-gap |
| Tokyo Revengers - Doppelband-Edition | Carlsen Manga | 16 | 1 | source-data-gap |

## Luecken nach Verlag

| Verlag | Luecken | Serien |
|---|---:|---:|
| Egmont Manga | 9 | 3 |
| Panini Manga | 8 | 1 |
| Altraverse | 6 | 2 |
| MANGAMOON | 6 | 1 |
| MangaMoon | 2 | 2 |
| Carlsen Manga | 1 | 1 |
| dani books | 1 | 1 |
| Manga Cult | 1 | 1 |

## Maschinenlesbarer Audit

Der Audit kann die gleiche Klassifizierung als JSON ausgeben:

```bash
node scripts/audit-release-cache-coverage.js --json
```

Relevante Felder: `summary`, `missingBySeries`, `missingByPublisher`, `missing`.

Der CI-/Docs-Validator prueft, dass dieser dokumentierte Stand zum JSON-Audit passt:

```bash
node scripts/validate-release-cache-coverage-gaps.js
```

## Phase 22e: CI-Artefakt und Verlauf

Jeder CI-Lauf schreibt den aktuellen Coverage-Gap-Zustand als JSON-Artefakt:

```bash
node scripts/write-release-cache-coverage-report.js
```

Standardausgabe: `artifacts/release-cache-coverage-report.json` (nur CI-/lokales Artefakt, keine Release-Datenquelle).

Das Artefakt enthaelt:

- aktuelle Anzahl der Coverage-Gaps, betroffenen Serien und Verlage
- betroffene Serien inklusive fehlender Baende
- betroffene Verlage inklusive Serienliste
- Vergleich gegen diesen dokumentierten Stand
- `newGaps` fuer neu hinzugekommene Luecken
- `resolvedGaps` fuer verschwundene Luecken
- Privacy-Marker: keine privaten Sammlungsdaten und keine neuen Release-Daten

Der normale Workflow scheitert weiterhin nicht an bekannten `source-data-gap`-Luecken. Drift gegen diese Dokumentation wird aber im Validator sichtbar, damit die Dokumentation bewusst aktualisiert werden kann.

### Phase 22f: GitHub-Actions-Summary

Der CI-Lauf rendert den Artefakt-Report zusaetzlich direkt in die GitHub-Actions-Summary:

```bash
node scripts/write-release-cache-coverage-summary.js
```

Die Summary zeigt ohne Artefakt-Download:

- aktuelle Coverage-Luecken
- betroffene Serien und Verlage
- neue und verschwundene Gaps
- Synchronitaet mit diesem dokumentierten Stand
- Klassifizierung `source-data-gap`
- Hinweis, dass keine Fake-Daten und keine privaten Sammlungsdaten erzeugt wurden
- Verweis auf das Artefakt `release-cache-coverage-report`

## Datenschutz

- Keine privaten Sammlungsstaende enthalten.
- Keine neuen Release-Daten ergaenzt.
- Keine manuellen oder geratenen Cache-Eintraege erzeugt.
- Audit bleibt ohne `--strict` im Warnmodus mit Exit 0.