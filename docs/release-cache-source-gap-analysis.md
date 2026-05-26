# Phase 23a - Release-Cache Source-Gap-Ursachenanalyse

Stand: automatisch synchronisiert aus aktuellem Audit gegen `data/release-watchlist.json` und `data/release-cache.json`.

Diese Datei dokumentiert die 30 bekannten `source-data-gap`-Luecken aus `docs/release-cache-coverage-gaps.md`. Sie ist bewusst eine Analyse- und Entscheidungsdatei: Es werden keine Release-Daten geraten, keine privaten Sammlungsdaten ergaenzt und `data/release-cache.json` bleibt unangetastet.

## Ergebnis

| Kennzahl | Wert |
|---|---:|
| Analysierte Gaps | 30 |
| Betroffene Serien | 10 |
| Sichere direkte Cache-Patches | 0 |
| Manuelle Quellenpruefung noetig | 30 |

## Ursachencluster

| Vermutete Ursache | Gaps |
|---|---:|
| not-yet-released | 27 |
| manual-source-required | 1 |
| source-missing | 1 |
| volume-numbering-mismatch | 1 |

Interpretation:

- `manual-source-required`: Der Gap wurde aus dem aktuellen Audit uebernommen; vor einem Cache-Patch muss eine belastbare Quelle manuell geprueft werden.
- `not-yet-released`: Die bekannte Quelle fuehrt den Band gar nicht mit einem validen Datum oder nur mit Platzhalterdatum. Kein Cache-Patch ohne weitere Quelle.
- `source-missing`: Die bekannte Quelle enthaelt den Band aktuell nicht in der passenden Edition.
- `publisher-normalization`: Watchlist-/Quellenpublisher weichen fachlich ab; erst Metadaten klaeren, dann patchen.
- `volume-numbering-mismatch`: Bandnummer passt wahrscheinlich nicht zur Edition oder zur Quellenzaehlung.

## Empfohlene Massnahmen

| Empfohlener Fix | Gaps |
|---|---:|
| manual-source-review | 30 |

Der einzige sichere naechste Schritt ist aktuell `manual-source-review`: offizielle Verlagsseite oder bereits erlaubte vertrauenswuerdige Quelle pruefen und erst danach echte Release-Daten mit Source-URL uebernehmen.

## Serienuebersicht

| Serie | Verlag | Fehlende Baende | Anzahl | Ursache | Empfehlung | Safe to patch |
|---|---|---:|---:|---|---|---|
| Vermeil in Gold | MANGAMOON | 2 | 1 | not-yet-released | manual-source-review | nein |
| Meine Chefin kommt immer zuerst!! | MangaMoon | 2 | 1 | not-yet-released | manual-source-review | nein |
| Vagabond – Master Edition | Egmont Manga | 16-19 | 4 | not-yet-released | manual-source-review | nein |
| Adou | Altraverse | 12 | 1 | source-missing | manual-source-review | nein |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 4-8 | 5 | not-yet-released | manual-source-review | nein |
| Berserk Master Edition | Panini Manga | 7-14 | 8 | not-yet-released | manual-source-review | nein |
| Gushing over Magical Girls | MangaMoon | 4 | 1 | not-yet-released | manual-source-review | nein |
| Isekai Soapland | MANGAMOON | 3-8 | 6 | not-yet-released | manual-source-review | nein |
| Neck mich nicht, Nagatoro-san | dani books | 6-7 | 2 | manual-source-required | manual-source-review | nein |
| Tokyo Revengers – Doppelband-Edition | Carlsen Manga | 16 | 1 | volume-numbering-mismatch | manual-source-review | nein |

## Einzelgap-Matrix

