# Release-Provider-System (Phase 26/40)

Die Release-Cache-Pipeline kapselt Quellenpruefungen in Provider. Die Pipeline bleibt konservativ: Provider liefern nur belegte Kandidaten; `scripts/release-confidence.js` entscheidet weiterhin, ob ein Treffer automatisch in `data/release-cache.json` uebernommen werden darf.

## Einstiegspunkte

```text
scripts/release-providers/
  index.js
  provider-utils.js
  publisher-provider-base.js
  generic-publisher-provider.js
  manga-passion-provider.js
  carlsen-provider.js
  *-provider.js          # produktive Publisher-Provider
```

- `index.js` registriert produktive Provider und waehlt sie anhand von `data/release-sources.json` aus.
- `provider-utils.js` enthaelt gemeinsame Hilfen fuer HTTPS-Fetches, ISBN-Normalisierung und Provider-Ergebnisfelder.
- `publisher-provider-base.js` ist das Grundgeruest: Publisher-Alias-Pruefung, HTML-Fetch mit Request-Policy und Normalisierung von `search` + `parseProduct`.
- `generic-publisher-provider.js` ist die generische HTML/JSON-LD-Implementierung fuer einfache Verlags- und Shopseiten.
- `manga-passion-provider.js` bleibt der Aggregator-Provider.
- `carlsen-provider.js` ist die spezialisierte Carlsen-Referenzimplementierung.

## Aktive Provider

| Provider | Status | Quelle | Zweck |
|---|---|---|---|
| `manga-passion` | aktiv | `https://www.manga-passion.de` API | Aggregator-Abgleich wie seit Phase 26 |
| `carlsen` | aktiv | Carlsen-Suche + Produktseiten | Carlsen Manga und Hayabusa-Alias |
| `altraverse` | aktiv | Altraverse-Suche + Produktseiten | Altraverse-Watchlist-Baende |
| `egmont` | aktiv | Egmont-Suche/Produktseiten | Egmont-Manga-Watchlist-Baende |
| `panini` | aktiv | Panini-Shop-Suche/Produktseiten | Panini-Manga-Watchlist-Baende |
| `tokyopop` | aktiv | Tokyopop-Suche/Produktseiten | Tokyopop-Watchlist-Baende |
| `manga-cult` | aktiv | Manga-Cult/Cross-Cult-Produktseiten | Manga-Cult-Watchlist-Baende |
| `mangamoon` | aktiv | Animoon/MangaMoon-Shop | MangaMoon-Watchlist-Baende |
| `dani-books` | aktiv | dani-books Suche/Produktseiten | dani-books-Watchlist-Baende |
| `dokico` | aktiv | Dokico-Shop | Dokico-Watchlist-Baende |
| `hayabusa` | aktiv | Hayabusa-Suche/Produktseiten | Hayabusa-Watchlist-Baende; Carlsen bleibt Fallback ueber Alias |
| `yomeru` | aktiv | Yomeru-Shop | Yomeru-Watchlist-Baende |
| `crunchyroll-manga` | aktiv | Crunchyroll/Kaze-URLs | Crunchyroll-/Kaze-Manga-Watchlist-Baende |

Die nicht-Carlsen-Verlagsprovider nutzen die generische HTML/JSON-LD-Referenzimplementierung. Sie sind konservativ: ohne belegten Produktnamen, Bandnummer und reales Datum liefern sie `no-edition-found` oder einen Fetch-/Parser-Diagnoseeintrag statt Fake-Daten.

## Publisher-Provider-Base

`buildPublisherProvider({ id, sourceName, baseUrl, publisherAliases, search, parseProduct })` erzeugt einen Provider mit einheitlichem `findRelease(candidate, context)`:

