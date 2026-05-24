# Release-Provider-System (Phase 26/40)

Die Release-Cache-Pipeline kapselt Quellenprüfungen in Provider. Die Pipeline bleibt konservativ: Provider liefern nur belegte Kandidaten; `scripts/release-confidence.js` entscheidet weiterhin, ob ein Treffer automatisch in `data/release-cache.json` übernommen werden darf.

## Einstiegspunkte

```text
scripts/release-providers/
  index.js
  provider-utils.js
  publisher-provider-base.js
  manga-passion-provider.js
  carlsen-provider.js
  *-provider.js          # deaktivierte Publisher-Skeletons
```

- `index.js` registriert produktive Provider und wählt sie anhand von `data/release-sources.json` aus.
- `provider-utils.js` enthält gemeinsame Hilfen für HTTPS-Fetches, ISBN-Normalisierung und Provider-Ergebnisfelder.
- `publisher-provider-base.js` ist das Phase-40-Grundgerüst für Verlagsseiten: Publisher-Alias-Prüfung, HTML-Fetch mit Request-Policy, sauberer `not-implemented`-Pfad und Normalisierung von `search` + `parseProduct`.
- `manga-passion-provider.js` bleibt der Aggregator-Provider.
- `carlsen-provider.js` ist die erste produktive Verlagsseiten-Implementierung.

## Aktive Provider

| Provider | Status | Quelle | Zweck |
|---|---|---|---|
| `manga-passion` | aktiv | `https://www.manga-passion.de` API | Aggregator-Abgleich wie seit Phase 26 |
| `carlsen` | aktiv | `https://www.carlsen.de` Suche + Produktseiten | Autoritative Verlagsdaten für Carlsen Manga und Hayabusa |

Deaktivierte Skeletons existieren für `altraverse`, `egmont`, `panini`, `tokyopop`, `manga-cult`, `mangamoon`, `dani-books`, `dokico`, `hayabusa`, `yomeru` und `crunchyroll-manga`. Sie werden nicht registriert und geben bei direktem Aufruf `sourceResult: "not-implemented"` zurück.

## Publisher-Provider-Base

`buildPublisherProvider({ id, sourceName, baseUrl, publisherAliases, search, parseProduct })` erzeugt einen Provider mit einheitlichem `findRelease(candidate, context)`:

1. Request-Policy aus `data/release-sources.json`, optional source-spezifisch und durch `context.policy` überschreibbar.
2. Publisher-Alias-Guard: nicht zuständige Provider verursachen keinen Live-Request.
3. `search(candidate, ctx)` liefert nur belegte Produkt-Hits, keine geratenen Daten.
4. `parseProduct(hit, candidate, ctx)` extrahiert Pflicht-/Optionalfelder ausschließlich aus HTML/JSON-LD.
5. Treffer werden mit `normalizeProviderResult` vereinheitlicht.
6. Nicht implementierte Skeletons liefern `not-implemented`, Fetch-/Parserfehler liefern Diagnosefelder statt Fake-Daten.

Pflichtfelder für High Confidence bleiben unverändert: `seriesTitle`, `publisher`, `volumeNumber`, `releaseDate`, `sourceUrl`, `sourceName`, `providerId`, `checkedAt`, `evidence`, plus belegte `sourceEditionTitle`, `sourcePublisher` und `sourceVolumeNumber`.

## Carlsen-Referenzimplementierung

`carlsen-provider.js` verwendet:

- `publisherAliases`: `Carlsen`, `Carlsen Manga`, `Hayabusa`.
- Suche: `https://www.carlsen.de/suche?q=<Titel> Band <Nummer>`.
- Produktfilter: Carlsen-Produktpfade unter `/manga/`, `/softcover/`, `/hardcover/`, `/taschenbuch/`, `/produkt/` oder ISBN-Pfade.
- Parser: JSON-LD `Product`/`Book` bevorzugt; sichtbares HTML nur als Fallback für Titel/Datum.
- Datum: nur reale ISO- oder deutsche Datumswerte; `2999-12-31` wird nicht erzeugt und nicht akzeptiert.
- ISBN/Cover: nur aus `gtin13`/`isbn`/`image` oder eindeutigem HTML-ISBN-Feld.

Ein Carlsen-Treffer kann allein High Confidence werden, wenn Titel, Publisher-Alias, Bandnummer, echtes Datum und erlaubte URL zusammenpassen. Kollidiert ein High-Treffer von Carlsen mit einem High-Treffer eines anderen Providers, blockiert `buildProviderConflictCandidate` den Cache-Patch.

## Robots-/ToS-Notiz

Prüfdatum: 2026-05-24. Prüfmethode: öffentlicher Abruf der jeweiligen `robots.txt` mit identifizierbarem User-Agent `MangaTrackerReleaseBot/1.0 (+https://github.com/SharkOneK/manga-tracker)`. Diese Tabelle ist eine technische Aktivierungsnotiz, keine Rechtsberatung.