| Serie | Verlag | Band | Ursache | Empfehlung | Safe to patch | Manuelle Quellenpruefung |
|---|---|---:|---|---|---|---|
| Vermeil in Gold | MANGAMOON | 2 | not-yet-released | manual-source-review | nein | ja |
| Meine Chefin kommt immer zuerst!! | MangaMoon | 2 | not-yet-released | manual-source-review | nein | ja |
| Vagabond – Master Edition | Egmont Manga | 16 | not-yet-released | manual-source-review | nein | ja |
| Vagabond – Master Edition | Egmont Manga | 17 | not-yet-released | manual-source-review | nein | ja |
| Vagabond – Master Edition | Egmont Manga | 18 | not-yet-released | manual-source-review | nein | ja |
| Vagabond – Master Edition | Egmont Manga | 19 | not-yet-released | manual-source-review | nein | ja |
| Adou | Altraverse | 12 | source-missing | manual-source-review | nein | ja |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 4 | not-yet-released | manual-source-review | nein | ja |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 5 | not-yet-released | manual-source-review | nein | ja |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 6 | not-yet-released | manual-source-review | nein | ja |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 7 | not-yet-released | manual-source-review | nein | ja |
| Arifureta: Der Kampf zurück in meine Welt – Zero | Altraverse | 8 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 7 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 8 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 9 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 10 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 11 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 12 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 13 | not-yet-released | manual-source-review | nein | ja |
| Berserk Master Edition | Panini Manga | 14 | not-yet-released | manual-source-review | nein | ja |
| Gushing over Magical Girls | MangaMoon | 4 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 3 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 4 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 5 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 6 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 7 | not-yet-released | manual-source-review | nein | ja |
| Isekai Soapland | MANGAMOON | 8 | not-yet-released | manual-source-review | nein | ja |
| Neck mich nicht, Nagatoro-san | dani books | 6 | not-yet-released | manual-source-review | nein | ja |
| Tokyo Revengers – Doppelband-Edition | Carlsen Manga | 16 | volume-numbering-mismatch | manual-source-review | nein | ja |
| Neck mich nicht, Nagatoro-san | dani books | 7 | manual-source-required | manual-source-review | nein | ja |

## Maschinenlesbare Analyse

