# Phase 22c - Klassifizierung verbleibender Release-Cache-Coverage-Luecken

Stand: automatisch synchronisiert aus aktuellem Audit gegen `data/release-watchlist.json` und `data/release-cache.json`.

## Zusammenfassung

| Kennzahl | Wert |
|---|---:|
| Aktivierte Watchlist-Eintraege | 58 |
| Expandierte Watchlist-Bandkandidaten | 212 |
| Release-Cache-Eintraege | 223 |
| Gefundene Cache-Eintraege | 185 |
| Verbleibende Luecken | 27 |
| Betroffene Serien | 10 |
| Betroffene Verlage | 8 |

## Klassifikation

Alle 27 verbleibenden Luecken sind als `source-data-gap` klassifiziert.

Bedeutung: Der Watchlist-Band wurde nach dem Cache-Update weiterhin nicht in `data/release-cache.json` gefunden. Diese Faelle sind Quellen-/Datenqualitaetsfaelle und duerfen nicht durch Fake-Daten geschlossen werden.

Empfohlener Umgang: manuell in verlaesslicher Quelle pruefen, erst danach echte Release-Daten ergaenzen. Wenn keine Quelle einen belastbaren Treffer liefert, bleibt die Luecke sichtbar.

## Luecken nach Serie

| Serie | Verlag | Fehlende Baende | Anzahl | Klassifikation |
|---|---|---:|---:|---|
| Vermeil in Gold | MANGAMOON | 2 | 1 | source-data-gap |
| Vagabond – Master Edition | Egmont Manga | 16-19 | 4 | source-data-gap |
| Adou | Altraverse | 12 | 1 | source-data-gap |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 5-8 | 4 | source-data-gap |
| Berserk Master Edition | Panini Manga | 9-14 | 6 | source-data-gap |
| Isekai Soapland | MANGAMOON | 3-8 | 6 | source-data-gap |
| Neck mich nicht, Nagatoro-san | dani books | 6-7 | 2 | source-data-gap |
| Tokyo Revengers – Doppelband-Edition | Carlsen Manga | 16 | 1 | source-data-gap |
| Death Note - Diamond Edition | Tokyopop | 1 | 1 | source-data-gap |
| Eguchi-san’s Pure-hearted Succubus | Dokico | 2 | 1 | source-data-gap |

## Luecken nach Verlag

| Verlag | Luecken | Serien |
|---|---:|---:|
| MANGAMOON | 7 | 2 |
| Panini Manga | 6 | 1 |
| Altraverse | 5 | 2 |
| Egmont Manga | 4 | 1 |
| dani books | 2 | 1 |
| Carlsen Manga | 1 | 1 |
| Dokico | 1 | 1 |
| Tokyopop | 1 | 1 |

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

## Phase 23a: Ursachenanalyse

Die 27 `source-data-gap`-Einzelluecken sind in `docs/release-cache-source-gap-analysis.md` strukturiert analysiert.

Die Analyse dokumentiert pro Gap:

- vermutete Ursache
- gepruefte Quelle
- empfohlene Massnahme
- ob ein sicherer Cache-Patch moeglich ist
- ob eine manuelle Quellenpruefung noetig ist

Aktueller Befund: kein Gap ist ohne weitere Quellenpruefung sicher patchbar. Es wurden keine Fake-Daten, keine geratenen Release-Daten und keine privaten Sammlungsdaten ergaenzt.

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