| Quelle | robots.txt / Befund | Phase-40-Status |
|---|---|---|
| Carlsen | `https://www.carlsen.de/robots.txt` erreichbar; öffentliche Suche/Produktpfade nicht pauschal gesperrt. | Aktiv, konservativ mit Delay. |
| Altraverse | `https://altraverse.de/robots.txt` erreichbar; Shop-/Account-/Checkout-Pfade gesperrt. | Skeleton deaktiviert. |
| Egmont Manga | `https://www.egmont-manga.de/robots.txt` erreichbar; `User-agent: *` sperrt u. a. `/EPiServer` und `/util`; mehrere KI-Crawler pauschal gesperrt. | Skeleton deaktiviert; vor Aktivierung erneut prüfen. |
| Panini | `https://www.paninishop.de/robots.txt` lieferte HTML/Redirect statt klarer robots-Datei. | Skeleton deaktiviert; vor Aktivierung manuell klären. |
| Tokyopop | `https://www.tokyopop.de/robots.txt` erreichbar; Medien/PDF/ZIP-Pfade teils gesperrt. | Skeleton deaktiviert. |
| Manga Cult | `https://www.manga-cult.de/robots.txt` lieferte TYPO3/Redirect-HTML zu Cross Cult. | Skeleton deaktiviert; vor Aktivierung klären. |
| MangaMoon / Animoon | `https://animoon-publishing.de/robots.txt` erreichbar; Shopify-Hinweise, öffentliche Produktseiten crawlbar, Checkout strikt ausgenommen. | Skeleton deaktiviert. |
| dani books | `https://dani-books.com/robots.txt` nicht erreichbar/Domain-Auflösung fehlgeschlagen. | Skeleton deaktiviert. |
| Dokico | `https://dokico.de/robots.txt` erreichbar; Shopify-Hinweise, öffentliche Produktseiten crawlbar, Checkout strikt ausgenommen. | Skeleton deaktiviert. |
| Hayabusa | `https://hayabusa.de/robots.txt` erreichbar; eigene Seite bleibt deaktiviert, Hayabusa wird über Carlsen-Alias mitabgedeckt. | Skeleton deaktiviert. |
| Yomeru | `https://yomeru.de/robots.txt` erreichbar; WordPress/WooCommerce-Admin-, Log- und Add-to-cart-Pfade gesperrt. | Skeleton deaktiviert. |
| Crunchyroll Manga | `https://www.crunchyroll.com/robots.txt` erreichbar; Suchpfade und technische Pfade gesperrt. | Skeleton deaktiviert. |
| Kazé Legacy | `https://www.kaze-online.de/robots.txt` lieferte Website-HTML/Redirect statt klarer robots-Datei. | Nur als deaktivierte Legacy-URL dokumentiert. |

## Sicherheitsregeln

- Nur HTTPS-URLs, keine Cookies, keine Logins, keine Captcha-/Checkout-/Account-Bereiche.
- Request-Limits kommen aus `data/release-sources.json`; Standard: mindestens 1200 ms Delay, 12000 ms Timeout.
- User-Agent ist identifizierbar und kontaktierbar.
- Fehler erzeugen Diagnose-/Review-Queue-Einträge, keine Fake-Daten.
- Provider raten keine Release-Dates und erzeugen keine Platzhalterdaten.
- `data/release-cache.json` wird nur durch reguläre High-Confidence-Pipeline-Patches verändert.

## Weiteren Verlag aktivieren

1. robots.txt und ToS/Shop-Hinweise am Aktivierungsdatum prüfen und diese Tabelle aktualisieren.
2. Bestehendes Skeleton in `scripts/release-providers/<id>-provider.js` mit `search` und `parseProduct` füllen.
3. JSON-LD oder eine andere stabile strukturierte Quelle bevorzugen; CSS-/HTML-Fallbacks nur defensiv.
4. Fixture-HTML unter `tests/fixtures/release-providers/<id>/` ablegen; keine Live-Requests in CI.
5. Tests in `scripts/test-publisher-providers.js` ergänzen.
6. Quelle in `data/release-sources.json` auf `enabled: true` setzen und Provider in `index.js` registrieren.
7. `node --check`, Provider-Tests und Release-Validatoren ausführen.

## Zusammenhang mit Phase 25/26

Phase 25 hat die automatische PR-basierte Pipeline eingeführt. Phase 26 hat Manga Passion aus dem Pipeline-Runner in einen Provider ausgelagert. Phase 40 ergänzt nun das generische Verlagsprovider-Gerüst und Carlsen als zweite produktive Quelle; die Confidence-, Konflikt- und Review-Queue-Regeln bleiben maßgeblich.
