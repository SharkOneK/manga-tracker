# Release-Cache-Automation (Phase 25)

Phase 25 automatisiert den Release-Cache-Prozess, ohne die Sicherheitsregeln der bisherigen Phasen zu lockern. Die Pipeline darf Daten nur dann in den öffentlichen Cache schreiben, wenn sie als `confidence: "high"` bewertet wurden. Alle anderen Fälle bleiben in der Source-Review-Queue.

## Pipeline

Der Einstiegspunkt ist:

```bash
node scripts/run-release-cache-pipeline.js
```

Die Pipeline liest:

- `data/release-watchlist.json`
- `data/release-source-review-queue.json`
- `data/release-cache.json`
- `data/release-sources.json`
- bestehende App-Seeds aus `src/app.js`, wenn dort explizite `nextDate`-Werte stehen

Danach prüft sie Kandidaten gegen aktivierte Release-Provider. Aktuell ist Manga Passion als erster Provider implementiert (`scripts/release-providers/manga-passion-provider.js`). Es wird nicht gecrawlt und es werden keine geratenen Daten erzeugt.

## Outputs

Die Pipeline schreibt drei Artefakte:

| Datei | Zweck |
| --- | --- |
| `data/release-cache.json` | Öffentlicher Cache; erhält nur sichere `high`-Confidence-Patches. |
| `data/release-source-review-queue.json` | Arbeitsliste für `medium`, `low` und `blocked` Kandidaten sowie gepatchte Queue-Gaps. |
| `data/release-cache-pipeline-report.json` | Maschinenlesbarer Laufbericht mit Summen, Patches, Queue-Routen und Auto-Merge-Eignung. |

Der Report wird validiert mit:

```bash
node scripts/validate-release-cache-pipeline-report.js
```

## Confidence-Regeln

Die Regeln liegen zentral in `scripts/release-confidence.js`.

`high` ist nur erlaubt, wenn alle folgenden Bedingungen erfüllt sind:

1. Titel/Edition ist eindeutig und normalisiert identisch.
2. Publisher stimmt nach Alias-Normalisierung überein.
3. Bandnummer stimmt exakt überein und ist kein Sonderband-Konflikt.
4. Das Release-Datum ist ein echtes valides `YYYY-MM-DD`.
5. Die Quelle ist in `data/release-sources.json` erlaubt.
6. `sourceUrl` und `sourceName` sind gesetzt.

Automatisch blockiert werden insbesondere:

- Platzhalterdaten wie `2999-12-31`
- ungültige Datumswerte
- nicht erlaubte Source-URLs
- Publisher-Konflikte
- Editions-/Titel-Konflikte
- Bandnummern-Konflikte
- mehrdeutige Editionen

`medium` und `low` dürfen nie automatisch in `data/release-cache.json` landen. Sie werden in die Review-Queue geschrieben.

## Review-Queue-Statuswerte

Zusätzlich zu den manuellen Statuswerten erlaubt die Queue automatische Statuswerte:

- `auto-blocked`
- `auto-source-missing`
- `auto-not-yet-released`
- `auto-medium-confidence`
- `auto-low-confidence`
- `auto-ready-to-patch`
- `patched`

Unsichere Kandidaten bekommen `safeToPatch: false`. Einträge mit `patched` wurden bereits automatisch als High-Confidence-Patch in den Cache übernommen.

## GitHub Action und PR-Erstellung

`.github/workflows/update-release-cache.yml` führt die Pipeline täglich und manuell aus. Der Workflow:

1. prüft die Syntax der relevanten Skripte,
2. führt `run-release-cache-pipeline.js` aus,
3. führt alle Validatoren und Smoke-/Security-Checks aus,
4. erstellt bei Änderungen einen Pull Request über `peter-evans/create-pull-request`,
5. pusht niemals direkt auf `main`.

Der PR-Body enthält eine Zusammenfassung aus `data/release-cache-pipeline-report.json`.

## Auto-Merge