1. Request-Policy aus `data/release-sources.json`, optional source-spezifisch und durch `context.policy` ueberschreibbar.
2. Publisher-Alias-Guard: nicht zustaendige Provider verursachen keinen Live-Request.
3. `search(candidate, ctx)` liefert nur Produkt-Hits, keine geratenen Daten.
4. `parseProduct(hit, candidate, ctx)` extrahiert Pflicht-/Optionalfelder ausschliesslich aus HTML/JSON-LD.
5. Treffer werden mit `normalizeProviderResult` vereinheitlicht.
6. Fetch-/Parserfehler liefern Diagnosefelder statt Fake-Daten.

Pflichtfelder fuer High Confidence bleiben unveraendert: `seriesTitle`, `publisher`, `volumeNumber`, `releaseDate`, `sourceUrl`, `sourceName`, `providerId`, `checkedAt`, `evidence`, plus belegte `sourceEditionTitle`, `sourcePublisher` und `sourceVolumeNumber`.

## Generischer Publisher-Provider

`generic-publisher-provider.js` kapselt wiederverwendbare Parser-Logik:

- Suche ueber pro Provider konfiguriertes `searchUrlTemplate`.
- Produkt-URL-Filter ueber `hostnames` und `productPathPatterns`.
- JSON-LD `Product`/`Book` wird bevorzugt.
- HTML-Fallbacks lesen `h1`, `og:title`, `title`, ISBN-/EAN-Zeilen und sichtbare Datumsfelder.
- Bandnummer muss im Produktnamen nachweisbar sein.
- `releaseDate` muss ein echtes ISO- oder deutsches Datum sein; Platzhalter wie `2999-12-31` werden nicht akzeptiert.

## Carlsen-Referenzimplementierung

`carlsen-provider.js` verwendet:

- `publisherAliases`: `Carlsen`, `Hayabusa`, `Carlsen Manga` (kanonisch zuletzt).
- Suche: `https://www.carlsen.de/suche?q=<Titel> Band <Nummer>`.
- Produktfilter: Carlsen-Produktpfade unter `/manga/`, `/softcover/`, `/hardcover/`, `/taschenbuch/`, `/produkt/` oder ISBN-Pfade.
- Parser: JSON-LD `Product`/`Book` bevorzugt; sichtbares HTML nur als Fallback fuer Titel/Datum.
- ISBN/Cover: nur aus `gtin13`/`isbn`/`image` oder eindeutigem HTML-ISBN-Feld.

Ein Treffer kann allein High Confidence werden, wenn Titel, Publisher-Alias, Bandnummer, echtes Datum und erlaubte URL zusammenpassen. Kollidieren mehrere High-Treffer, blockiert `buildProviderConflictCandidate` den Cache-Patch.

## Robots-/ToS-Notiz

Pruefdatum: 2026-05-24. Pruefmethode: oeffentlicher Abruf der jeweiligen `robots.txt` mit identifizierbarem User-Agent `MangaTrackerReleaseBot/1.0 (+https://github.com/SharkOneK/manga-tracker)`. Diese Tabelle ist eine technische Aktivierungsnotiz, keine Rechtsberatung.

