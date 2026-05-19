# Release-Provider-System (Phase 26)

Phase 26 kapselt die Quellenprüfung der Release-Cache-Pipeline in Provider. Die Pipeline bleibt konservativ: Provider liefern nur belegte Kandidaten, die bestehenden Confidence-Regeln entscheiden weiterhin, ob ein Treffer automatisch in `data/release-cache.json` übernommen werden darf.

## Einstiegspunkte

```text
scripts/release-providers/
  index.js
  provider-utils.js
  manga-passion-provider.js
```

- `index.js` wählt aktivierte Provider anhand von `data/release-sources.json` aus und führt sie für Pipeline-Kandidaten aus.
- `provider-utils.js` enthält gemeinsame Hilfen für HTTPS-Fetches, Timeouts, ISBN-Normalisierung und Provider-Ergebnisfelder.
- `manga-passion-provider.js` enthält die bisherige Manga-Passion-Suchlogik aus der Pipeline als ersten aktiven Provider.

## Aktiver Provider

Aktuell ist nur `manga-passion` implementiert. Weitere Quellen wie Verlagsseiten können später ergänzt werden, ohne den Pipeline-Runner erneut fest an eine Quelle zu koppeln.

## Provider-Ergebnis

Provider liefern ein einheitliches Kandidatenobjekt mit u. a.:

```json
{
  "seriesTitle": "Beispielserie",
  "publisher": "Beispiel Verlag",
  "volumeNumber": 2,
  "releaseDate": "2026-07-15",
  "isbn13": "9780000000000",
  "coverUrl": "https://example.com/cover.jpg",
  "sourceUrl": "https://example.com/product",
  "sourceName": "Example Provider",
  "providerId": "example",
  "evidence": "Titel, Verlag und Bandnummer stimmen überein.",
  "checkedAt": "2026-05-19T00:00:00.000Z"
}
```

`releaseDate`, `isbn13` und `coverUrl` dürfen nur aus der Quelle stammen. Provider dürfen keine Daten raten und keine Platzhalterdaten wie `2999-12-31` erzeugen.

## Auswahl und Konflikte

1. Die Pipeline übernimmt bereits manuell geprüfte Kandidaten aus der Review-Queue unverändert in die Confidence-Prüfung.
2. Für offene Kandidaten ruft `index.js` alle implementierten und aktivierten Provider auf.
3. Das erste `high`-Confidence-Ergebnis kann verwendet werden, solange kein weiterer Provider ein widersprüchliches `high`-Ergebnis liefert.
4. Widersprüchliche High-Confidence-Ergebnisse werden als `provider-conflict` blockiert und nicht in den Cache geschrieben.
5. `medium`, `low` und `blocked` laufen wie in Phase 25 in die Review-Queue.

## Sicherheitsregeln

- Provider verwenden ausschließlich HTTPS-URLs.
- Keine Cookies, Logins, Secrets oder privaten Nutzerdaten.
- Timeouts und Request-Delays kommen aus `data/release-sources.json` / Pipeline-Policy.
- Fehler erzeugen Diagnose-/Review-Queue-Einträge, keine Fake-Daten.
- Die Browser-App schreibt weiterhin nicht in `data/release-cache.json`, `release-watchlist.json` oder Supabase-Pipeline-Daten.

## Zusammenhang mit Phase 25

Phase 25 hat die automatische PR-basierte Pipeline eingeführt. Phase 26 ändert nicht die Cache-Qualitätsregeln, sondern nur die Quellenarchitektur: Manga Passion ist jetzt ein Provider statt Inline-Code im Pipeline-Runner. Die bestehenden Validatoren, Reports und Confidence-Regeln bleiben maßgeblich.

## UI-Diagnose statt manueller Normalprozess

Die App zeigt lokale Coverage- und Cache-Miss-Informationen weiter als Diagnose. Manuelles Kopieren von Watchlist-Batches ist aber nicht mehr der normale Hauptworkflow. Bekannte Watchlist- und Review-Queue-Fälle werden durch die automatisierte Pipeline verarbeitet.