Es gibt keinen zusätzlichen Feature-Schalter: Auto-Merge wird versucht, sobald das Gate (`steps.automerge_gate.outputs.allowed == 'true'`) den PR freigibt. Schlägt `gh pr merge --auto` fehl (`allow_auto_merge` ist im Repo deaktiviert, siehe unten), fällt der Step auf einen direkten Squash-Merge zurück — Autorität über den Merge bleibt in jedem Fall das Gate, nicht `--auto`.

Zusätzlich muss der Report `autoMergeEligible: true` enthalten. Das ist seit Phase 83 nur der Fall, wenn:

- es mindestens einen Cache-Patch gibt,
- jeder Cache-Patch `confidence: "high"` hat,
- keine blockierten Kandidaten im Lauf enthalten sind.

`autoMergeEligible` bedeutet damit ausdrücklich „die Pipeline selbst hat nichts Unsicheres in den öffentlichen Cache geschrieben" — **nicht** „dieser PR ist mergefähig". Der Report kennt die Basis des PRs nicht und kann diese Frage gar nicht beantworten.

**Autorität über den Merge ist das Gate** `scripts/validate-release-cache-automerge-gate.js`. Es prüft zusätzlich den Diff gegen die Basis und erlaubt einen Cache-Patch-PR nur, wenn:

- die Review-Queue **keine neuen Keys gegenüber der Basis** enthält (stabiler Key: `queueKey`, sonst `seriesTitle|publisher|volumeNumber`). Entfernte Keys und Änderungen an bekannten Keys sind erlaubt, eine reine Umsortierung der Queue ist kein neuer Key,
- jeder Eintrag der Queue eine stabile Identität hat (sonst fail-closed),
- jeder **neu** auf `safeToPatch: true` gesetzte Queue-Eintrag einen passenden Eintrag in `report.cachePatches` hat,
- neue `releaseDate`-Werte in der Queue `sourceUrl`, `checkedAt` und `evidence` mitbringen,
- keine blockierten Kandidaten, keine Cache-Löschungen und keine Dateien außerhalb der Allowlist im PR sind.

Vor Phase 83 blockte jeder Review-Queue-Write den Merge. Weil die Pipeline in praktisch jedem Lauf in die Queue schreibt, war das ein Deadlock: die Bot-PRs blieben dauerhaft offen (Audit-Befund 2). Die Schutzwirkung liegt jetzt beim Diff-Vergleich statt bei der Report-Zahl.

Damit werden PRs mit unsicheren oder gemischten Änderungen weiterhin nicht automatisch gemerged.

Die Gate-Metriken (`cachePatches`, `changedCacheItems`, `deletedCacheItems`, `reviewQueueWrites`, `newQueueKeys`, `removedQueueKeys`) landen in der Step-Summary des Workflows.

Die Auto-Merge-Gates der übrigen Bot-Workflows sind in [`docs/bot-pr-automerge.md`](bot-pr-automerge.md) beschrieben.

## Warum unsichere Fälle nicht in den Cache gelangen

`data/release-cache.json` ist eine öffentliche, von der App gelesene Datei. Ein falsches Release-Datum würde Nutzern aktiv falsche Kauf-/Release-Informationen anzeigen. Deshalb gilt:

- Kein Platzhalterdatum wird übernommen.
- Keine nicht bestätigte App-Seed-Information wird übernommen.
- Keine Quelle außerhalb der erlaubten Projektquellen wird übernommen.
- Jeder Konflikt landet in der Review-Queue statt im Cache.

Die Pipeline automatisiert also die Prüfung und Sortierung, nicht das Raten von Release-Daten.

## Provider-Architektur ab Phase 26

Die Quellenlogik liegt nicht mehr inline im Pipeline-Runner. `scripts/release-providers/index.js` wählt implementierte Provider anhand von `data/release-sources.json` aus. Aktuell ist nur `manga-passion` aktiv implementiert; weitere Provider können später ergänzt werden.

Provider liefern ein einheitliches Ergebnis mit `providerId`, `sourceName`, `sourceUrl`, Belegen und optional ISBN/Cover. Widersprüchliche High-Confidence-Provider-Ergebnisse werden blockiert und in der Review-Queue dokumentiert.