| Quelle | robots.txt / Befund | Phase-40-Status |
|---|---|---|
| Carlsen | `https://www.carlsen.de/robots.txt` erreichbar; oeffentliche Suche/Produktpfade nicht pauschal gesperrt. | Aktiv, konservativ mit Delay. |
| Altraverse | `https://altraverse.de/robots.txt` erreichbar; Shop-/Account-/Checkout-Pfade gesperrt. | Aktiv; Account-/Checkout-Pfade tabu. |
| Egmont Manga | `https://www.egmont-manga.de/robots.txt` erreichbar; `User-agent: *` sperrt u. a. `/EPiServer` und `/util`; mehrere KI-Crawler pauschal gesperrt. | Aktiv mit konservativer Suche; bei robots-Aenderung per `enabled:false` abschaltbar. |
| Panini | `https://www.paninishop.de/robots.txt` lieferte HTML/Redirect statt klarer robots-Datei. | Aktiv, aber bei robots-/Redirect-Unklarheit sofort per `enabled:false` deaktivierbar. |
| Tokyopop | `https://www.tokyopop.de/robots.txt` erreichbar; Medien/PDF/ZIP-Pfade teils gesperrt. | Aktiv; Medien/PDF-Pfade werden nicht genutzt. |
| Manga Cult | `https://www.manga-cult.de/robots.txt` lieferte TYPO3/Redirect-HTML zu Cross Cult. | Aktiv mit Cross-Cult-Allowlist; bei Blockade nur Review-Diagnose. |
| MangaMoon / Animoon | `https://animoon-publishing.de/robots.txt` erreichbar; Shopify-Hinweise, oeffentliche Produktseiten crawlbar, Checkout strikt ausgenommen. | Aktiv; Checkout/Cart strikt ausgenommen. |
| dani books | `https://dani-books.com/robots.txt` nicht erreichbar/Domain-Aufloesung fehlgeschlagen. | Provider aktivierbar; Fetch-Fehler werden konservativ in Review geroutet. |
| Dokico | `https://dokico.de/robots.txt` erreichbar; Shopify-Hinweise, oeffentliche Produktseiten crawlbar, Checkout strikt ausgenommen. | Aktiv; Checkout/Cart strikt ausgenommen. |
| Hayabusa | `https://hayabusa.de/robots.txt` erreichbar. | Aktiv; zusaetzlich ueber Carlsen-Alias abgedeckt. |
| Yomeru | `https://yomeru.de/robots.txt` erreichbar; WordPress/WooCommerce-Admin-, Log- und Add-to-cart-Pfade gesperrt. | Aktiv; Admin/Add-to-cart-Pfade werden nicht genutzt. |
| Crunchyroll Manga | `https://www.crunchyroll.com/robots.txt` erreichbar; Suchpfade und technische Pfade gesperrt. | Aktiv, aber Suchpfad-Sperren sind zu beachten; bei Blockade nur Review-Diagnose. |
| Kaze Legacy | `https://www.kaze-online.de/robots.txt` lieferte Website-HTML/Redirect statt klarer robots-Datei. | Nur als Legacy-Allowlist dokumentiert. |

## Sicherheitsregeln

- Nur HTTPS-URLs, keine Cookies, keine Logins, keine Captcha-/Checkout-/Account-Bereiche.
- Request-Limits kommen aus `data/release-sources.json`; Standard: mindestens 1200 ms Delay, 12000 ms Timeout.
- User-Agent ist identifizierbar und kontaktierbar.
- Fehler erzeugen Diagnose-/Review-Queue-Eintraege, keine Fake-Daten.
- Provider raten keine Release-Dates und erzeugen keine Platzhalterdaten.
- `data/release-cache.json` wird nur durch regulaere High-Confidence-Pipeline-Patches veraendert.

## Weiteren Verlag ergaenzen oder anpassen

1. robots.txt und ToS/Shop-Hinweise am Aktivierungsdatum pruefen und diese Tabelle aktualisieren.
2. Fuer einfache Shops bevorzugt `generic-publisher-provider.js` konfigurieren; nur bei Bedarf eine eigene `search`-/`parseProduct`-Implementierung schreiben.
3. JSON-LD oder eine andere stabile strukturierte Quelle bevorzugen; CSS-/HTML-Fallbacks nur defensiv.
4. Fixture-HTML unter `tests/fixtures/release-providers/<id>/` ablegen; keine Live-Requests in CI.
5. Tests in `scripts/test-publisher-providers.js` ergaenzen.
6. Quelle in `data/release-sources.json` pruefen und Provider in `index.js` registrieren.
7. `node --check`, Provider-Tests und Release-Validatoren ausfuehren.

## Zusammenhang mit Phase 25/26

Phase 25 hat die automatische PR-basierte Pipeline eingefuehrt. Phase 26 hat Manga Passion aus dem Pipeline-Runner in einen Provider ausgelagert. Phase 40 ergaenzt nun das generische Verlagsprovider-Geruest, Carlsen als spezialisierte Quelle und die weiteren Verlagsprovider auf Basis der generischen HTML/JSON-LD-Implementierung; die Confidence-, Konflikt- und Review-Queue-Regeln bleiben massgeblich.
