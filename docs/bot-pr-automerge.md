# Auto-Merge der Bot-PRs (Phase 83)

Vier Workflows erzeugen automatisch PRs mit öffentlichen Datenartefakten. Jeder dieser PRs
wird nur dann automatisch gemerged, wenn ein Gate-Skript ihn ausdrücklich erlaubt
(Default-Deny). Kein Workflow pusht direkt auf `main`.

| Workflow | Gate | Allow-Klasse |
| --- | --- | --- |
| `update-release-cache.yml` | `scripts/validate-release-cache-automerge-gate.js` | `release-cache-high-confidence-only`, `release-cache-with-volume-count-refresh`, `report-only`, `report-queue-only`, `volume-count-refresh-only` |
| `update-release-volume-counts.yml` | `scripts/validate-release-volume-counts-automerge-gate.js` | `release-volume-counts-only` |
| `update-series-publication-status.yml` | `scripts/validate-bot-data-automerge-gate.js --domain series-publication-status` | `series-publication-status-only` |
| `update-tmdb-catalog.yml` | `scripts/validate-bot-data-automerge-gate.js --domain tmdb-series-catalog` | `tmdb-series-catalog-only` |

Details zum Release-Cache-Gate stehen in [`docs/release-cache-automation.md`](release-cache-automation.md).

## Gemeinsames Gate für zwei Datendomänen

`scripts/validate-bot-data-automerge-gate.js` bedient die Publikationsstatus- und die
TMDB-Katalog-Domäne über eine `DOMAINS`-Registry. Beide Gates sind strukturell identisch
(Pfad-Allowlist → Schema-Validator → Privacy-Scan → Diff-Regeln → Default-Deny); nur
Dateiliste, Schema-Validator und Diff-Prädikate unterscheiden sich. Zwei kopierte Skripte
würden auseinanderdriften — genau das Muster, aus dem Audit-Befund 6 entstanden ist.

```bash
node scripts/validate-bot-data-automerge-gate.js --domain <name> --base origin/main --json
```

Exit-Code 0 = erlaubt, 1 = manuelle Prüfung nötig. Eine unbekannte oder fehlende `--domain`
ist immer ein Deny.

### Regeln für beide Domänen (Prüfreihenfolge)

1. Leere Dateiliste → Deny.
2. Jede Datei außerhalb der Domain-Allowlist → Deny. Gesperrt sind zusätzlich immer
   `src/`, `scripts/`, `.github/`, `supabase/`, `docs/`, `vendor/`, `index.html` sowie die
   Datenartefakte aller anderen Domänen.
3. Basisdokument über `git show <base>:<pfad>`; Lese-/Parse-Fehler → Deny.
4. Der Schema-Validator der Domäne muss auf dem Head-Dokument `ok` sein.
5. Rekursiver Scan des Head-Dokuments auf verbotene Keys (`owner`, `ownerToken`, `userId`,
   `email`, `token`, `secret`, `apiKey`, `accessToken`, `jwt`, `session`, `owned`, `read`,
   `readStatus`, `rating`, `personalNotes`, `privateNotes`, `viewToken`, …) → Treffer = Deny.
   Bewusst **ohne** die generischen Namen `status`/`notes`, die in beiden Schemas legitim sind.