<!-- source-gap-analysis-json:start -->
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-19",
  "gapAnalysis": [
    {
      "seriesTitle": "Vermeil in Gold",
      "publisher": "MANGAMOON",
      "volumeNumber": 2,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6137 vorhanden; Publisher MANGAMOON bestaetigt; Band 2 ohne valides Release-Datum."
        }
      ],
      "evidence": "Publisher-Mismatch wurde 2026-05-23 behoben (Watchlist-Korrektur: Manga Cult -> MANGAMOON). Band 2 fehlt weiterhin im Cache, da Manga Passion kein valides Release-Datum fuer Band 2 fuehrt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Meine Chefin kommt immer zuerst!!",
      "publisher": "MangaMoon",
      "volumeNumber": 2,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6135 vorhanden; Band 2 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6135 fuehrt Band 2 nur mit Platzhalterdatum 2999-12-31; Schreibweise MangaMoon/MANGAMOON sollte konsolidiert bleiben.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Vagabond – Master Edition",
      "publisher": "Egmont Manga",
      "volumeNumber": 16,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 4636 vorhanden; Band 13-19 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 4636 fuehrt Band 13-19 nur mit Platzhalterdatum 2999-12-31; Band 8-12 sind bereits bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Vagabond – Master Edition",
      "publisher": "Egmont Manga",
      "volumeNumber": 17,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 4636 vorhanden; Band 13-19 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 4636 fuehrt Band 13-19 nur mit Platzhalterdatum 2999-12-31; Band 8-12 sind bereits bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Vagabond – Master Edition",
      "publisher": "Egmont Manga",
      "volumeNumber": 18,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 4636 vorhanden; Band 13-19 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 4636 fuehrt Band 13-19 nur mit Platzhalterdatum 2999-12-31; Band 8-12 sind bereits bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Vagabond – Master Edition",
      "publisher": "Egmont Manga",
      "volumeNumber": 19,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 4636 vorhanden; Band 13-19 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 4636 fuehrt Band 13-19 nur mit Platzhalterdatum 2999-12-31; Band 8-12 sind bereits bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Adou",
      "publisher": "Altraverse",
      "volumeNumber": 12,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "source-missing",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 518 vorhanden; kein Band 12 in der geprueften Volumenliste."
        }
      ],
      "evidence": "Manga-Passion-Edition 518 enthaelt aktuell nur bis Band 11 mit validen Daten; Band 12 wurde in der geprueften Quelle nicht gefunden.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Arifureta: Der Kampf zurück in meine Welt – Zero",
      "publisher": "Altraverse",
      "volumeNumber": 4,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5807 vorhanden; Band 4-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5807 fuehrt die Zielbaende nur mit Platzhalterdatum 2999-12-31; vorhandener App-Seed fuer Band 3 ist nicht extern bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Arifureta: Der Kampf zurück in meine Welt – Zero",
      "publisher": "Altraverse",
      "volumeNumber": 5,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5807 vorhanden; Band 4-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5807 fuehrt die Zielbaende nur mit Platzhalterdatum 2999-12-31; vorhandener App-Seed fuer Band 3 ist nicht extern bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Arifureta: Der Kampf zurück in meine Welt – Zero",
      "publisher": "Altraverse",
      "volumeNumber": 6,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5807 vorhanden; Band 4-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5807 fuehrt die Zielbaende nur mit Platzhalterdatum 2999-12-31; vorhandener App-Seed fuer Band 3 ist nicht extern bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Arifureta: Der Kampf zurück in meine Welt – Zero",
      "publisher": "Altraverse",
      "volumeNumber": 7,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5807 vorhanden; Band 4-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5807 fuehrt die Zielbaende nur mit Platzhalterdatum 2999-12-31; vorhandener App-Seed fuer Band 3 ist nicht extern bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Arifureta: Der Kampf zurück in meine Welt – Zero",
      "publisher": "Altraverse",
      "volumeNumber": 8,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5807 vorhanden; Band 4-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5807 fuehrt die Zielbaende nur mit Platzhalterdatum 2999-12-31; vorhandener App-Seed fuer Band 3 ist nicht extern bestaetigt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 7,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 8,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 9,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 10,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 11,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 12,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 13,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Berserk Master Edition",
      "publisher": "Panini Manga",
      "volumeNumber": 14,
      "classification": "source-data-gap",
      "priority": "sehr hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5211 vorhanden; betroffene Baende ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5211 fuehrt die Baende 7-14 nur mit Platzhalterdatum 2999-12-31; kein valides Release-Datum im Cache erlaubt.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Gushing over Magical Girls",
      "publisher": "MangaMoon",
      "volumeNumber": 4,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 5407 vorhanden; Band 4 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 5407 fuehrt Band 4 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 3,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 4,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 5,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 6,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 7,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Isekai Soapland",
      "publisher": "MANGAMOON",
      "volumeNumber": 8,
      "classification": "source-data-gap",
      "priority": "hoch",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 6069 vorhanden; Band 3-8 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 6069 fuehrt Band 3-8 nur mit Platzhalterdatum 2999-12-31; MangaMoon/MANGAMOON ist ein Normalisierungsfall, aber nicht die unmittelbare Cache-Luecke.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Neck mich nicht, Nagatoro-san",
      "publisher": "dani books",
      "volumeNumber": 6,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "not-yet-released",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 1750 vorhanden; Band 6 ohne valides Release-Datum."
        }
      ],
      "evidence": "Manga-Passion-Edition 1750 fuehrt Band 6 nur mit Platzhalterdatum 2999-12-31; keine sichere Cache-Ergaenzung ohne Verlags-/Quellenpruefung.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Tokyo Revengers – Doppelband-Edition",
      "publisher": "Carlsen Manga",
      "volumeNumber": 16,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "volume-numbering-mismatch",
      "checkedSources": [
        {
          "name": "Manga Passion API",
          "url": "https://www.manga-passion.de",
          "result": "Edition 1599 vorhanden; kein Band 16 in der geprueften Volumenliste."
        }
      ],
      "evidence": "Manga-Passion-Edition 1599 enthaelt Doppelband 1-15; Watchlist-Band 16 koennte Nummerierungs-/Editionsdrift sein und muss gegen Carlsen geprueft werden.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    },
    {
      "seriesTitle": "Neck mich nicht, Nagatoro-san",
      "publisher": "dani books",
      "volumeNumber": 7,
      "classification": "source-data-gap",
      "priority": "mittel",
      "suspectedCause": "manual-source-required",
      "checkedSources": [
        {
          "name": "Release-Intake-Staging / Release-Cache-Audit",
          "url": "data/release-watchlist.json",
          "result": "Nach Release-Intake in der Watchlist vorhanden; kein passender Eintrag in data/release-cache.json."
        }
      ],
      "evidence": "Der Band wurde per Release-Intake in die Watchlist uebernommen. Der Release-Cache enthaelt noch kein belegtes Datum; kein Cache-Patch ohne verifizierte Quelle.",
      "recommendedFix": "manual-source-review",
      "safeToPatch": false,
      "manualSourceReviewNeeded": true
    }
  ]
}
```
<!-- source-gap-analysis-json:end -->
## Quellenstrategie pro Verlag

| Verlag | Gaps | Serien | Strategie |
|---|---:|---:|---|
| Panini Manga | 8 | 1 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| MANGAMOON | 7 | 2 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| Altraverse | 6 | 2 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| Egmont Manga | 4 | 1 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| dani books | 2 | 1 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| MangaMoon | 2 | 2 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |
| Carlsen Manga | 1 | 1 | Offizielle Verlags-/Produktquelle manuell pruefen; kein Cache-Patch ohne belegtes tagesgenaues Release-Datum. |

## Konkrete naechste Fixes

1. Neue oder weiterhin offene Audit-Gaps aus der maschinenlesbaren Analyse mit `manual-source-review` triagieren.
2. Offizielle Verlagsseiten oder bereits erlaubte vertrauenswuerdige Quellen fuer die groessten Gap-Bloecke priorisieren.
3. Erst wenn ein echtes Datum mit Source-URL vorliegt: Updater/Quelle erweitern oder Watchlist-Metadaten ergaenzen, danach Cache per Skriptprozess aktualisieren.

## Sicherheitsbestaetigung

- Keine Fake-Daten ergaenzt.
- Keine geratenen Release-Daten ergaenzt.
- Keine privaten Sammlungsdaten verwendet.
- `data/release-cache.json` wurde fuer diese Analyse nicht veraendert.

## Phase 33 Manual Source-Gap Audit (2026-05-20)

### Queue-Audit

- Queue-Eintraege gesamt: 38
- safeToPatch=true: 0
- safeToPatch=false: 38
- reviewStatus vor manueller Phase-33-Klassifizierung: historischer Stand vor PR #55; neue Intake-Gaps wurden als manual-source-required ergaenzt
- Hauptcluster: not-yet-released 31+, auto-blocked/ambiguous 61, source-missing 1, volume-numbering-mismatch 1, publisher-normalization 1

### Grosse Serienbloecke

- Berserk Master Edition: Band 7-14 bleiben blockiert; Manga Passion fuehrt nur Platzhalterdaten, kein Cache-Patch.
- Vagabond - Master Edition: Band 13-19 bleiben blockiert; Platzhalterdaten, kein Cache-Patch.
- Isekai Soapland: Band 3-8 bleiben blockiert; MangaMoon/MANGAMOON ist technisch normalisiert, aber Release-Daten fehlen.
- Arifureta: Der Kampf zurueck in meine Welt - Zero: Band 4-8 bleiben Quellen-/Verfuegbarkeitsblock.

### Priorisierte Einzelfaelle

| Fall | Phase-33-Ergebnis | Quelle | Queue-Status |
|---|---|---|---|
| Vermeil in Gold Band 2 | Publisher-Mismatch Manga Cult vs. MangaMoon/MANGAMOON; kein valides Band-2-Datum. | https://www.manga-passion.de/articles/tags/321/mangamoon | needs-source |
| Meine Chefin kommt immer zuerst!! Band 2 | Auftakt belegt, Band 2 nicht mit validem Datum belegt. | https://www.manga-passion.de/articles/tags/321/mangamoon | deferred |
| Adou Band 12 | Offizielle Altraverse-Reihenseite zeigt nur Band 1-11; Band 12 nicht belegt. | https://altraverse.de/manga/adou/ | needs-source |
| Chainsaw Man Band 23 | Manga Passion fuehrt Band 23 bei Egmont Manga als nicht angekuendigt; kein Datum. | https://www.manga-passion.de/volumes/31484/chainsaw-man-band-23 | deferred |
| Gushing over Magical Girls Band 4 | MangaMoon/MANGAMOON normalisiert; kein reales Release-Datum. | https://www.manga-passion.de/editions/5407 | deferred |
| Mirai Nikki - New Edition Band 6 | New-Edition-Quelle ohne reales Datum fuer Band 6. | https://www.manga-passion.de/editions/5504 | deferred |
| Neck mich nicht, Nagatoro-san Band 6 | Offizielle dani-books-Seite nennt Band 6, aber nur saisonales Fenster statt YYYY-MM-DD. | https://www.danibooks.de/neck-mich-nicht-nagatoro-san/187-neck-mich-nicht-nagatoro-san-band-6.html | needs-source |
| Tokyo Revengers - Doppelband-Edition Band 16 | Offizielle Carlsen-Seite sagt Abschluss in 15 Doppelbaenden; Band 16 ist Nummerierungs-/Watchlist-Fall. | https://www.carlsen.de/manga/tokyo-revengers | deferred |

Phase-33-Regel: Es wurden keine Release-Daten geraten und keine Platzhalterdaten uebernommen. Alle priorisierten Einzelfaelle bleiben safeToPatch=false, bis ein tagesgenaues, belastbares HTTPS-Release-Datum vorliegt.