6. Top-Level-Keys müssen in der Domain-Allowlist liegen.
7. `generatedAt` muss ein valider ISO-Zeitstempel und nicht älter als in der Basis sein.
8. Mengenbremse: `additions + inhaltliche updates + deletions > max(5, ceil(0.2 × Items der Basis))`
   → Deny (Schutz vor Massen-Umschreibung durch einen Parser-/API-Ausfall).
   **Inhaltliche** Updates sind Updates, die mehr als die reinen Frische-Felder der Domäne
   ändern (`checkedAt` beim Publikationsstatus). Grund: Der Status-Runner schreibt `checkedAt`
   in jedes geprüfte Item, ein normaler Lauf erzeugt damit 45 von 47 Updates ohne jede
   inhaltliche Änderung (gemessen an PR #306). Würden die mitzählen, wäre die Domäne dauerhaft
   blockiert — derselbe Deadlock wie in Audit-Befund 2. Gegen die Feld-Allowlist werden auch
   Frische-Updates geprüft; die Step-Summary weist `updates` und `contentUpdates` getrennt aus.
9. Löschungen von Items → immer Deny. Der manuelle Merge bleibt in allen Fällen möglich.

### Domäne `series-publication-status`

- Allowlist: `data/series-publication-status.json`, `data/series-publication-status-report.json`.
  Ändert sich die Statusdatei, muss der Report im selben PR liegen.
- Item-Identität: `seriesTitle|publisher` (kleingeschrieben).
- Additions nur mit `confidence: "high"` **und** entweder `source: "override"` mit Begründung
  oder `https://`-Quelle mit `sourceStatus` 1 oder 2.
- Updates dürfen nur `ongoing`, `sourceStatus`, `editionId`, `source`, `sourceUrl`, `reason`,
  `checkedAt` ändern; `confidence` muss `high` bleiben, `seriesTitle`/`publisher` sind Identität.
- Report: `schemaVersion: 1`, `source: "run-series-publication-status.js"`.
  `summary.appliedChanges` darf die Zahl der Item-Änderungen im Diff um höchstens
  `2 × summary.overridesApplied` übersteigen (Anti-Tamper mit Toleranz): Ein Override kann
  denselben Titel zweimal zählen — der API-Wert kippt ihn, der Override kippt ihn zurück —
  ohne Netto-Änderung an der Datei. Genau so sieht der reale Lauf aus (PR #306:
  `appliedChanges: 2`, netto 0 inhaltliche Änderungen). Ohne diese Toleranz wäre die Domäne
  dauerhaft blockiert.
  `summary.blockedOrUnmapped` **darf** > 0 sein — andernfalls entstünde derselbe Deadlock wie
  in Audit-Befund 2 (blockierte Serien sind der Normalfall).

### Domäne `tmdb-series-catalog`

- Allowlist: ausschließlich `data/tmdb-series-catalog.json`.
- Item-Identität: `tmdbId`.
- Herkunftsnachweis: jede **neue** `tmdbId` muss in `data/tmdb-watchlist.json` mit
  `enabled !== false` stehen. Die Watchlist selbst ist nicht Teil der Allowlist — der Bot
  darf sie nicht ändern, sie wird nur gelesen.
- Updates dürfen nur `total`, `seasonCount`, `ongoing`, `seasons`, `genres`, `overview`,
  `cover`, `network`, `streamingProviders` ändern. Eine Änderung von `title` → Deny
  (Verdacht auf Fehl-Match).
- Monotonie: `seasonCount` und `total` dürfen nicht sinken; `null → Zahl` ist erlaubt,
  `Zahl → null` nicht.

## Merge-Aufruf und `allow_auto_merge`

Im Repository ist `allow_auto_merge` **deaktiviert** (gemessen am 2026-09-26:
`gh api repos/SharkOneK/manga-tracker --jq .allow_auto_merge` → `false`). `gh pr merge --auto`
kann deshalb keinen echten Auto-Merge aktivieren; dass die Volume-Count-PRs trotzdem gemergt
wurden, beruht auf dem Sofort-Merge-Verhalten von `gh` bei bereits mergefähigen PRs (bei
`GITHUB_TOKEN`-erzeugten Bot-PRs laufen keine `pull_request`-Workflows, der PR ist sofort „clean").

Alle vier Merge-Steps rufen daher `--auto` auf und fallen bei Fehlschlag explizit auf einen
direkten Squash-Merge zurück. Bewusst **ohne** `continue-on-error`: schlägt auch der
Direkt-Merge fehl (z. B. wegen Branch-Protection), wird der Job rot und sichtbar, statt still
zu hängen. Wird `allow_auto_merge` in den Repo-Settings aktiviert, greift automatisch wieder
der echte Auto-Merge-Pfad — empfohlen, aber ein manueller Schritt außerhalb des Repos.

## Tests

- `node scripts/test-bot-data-automerge-gate.js` — reine Funktionstests mit injizierten
  Dokumenten (kein Git, kein Netz), beide Domänen.
- `node scripts/test-automerge-gate.js` — Release-Cache-Gate inkl. Queue-Key-Regeln.

Beide laufen in `node scripts/run-all-checks.js` und in den jeweiligen Workflows.
