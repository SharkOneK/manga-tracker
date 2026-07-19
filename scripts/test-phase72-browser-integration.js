#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase72-browser-integration.js — Tester-Ergänzung (Phase 72)
 *
 * Läuft NICHT über node scripts/run-all-checks.js (benötigt einen echten
 * Chromium-Browser via Playwright, analog scripts/smoke-browser-phase36a.js).
 * Zweck: die drei realen Migrationspfade (Boot, loadFromCloud(), Import) und
 * die Public-Projection GEGEN DEN ECHTEN src/app.js verifizieren — nicht gegen
 * die vom Coder gepflegten DOM-freien Mirror-Funktionen in scripts/test-*.js.
 *
 * Aufruf: node scripts/test-phase72-browser-integration.js
 * Voraussetzung: `npx playwright install chromium` (einmalig).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const repoRoot = path.resolve(__dirname, '..');

let _passed = 0;
let _failed = 0;
const failures = [];

async function runTest(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
    _failed++;
    failures.push({ name, error: e && e.message ? e.message : String(e) });
  }
}

// ─── Mini static file server (serves repo root, wie ein einfacher Webserver) ─
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(repoRoot, reqPath);
      if (!filePath.startsWith(repoRoot)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + reqPath); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function freshSession() {
  return JSON.stringify({
    access_token: 'jwt-test-1',
    refresh_token: 'refresh-test-1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

const SESSION_KEY = 'sb-sssxiqtnkctvyghyrqff-auth-token';

(async function main() {
  console.log('\nPhase 72 — Browser-Integrationstests (echtes src/app.js, kein Mirror)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test 1: Boot-Migrationspfad + TDZ-Absturzcheck ──────────────────────
    await runTest('Boot: kein ReferenceError beim ersten Laden (TDZ-Fix MEDIA_TYPES/SCHEMA_VERSION)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e));

      // Hinweis: KEIN literaler `null`-Array-Eintrag hier — das triggert eine vorbestehende,
      // von Phase 72 unabhaengige Render-Luecke (verifiziert gegen den Parent-Commit 8213cb8:
      // ein `null`-Eintrag in db.m crasht render() mit "Cannot read properties of null (reading
      // 'title')", UNABHAENGIG von Phase 72). Der migrateBands()-Null-Guard selbst ist bereits
      // durch scripts/test-data-integrity.js ("migrateMediaType wirft nicht bei null-Eintraegen")
      // abgedeckt. Hier geht es nur um den TDZ-Fix beim echten Boot.
      await page.addInitScript((seedDb) => {
        localStorage.setItem('mtDE', JSON.stringify(seedDb));
      }, {
        m: [
          { id: 'boot-1', title: 'Ohne mediaType', bands: {} },
          { id: 'boot-2', title: 'Gueltig Serie', mediaType: 'series', bands: {} },
          { id: 'boot-3', title: 'Ungueltig', mediaType: 'movie', bands: {} },
          { id: 'boot-4', title: 'Null-Wert', mediaType: null, bands: {} },
        ],
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const refErrors = pageErrors.filter((e) => /ReferenceError/.test(String(e)));
      if (refErrors.length) {
        throw new Error('ReferenceError beim Boot aufgetreten (TDZ nicht gefixt): ' + refErrors.map(String).join(' | '));
      }
      if (pageErrors.length) {
        throw new Error('Unerwartete pageerror-Events beim Boot: ' + pageErrors.map(String).join(' | '));
      }

      const raw = await page.evaluate(() => localStorage.getItem('mtDE'));
      const db = JSON.parse(raw);
      const byId = Object.fromEntries(db.m.filter(Boolean).map((m) => [m.id, m]));
      if (byId['boot-1'].mediaType !== 'manga') throw new Error('boot-1 (fehlendes mediaType) sollte "manga" sein, war: ' + byId['boot-1'].mediaType);
      if (byId['boot-2'].mediaType !== 'series') throw new Error('boot-2 (gueltig series) darf nicht ueberschrieben werden, war: ' + byId['boot-2'].mediaType);
      if (byId['boot-3'].mediaType !== 'manga') throw new Error('boot-3 (ungueltig movie) sollte auf "manga" korrigiert werden, war: ' + byId['boot-3'].mediaType);
      if (byId['boot-4'].mediaType !== 'manga') throw new Error('boot-4 (null) sollte auf "manga" korrigiert werden, war: ' + byId['boot-4'].mediaType);
      if (db.schemaVersion !== 3) throw new Error('db.schemaVersion sollte nach Boot 3 sein, war: ' + db.schemaVersion);

      await context.close();
    });

    // ── Test 2: loadFromCloud() — der kritische Pfad ohne migrateBands() ───
    await runTest('loadFromCloud(): mediaType-Default wird gesetzt, obwohl migrateBands() NICHT durchlaufen wird', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e));

      const collectionsCalls = [];
      await page.route('**/rest/v1/collections*', async (route) => {
        collectionsCalls.push(route.request().method());
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'col1' }]) });
      });
      await page.route('**/rpc/get_owner_collection_for_user', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            m: [
              { id: 'cloud-1', title: 'Cloud ohne Typ', bands: {} },
              { id: 'cloud-2', title: 'Cloud Anime', mediaType: 'anime', bands: {} },
              { id: 'cloud-3', title: 'Cloud kaputt', mediaType: 'movie', bands: {} },
            ],
          }),
        });
      });

      await page.addInitScript((session) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', session);
        localStorage.setItem('mtCollId', 'col1');
        localStorage.setItem('mtDE', JSON.stringify({ m: [] }));
      }, freshSession());

      await page.goto(base, { waitUntil: 'load' });
      // loadFromCloud() wird im Init-Pfad automatisch angestossen (mtCollId gesetzt).
      await page.waitForTimeout(800);

      if (pageErrors.length) {
        throw new Error('Unerwartete pageerror-Events bei loadFromCloud(): ' + pageErrors.map(String).join(' | '));
      }

      const raw = await page.evaluate(() => localStorage.getItem('mtDE'));
      const db = JSON.parse(raw);
      const byId = Object.fromEntries(db.m.map((m) => [m.id, m]));
      if (byId['cloud-1'].mediaType !== 'manga') throw new Error('cloud-1 sollte "manga" sein, war: ' + byId['cloud-1'].mediaType);
      if (byId['cloud-2'].mediaType !== 'anime') throw new Error('cloud-2 (gueltig anime) darf nicht ueberschrieben werden, war: ' + byId['cloud-2'].mediaType);
      if (byId['cloud-3'].mediaType !== 'manga') throw new Error('cloud-3 (ungueltig movie) sollte auf "manga" korrigiert werden, war: ' + byId['cloud-3'].mediaType);

      // Spec-Vorgabe: Migration darf beim Cloud-Load KEINEN zusaetzlichen pushCloud() ausloesen
      // (genresAdded darf dafuer nicht mitbenutzt werden) — es darf also kein PATCH auf
      // /rest/v1/collections erfolgen, ausgeloest allein durch die mediaType-Normalisierung.
      const patchCalls = collectionsCalls.filter((m) => m === 'PATCH');
      if (patchCalls.length) throw new Error('loadFromCloud() hat einen PATCH auf collections ausgeloest, obwohl nur mediaType normalisiert wurde (unerwarteter pushCloud())');

      await context.close();
    });

    // ── Test 3: Import-Pfad (handleImportFile) — dritter Migrationspfad ────
    await runTest('Import: mediaType-Default wird gesetzt (fehlender Wert), gueltiger Wert bleibt erhalten', async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      await page.addInitScript((session) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', session);
        localStorage.setItem('mtDE', JSON.stringify({ m: [] }));
      }, freshSession());

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500); // discoverAndLoadOwnCollection() abwarten (findet keine ids)

      const importPayload = {
        schemaVersion: 2,
        series: [
          { id: 'imp-1', title: 'Import ohne Typ', bands: {} },
          { id: 'imp-2', title: 'Import mit Typ', mediaType: 'series', bands: {} },
        ],
      };
      const tmpFile = path.join(os.tmpdir(), `mt-phase72-import-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(importPayload));

      const [download] = await Promise.all([
        page.waitForEvent('download').catch(() => null), // lokales Backup vor Import
        page.setInputFiles('#import-file-input', tmpFile),
      ]);
      if (download) await download.cancel().catch(() => {});
      await page.waitForTimeout(500);

      const raw = await page.evaluate(() => localStorage.getItem('mtDE'));
      const db = JSON.parse(raw);
      const byId = Object.fromEntries(db.m.map((m) => [m.id, m]));
      if (!byId['imp-1'] || byId['imp-1'].mediaType !== 'manga') throw new Error('imp-1 (fehlendes mediaType) sollte "manga" sein, war: ' + (byId['imp-1'] && byId['imp-1'].mediaType));
      if (!byId['imp-2'] || byId['imp-2'].mediaType !== 'series') throw new Error('imp-2 (gueltig series) sollte erhalten bleiben, war: ' + (byId['imp-2'] && byId['imp-2'].mediaType));

      fs.unlinkSync(tmpFile);
      await context.close();
    });

    // ── Test 4: Import mit explizit ungueltigem mediaType wirft Fehler ─────
    await runTest('Import: explizit ungueltiger mediaType ("movie") wirft Importfehler mit Eintragsnummer, normalisiert NICHT still', async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      await page.addInitScript((session) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', session);
        // Bewusst KEIN mtDE gesetzt: die App seedet beim allerersten Boot ihre eingebaute
        // Startsammlung (upsertManga()-Aufrufe in src/app.js) — das ist bestehendes,
        // von Phase 72 unabhaengiges Verhalten. Wir vergleichen daher nicht gegen "leer",
        // sondern gegen einen Snapshot der IDs VOR dem fehlschlagenden Import.
      }, freshSession());

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const idsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('mtDE')).m.map((m) => m.id).sort());

      const importPayload = {
        schemaVersion: 2,
        series: [
          { id: 'bad-1', title: 'Kaputter Import', mediaType: 'movie', bands: {} },
        ],
      };
      const tmpFile = path.join(os.tmpdir(), `mt-phase72-import-bad-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(importPayload));

      await page.setInputFiles('#import-file-input', tmpFile);
      await page.waitForTimeout(400);

      const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
      if (!/fehlgeschlagen/i.test(toastText)) throw new Error('Erwartete Fehlermeldung im Toast, bekam: "' + toastText + '"');
      if (!/1/.test(toastText)) throw new Error('Erwartete Eintragsnummer in der Fehlermeldung, bekam: "' + toastText + '"');
      if (!/mediaType/.test(toastText)) throw new Error('Erwartete Hinweis auf mediaType in der Fehlermeldung, bekam: "' + toastText + '"');

      const raw = await page.evaluate(() => localStorage.getItem('mtDE'));
      const db = JSON.parse(raw);
      if (db.m.some((m) => m.id === 'bad-1')) throw new Error('Fehlgeschlagener Import darf "bad-1" nicht in die Sammlung uebernehmen');
      const idsAfter = db.m.map((m) => m.id).sort();
      if (JSON.stringify(idsBefore) !== JSON.stringify(idsAfter)) {
        throw new Error('Fehlgeschlagener Import darf die Sammlung nicht veraendern. Vorher: ' + idsBefore.length + ' Eintraege, nachher: ' + idsAfter.length);
      }

      fs.unlinkSync(tmpFile);
      await context.close();
    });

    // ── Test 5: buildPublicCollectionData — echte Funktion, nicht Mirror ───
    await runTest('buildPublicCollectionData() (echte Implementierung): mediaType/seasons drin, private Felder draussen', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => { localStorage.setItem('mtDE', JSON.stringify({ m: [] })); });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(200);

      const result = await page.evaluate(() => {
        const input = {
          schemaVersion: 3,
          m: [{
            id: 'pub-1', title: 'Geheim', pub: 'Verlag', bands: { 1: 'completed' },
            total: 1, ongoing: 'true', nextDate: null, cover: 'https://x/cover.jpg',
            bandCovers: {}, genres: ['Drama'], status: 'reading',
            mediaType: 'series', seasons: { 1: 2, 2: null, 3: 0 },
            notes: 'privater Text', isbn13: '9780000000000',
            startedAt: '2026-01-01', finishedAt: null, mpEditionId: 'priv',
            owner_token: 'sollte-nie-rausgehen', view_token: 'auch-nicht',
          }],
        };
        // buildPublicCollectionData ist ein globaler Funktions-Bezeichner (klassisches <script>,
        // kein Modul) — hier wird die ECHTE Implementierung aus src/app.js aufgerufen.
        return buildPublicCollectionData(input);
      });

      const keys = Object.keys(result.m[0]).sort();
      const forbidden = ['notes', 'isbn13', 'startedAt', 'finishedAt', 'mpEditionId', 'owner_token', 'view_token', 'owner_token_hash', 'view_token_hash'];
      const leaked = forbidden.filter((f) => keys.includes(f));
      if (leaked.length) throw new Error('Private Felder in echter Public Projection gefunden: ' + leaked.join(', '));
      if (!keys.includes('mediaType')) throw new Error('mediaType fehlt in der echten Public Projection');
      if (!keys.includes('seasons')) throw new Error('seasons fehlt in der echten Public Projection');
      if (result.m[0].mediaType !== 'series') throw new Error('mediaType sollte "series" sein, war: ' + result.m[0].mediaType);
      if (JSON.stringify(result.m[0].seasons) !== JSON.stringify({ 1: 2, 3: 0 })) {
        throw new Error('seasons sollte {1:2,3:0} sein (season:0 erhalten, season:null gefiltert), war: ' + JSON.stringify(result.m[0].seasons));
      }

      await context.close();
    });

    // ── Test 6: unbekannter mediaType-Wert in buildPublicCollectionData ────
    await runTest('buildPublicCollectionData() (echte Implementierung): manipulierter/unbekannter mediaType wird auf "manga" normalisiert', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => { localStorage.setItem('mtDE', JSON.stringify({ m: [] })); });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(200);

      const result = await page.evaluate(() => {
        const input = {
          m: [
            { id: 'x1', title: 'Foo', bands: {}, mediaType: 'foo' },
            { id: 'x2', title: 'Null', bands: {}, mediaType: null },
            { id: 'x3', title: 'Zahl', bands: {}, mediaType: 42 },
          ],
        };
        return buildPublicCollectionData(input);
      });
      result.m.forEach((m) => {
        if (m.mediaType !== 'manga') throw new Error(`Eintrag ${m.id}: mediaType sollte "manga" sein, war ${JSON.stringify(m.mediaType)}`);
      });

      await context.close();
    });

    // ── Test 7: mediaType/MEDIA_TYPES-Whitelist-Duplikat — Divergenz-Erkennung ─
    await runTest('validMediaTypes (lokal in buildPublicCollectionData) und globale MEDIA_TYPES-Konstante sind deckungsgleich', async () => {
      const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'app.js'), 'utf8');
      const globalMatch = appJs.match(/const MEDIA_TYPES = (\[[^\]]*\]);/);
      const localMatch = appJs.match(/const validMediaTypes = (\[[^\]]*\]);/);
      if (!globalMatch) throw new Error('Globale MEDIA_TYPES-Konstante nicht gefunden — Regex evtl. veraltet');
      if (!localMatch) throw new Error('Lokale validMediaTypes-Konstante in buildPublicCollectionData nicht gefunden — Regex evtl. veraltet');
      // eslint-disable-next-line no-eval
      const globalArr = eval(globalMatch[1]);
      // eslint-disable-next-line no-eval
      const localArr = eval(localMatch[1]);
      if (JSON.stringify([...globalArr].sort()) !== JSON.stringify([...localArr].sort())) {
        throw new Error(
          'FINDING (kein Testfehler im Sinne von "kaputt", aber Risiko): MEDIA_TYPES=' + JSON.stringify(globalArr) +
          ' und validMediaTypes=' + JSON.stringify(localArr) + ' sind NICHT deckungsgleich. ' +
          'Da beide Listen unabhaengig gepflegt werden, wuerde ein Divergieren von keinem bestehenden ' +
          'Check automatisch erkannt (security-audit-static.js Check 28 prueft nur auf verbotene Feldnamen, ' +
          'nicht auf eine Whitelist-Uebereinstimmung).'
        );
      }
    });

    // ── Test 8: Medienfilter bei gemischten mediaTypes + Genre-Filter (echtes DOM) ─
    await runTest('Medienfilter (echtes DOM): Sichtbarkeit, Filterung und Zusammenspiel mit Genre-Filter/Suche', async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      // Titel bewusst so gewaehlt, dass sie mit KEINEM der ~59 fest im HTML seedenden
      // upsertManga()-Schluessel per Substring kollidieren (z.B. wuerde "Attack on Titan
      // Anime" den vorhandenen Seed-Key 'attack on titan' treffen und dessen Felder
      // veraendern) — das ist ein bestehendes, Phase-72-unabhaengiges Seed-Verhalten,
      // dem wir hier bewusst ausweichen, um den Test deterministisch zu halten.
      const mixedDb = {
        schemaVersion: 3,
        m: [
          { id: 'm1', title: 'Zqx Manga Testserie', pub: 'Panini', mediaType: 'manga', genres: ['Action', 'Fantasy'], bands: { 1: 'owned' }, status: 'owned' },
          { id: 'm2', title: 'Zqx Serie Testserie', pub: 'Panini', mediaType: 'series', genres: ['Action', 'Drama'], bands: { 1: 'owned' }, status: 'owned' },
          { id: 'm3', title: 'Zqx Anime Testserie', pub: 'Kaze', mediaType: 'anime', genres: ['Action'], bands: { 1: 'owned' }, status: 'owned' },
        ],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: mixedDb });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      // "owned"-Tab anzeigen (alle drei Testeintraege liegen dort, mSeriesStatus === 'owned').
      // Phase 60: reading/completed/owned starten per Default in der Baendenansicht (☰);
      // der Medienfilter ist laut Spec bewusst NUR in die Serienansicht (⊞) eingehaengt
      // (renderSeriesGrid), nicht in renderBandStatusList — deshalb explizit auf ⊞ umschalten.
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(300);

      // BEFUND (reproduzierbar, siehe .pipeline/test-results.md für Details):
      // shouldShowMediaFilter(db.m) ist hier nachweislich true (gemischte Sammlung aus
      // manga/series/anime), aber #media-filter bleibt trotzdem unsichtbar. Ursache:
      // updateMediaFilter() setzt im sichtbaren Zweig `sel.style.display = ''` — ein LEERER
      // Inline-Style-Wert entfernt lediglich einen vorherigen Override, er UEBERSCHREIBT NICHT
      // die CSS-Klasse `hidden` (`.hidden { display: none; }`), die #media-filter in index.html
      // fest zugewiesen ist. Da nichts die Klasse `hidden` je entfernt, bleibt das Element
      // dauerhaft display:none — das Feature ist in der Praxis nie sichtbar/bedienbar.
      // Gegenprobe (siehe test-results.md): sel.classList.remove('hidden') macht das Element
      // sofort sichtbar (computed display wechselt von 'none' zu 'block'), was die Ursache
      // eindeutig auf die fehlende Klassenentfernung zurückführt.
      const diag = await page.evaluate(() => {
        const sel = document.getElementById('media-filter');
        return {
          shouldShow: shouldShowMediaFilter(db.m),
          tab, viewMode,
          rawStyleDisplay: sel.style.display,
          className: sel.className,
          computed: window.getComputedStyle(sel).display,
        };
      });
      if (diag.computed === 'none') {
        throw new Error(
          'BUG gefunden: #media-filter bleibt unsichtbar (computed display=none), obwohl shouldShowMediaFilter(db.m)=' +
          diag.shouldShow + ' (Tab=' + diag.tab + ', viewMode=' + diag.viewMode + '). ' +
          'updateMediaFilter() setzt sel.style.display=' + JSON.stringify(diag.rawStyleDisplay) +
          ' — das entfernt NICHT die CSS-Klasse "' + diag.className + '" (.hidden { display:none } in src/styles.css), ' +
          'die #media-filter in index.html hart zugewiesen ist. Der Medienfilter ist dadurch in der echten App ' +
          'niemals sichtbar/bedienbar, unabhaengig davon wie viele Medientypen die Sammlung enthaelt.'
        );
      }

      // Filter auf "series" setzen -> nur Zqx Serie Testserie sichtbar
      await page.selectOption('#media-filter', 'series');
      await page.waitForFunction(() => document.getElementById('content').textContent.includes('Zqx Serie Testserie'), undefined, { timeout: 5000 });
      const gridHtml = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Serie Testserie/.test(gridHtml)) throw new Error('Nach Filter "series" sollte "Zqx Serie Testserie" sichtbar sein. Grid: ' + gridHtml.slice(0, 300));
      if (/Zqx Manga Testserie/.test(gridHtml) || /Zqx Anime Testserie/.test(gridHtml)) throw new Error('Nach Filter "series" duerfen Zqx Manga/Anime Testserie nicht sichtbar sein. Grid: ' + gridHtml.slice(0, 300));

      // Zusammenspiel mit Genre-Filter (Phase 67): zusaetzlich Genre "Drama" aktivieren -> weiterhin nur Zqx Serie Testserie (hat Drama)
      const genreChip = page.locator('[data-action="set-genre-filter"][data-genre="Drama"]');
      if (await genreChip.count()) {
        await genreChip.click();
        await page.waitForTimeout(250);
        const gridHtml2 = await page.evaluate(() => document.getElementById('content').textContent);
        if (!/Zqx Serie Testserie/.test(gridHtml2)) throw new Error('Medienfilter "series" UND Genre-Filter "Drama" sollten Zqx Serie Testserie weiterhin zeigen. Grid: ' + gridHtml2.slice(0, 300));
      }

      // Genre-Filter zuruecksetzen. Der Medienfilter bleibt bewusst AKTIV auf "series" —
      // genau das ist der von der Reviewer-Review (F1) verlangte Edge Case: "Filter aktiv,
      // dann letzte Nicht-Manga-Serie geloescht" (spec.md:99). Ein vorzeitiger Reset des
      // Medienfilters wuerde den zu pruefenden Zustand nie erreichen (das war der Fehler im
      // vorherigen Testlauf, den der Reviewer bemaengelt hat).
      const allGenreChip = page.locator('[data-action="set-genre-filter"][data-genre=""]');
      if (await allGenreChip.count()) {
        await allGenreChip.click();
        await page.waitForTimeout(150);
      }

      // Jetzt: letzte Nicht-Manga-Serien (series+anime) "loeschen", WAEHREND der Medienfilter
      // noch aktiv auf "series" steht -> rawItems wuerde mit dem alten Filterwert leer sein,
      // wenn der Reset (reconcileMediaFilterState()) nicht VOR der Filterkette laeuft.
      await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('mtDE'));
        raw.m = raw.m.filter((m) => m.mediaType === 'manga');
        localStorage.setItem('mtDE', JSON.stringify(raw));
        // db im Speicher direkt nachziehen und rendern (kein Reload noetig, echte App-Funktionen nutzen)
        db.m = raw.m;
        render();
      });
      await page.waitForTimeout(200);

      // (a) Die Bibliothek zeigt die verbliebene Manga-Serie -- NICHT leer, obwohl der
      // (jetzt veraltete) Medienfilter "series" sonst rawItems auf 0 Eintraege reduzieren
      // wuerde. Das ist die eigentliche Regression aus F1: ohne den vorgezogenen Reset
      // waere hier der Empty-State-Pfad sichtbar, obwohl Mangas existieren.
      const gridAfterDelete = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Manga Testserie/.test(gridAfterDelete)) {
        throw new Error(
          'Nach Loeschen der letzten Nicht-Manga-Serie bei noch aktivem Medienfilter "series" muss die ' +
          'verbliebene Manga-Serie "Zqx Manga Testserie" im Grid sichtbar sein -- die Bibliothek darf NICHT ' +
          'leer erscheinen, obwohl Mangas vorhanden sind (spec.md:99, F1 aus dem Review). Grid: ' +
          gridAfterDelete.slice(0, 300)
        );
      }

      // (b) filterMedia wurde von der Produktivlogik selbst zurueckgesetzt (nicht vom Test).
      const filterMediaResetValue = await page.evaluate(() => typeof filterMedia !== 'undefined' ? filterMedia : 'UNDEFINED');
      if (filterMediaResetValue !== '') throw new Error('filterMedia sollte nach Verschwinden des Filters zurueckgesetzt sein ("" ), war: ' + JSON.stringify(filterMediaResetValue));

      // (c) das Select ist unsichtbar (nur noch ein Medientyp vorhanden).
      const mediaFilterHiddenAfterDelete = await page.evaluate(() => {
        const sel = document.getElementById('media-filter');
        return !sel || window.getComputedStyle(sel).display === 'none';
      });
      if (!mediaFilterHiddenAfterDelete) throw new Error('Nach Loeschen der letzten Nicht-Manga-Serie muss der Medienfilter wieder unsichtbar sein');

      await context.close();
    });

    // ── Test 9: reine Manga-Sammlung — Medienfilter bleibt unsichtbar (Nicht-Regression) ─
    await runTest('Reine Manga-Sammlung: Medienfilter bleibt unsichtbar, keine Phantom-UI', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      const onlyManga = {
        schemaVersion: 3,
        m: [
          { id: 'a1', title: 'One Piece', pub: 'Carlsen', mediaType: 'manga', genres: ['Action'], bands: { 1: 'owned', 2: 'owned' }, status: 'owned', total: 5 },
          { id: 'a2', title: 'Vagabond', pub: 'Carlsen', mediaType: 'manga', genres: ['Drama'], bands: { 1: 'owned' }, status: 'owned' },
        ],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: onlyManga });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series'); // Medienfilter haengt nur in der Serienansicht (⊞)
      await page.waitForTimeout(200);

      const mediaFilterVisible = await page.evaluate(() => {
        const sel = document.getElementById('media-filter');
        return !!sel && window.getComputedStyle(sel).display !== 'none';
      });
      if (mediaFilterVisible) throw new Error('Medienfilter darf bei reiner Manga-Sammlung nicht sichtbar sein');

      // Nicht-Regression: NUR die beiden eigens gesetzten Manga sollen im "owned"-Badge
      // zusaetzlich zur eingebauten Startsammlung auftauchen — wir vergleichen daher nicht
      // gegen eine feste Zahl, sondern gegen "Badge >= 2" plus Titel-Praesenz im Grid.
      const badgeOwned = await page.evaluate(() => Number(document.getElementById('c-owned').textContent));
      if (!(badgeOwned >= 2)) throw new Error('Tab-Badge "owned" sollte mindestens 2 sein (keine Phantom-Zaehlung/kein Datenverlust), war: ' + badgeOwned);

      const gridHtml = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/One Piece/.test(gridHtml) || !/Vagabond/.test(gridHtml)) throw new Error('Beide Manga-Serien sollten unveraendert angezeigt werden. Grid: ' + gridHtml.slice(0, 300));

      await context.close();
    });

    // ── Test 10: seasons-Roundtrip über echten doSave()-Aufruf (Edit-Speichern) ─
    await runTest('seasons-Roundtrip: echter doSave()-Aufruf verliert m.seasons nicht (staerkster denkbarer Datenverlust-Fall)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      const seedDb = {
        schemaVersion: 3,
        m: [{
          id: 'season-1', title: 'Serie mit Staffeln', pub: 'Panini',
          mediaType: 'series', bands: { 1: 'owned', 2: 'owned' },
          seasons: { 1: 1, 2: 2 }, status: 'owned', total: null, ongoing: 'true',
        }],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: seedDb });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(200);

      // Eintrag oeffnen (öffnet echtes Edit-Modal über openEdit()) und ohne inhaltliche
      // Aenderung speichern (kein Formularfeld fuer "seasons" existiert in Phase 72 —
      // genau der vom Coder dokumentierte Fall).
      const openResult = await page.evaluate(() => {
        const before = db.m.find((m) => m.id === 'season-1');
        openEdit('season-1');
        return { foundBefore: !!before, overlayDisplay: document.getElementById('overlay').style.display };
      });
      if (!openResult.foundBefore) throw new Error('Eintrag "season-1" vor openEdit() nicht in db.m gefunden — Seed-Setup fehlerhaft');
      if (openResult.overlayDisplay !== 'flex') throw new Error('openEdit() hat das Modal nicht geoeffnet (overlay.style.display=' + openResult.overlayDisplay + ')');
      await page.waitForTimeout(150);
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(300);

      const raw = await page.evaluate(() => localStorage.getItem('mtDE'));
      const db = JSON.parse(raw);
      const entry = db.m.find((m) => m.id === 'season-1');
      if (!entry) throw new Error('Eintrag nach Save nicht mehr gefunden');
      if (JSON.stringify(entry.seasons) !== JSON.stringify({ 1: 1, 2: 2 })) {
        throw new Error('seasons wurde beim Save-Roundtrip veraendert/verloren. Erwartet {"1":1,"2":2}, war: ' + JSON.stringify(entry.seasons));
      }

      await context.close();
    });

    // ── Test 11: sw.js CACHE_VERSION-Bump verifizieren ──────────────────────
    await runTest('sw.js: CACHE_VERSION wurde gegenueber v1 tatsaechlich erhoeht', async () => {
      const swJs = fs.readFileSync(path.join(repoRoot, 'sw.js'), 'utf8');
      const m = swJs.match(/const CACHE_VERSION = '([^']+)'/);
      if (!m) throw new Error('CACHE_VERSION-Konstante in sw.js nicht gefunden');
      if (m[1] === 'mt-pwa-v1') throw new Error('CACHE_VERSION wurde nicht erhoeht (steht noch auf v1)');
      if (m[1] !== 'mt-pwa-v2') throw new Error('CACHE_VERSION unerwarteter Wert: ' + m[1] + ' (Spec/Changes erwarten mt-pwa-v2)');
    });

    // ── Nachtest Fix-Durchlauf 1: Regressionsrisiko der renderSeriesGrid()-Umstellung ──
    // Die drei update*Filter()-Aufrufe wurden vor die beiden fruehen Returns gezogen.
    // Das betrifft nicht nur den neuen Medienfilter, sondern auch die vorbestehenden
    // Verlags-/Genre-Filter. Tests 12-14 pruefen das gezielt gegen das echte DOM.

    // ── Test 12: Genre-/Publikations-Filter-UI bleibt im Leer-Pfad (Suche ohne Treffer)
    // korrekt befuellt — nicht leer, nicht dupliziert ─────────────────────────────────
    await runTest('Regression: Verlags-/Genre-Filter-UI bleibt im Suche-ohne-Treffer-Pfad korrekt befuellt (kein Leerlaufen, keine Duplikate)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      const seedDb = {
        schemaVersion: 3,
        m: [
          { id: 'r1', title: 'Zqx Regress Eins', pub: 'Zqx Verlag Eins', genres: ['Zqx-Genre-A'], bands: { 1: 'owned' }, status: 'owned' },
          { id: 'r2', title: 'Zqx Regress Zwei', pub: 'Zqx Verlag Zwei', genres: ['Zqx-Genre-B'], bands: { 1: 'owned' }, status: 'owned' },
        ],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: seedDb });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(250);

      const before = await page.evaluate(() => ({
        pubOptions: Array.from(document.getElementById('pub-filter').options).map((o) => o.value),
        genreChips: Array.from(document.getElementById('genre-filter-wrap').querySelectorAll('[data-genre]')).map((e) => e.dataset.genre),
      }));
      if (!before.pubOptions.includes('Zqx Verlag Eins') || !before.pubOptions.includes('Zqx Verlag Zwei')) {
        throw new Error('Verlags-Filter sollte beide neuen Verlage vor der Suche enthalten. Optionen: ' + JSON.stringify(before.pubOptions));
      }
      if (!before.genreChips.includes('Zqx-Genre-A') || !before.genreChips.includes('Zqx-Genre-B')) {
        throw new Error('Genre-Filter sollte beide neuen Genres vor der Suche enthalten. Chips: ' + JSON.stringify(before.genreChips));
      }

      // Suche eingeben, die NICHTS trifft -> items.length === 0, rawItems.length > 0
      // (der zweite fruehe Return in renderSeriesGrid()). Vorher lief updatePubFilter()/
      // updateGenreFilter() hier gar nicht mehr (nur beim naechsten Treffer-Render).
      await page.fill('#search-input', 'xyz-garantiert-kein-treffer-zqx');
      await page.evaluate(() => onSearch(document.getElementById('search-input').value));
      await page.waitForTimeout(250);

      const emptyHtml = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Keine Treffer/.test(emptyHtml)) throw new Error('Erwarteter Leer-Zustand "Keine Treffer" nicht angezeigt. Content: ' + emptyHtml.slice(0, 200));

      const duringEmptySearch = await page.evaluate(() => ({
        pubOptions: Array.from(document.getElementById('pub-filter').options).map((o) => o.value),
        genreChips: Array.from(document.getElementById('genre-filter-wrap').querySelectorAll('[data-genre]')).map((e) => e.dataset.genre),
        pubWrapDisplay: window.getComputedStyle(document.getElementById('genre-filter-wrap')).display,
      }));
      if (!duringEmptySearch.pubOptions.includes('Zqx Verlag Eins') || !duringEmptySearch.pubOptions.includes('Zqx Verlag Zwei')) {
        throw new Error('Verlags-Filter darf im Leer-Pfad (Suche ohne Treffer) nicht leerlaufen. Optionen: ' + JSON.stringify(duringEmptySearch.pubOptions));
      }
      // keine Duplikate: jede Option genau einmal
      const dupCheck = duringEmptySearch.pubOptions.filter((v, i, arr) => arr.indexOf(v) !== i);
      if (dupCheck.length) throw new Error('Verlags-Filter enthaelt Duplikate nach dem Leer-Pfad-Render: ' + JSON.stringify(dupCheck));
      if (!duringEmptySearch.genreChips.includes('Zqx-Genre-A') || !duringEmptySearch.genreChips.includes('Zqx-Genre-B')) {
        throw new Error('Genre-Filter darf im Leer-Pfad (Suche ohne Treffer) nicht leerlaufen. Chips: ' + JSON.stringify(duringEmptySearch.genreChips));
      }
      const dupGenreCheck = duringEmptySearch.genreChips.filter((v, i, arr) => arr.indexOf(v) !== i);
      if (dupGenreCheck.length) throw new Error('Genre-Filter enthaelt Duplikate nach dem Leer-Pfad-Render: ' + JSON.stringify(dupGenreCheck));

      // Suche zuruecksetzen -> beide Serien wieder sichtbar, UI weiterhin konsistent (kein Rest-Duplikat)
      await page.evaluate(() => { document.getElementById('search-input').value = ''; onSearch(''); });
      await page.waitForTimeout(200);
      const afterReset = await page.evaluate(() => ({
        pubOptions: Array.from(document.getElementById('pub-filter').options).map((o) => o.value),
        grid: document.getElementById('content').textContent,
      }));
      const dupAfterReset = afterReset.pubOptions.filter((v, i, arr) => arr.indexOf(v) !== i);
      if (dupAfterReset.length) throw new Error('Verlags-Filter enthaelt Duplikate nach Reset der Suche: ' + JSON.stringify(dupAfterReset));
      if (!/Zqx Regress Eins/.test(afterReset.grid) || !/Zqx Regress Zwei/.test(afterReset.grid)) {
        throw new Error('Nach Reset der Suche sollten beide Serien wieder sichtbar sein. Grid: ' + afterReset.grid.slice(0, 300));
      }

      await context.close();
    });

    // ── Test 13: Vollstaendig leerer Tab (rawItems.length === 0) — kein Crash, ────────
    // Genre-Wrap korrekt versteckt, Verlags-Filter bleibt konsistent (kein Restzustand) ─
    await runTest('Regression: vollstaendig leerer Tab crasht nicht und haelt Filter-UI konsistent (rawItems.length === 0 Pfad)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e));

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      // Alle Bände "completed" und Serie im wishlist-Status ausser einer -> "completed"-Tab
      // enthaelt garantiert nichts aus unserer eigenen Testdaten-Menge (Seeds koennten dort
      // theoretisch landen, das ist unabhaengig vom hier getesteten Pfad).
      const seedDb = {
        schemaVersion: 3,
        m: [
          { id: 'w1', title: 'Zqx Wunsch Eins', pub: 'Zqx Verlag Drei', genres: ['Zqx-Genre-C'], bands: {}, status: 'wishlist' },
        ],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: seedDb });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="wishlist"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(200);

      // Wunschlisten-Tab sollte unseren Eintrag zeigen (Kontrollzustand).
      const wishlistHtml = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Wunsch Eins/.test(wishlistHtml)) throw new Error('Wunschlisten-Tab sollte den Testeintrag zeigen. Content: ' + wishlistHtml.slice(0, 200));

      await page.click('.tab[data-tab="completed"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(250);

      if (pageErrors.length) throw new Error('pageerror im leeren "completed"-Tab: ' + pageErrors.map(String).join(' | '));

      const emptyTabState = await page.evaluate(() => {
        const wrap = document.getElementById('genre-filter-wrap');
        const pubSel = document.getElementById('pub-filter');
        return {
          contentText: document.getElementById('content').textContent,
          pubOptionsCount: pubSel.options.length,
          wrapDisplay: window.getComputedStyle(wrap).display,
        };
      });
      // Kein Crash, ein Leer-Zustand wird gerendert (nicht die alte Wunschlisten-Ansicht).
      if (/Zqx Wunsch Eins/.test(emptyTabState.contentText)) {
        throw new Error('"completed"-Tab zeigt faelschlich den Wunschlisten-Eintrag (Filter-UI-Umbau haette das nicht aendern duerfen).');
      }
      if (emptyTabState.pubOptionsCount < 1) throw new Error('Verlags-Filter sollte mindestens die "Alle Verlage"-Option behalten, hat aber ' + emptyTabState.pubOptionsCount);

      await context.close();
    });

    // ── Test 14: Genre-Mehrfachauswahl (OR-Semantik, Phase 67) unveraendert korrekt ──
    // ueber das echte DOM nach der renderSeriesGrid()-Umstellung ──────────────────────
    await runTest('Regression: Genre-Mehrfachauswahl (OR-Semantik) funktioniert nach der Filter-Reihenfolge-Aenderung unveraendert im echten DOM', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/rpc/get_my_collection_ids', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      const seedDb = {
        schemaVersion: 3,
        m: [
          { id: 'g1', title: 'Zqx Genre Action', pub: 'Zqx Verlag Vier', genres: ['Zqx-Action'], bands: { 1: 'owned' }, status: 'owned' },
          { id: 'g2', title: 'Zqx Genre Drama', pub: 'Zqx Verlag Vier', genres: ['Zqx-Drama'], bands: { 1: 'owned' }, status: 'owned' },
          { id: 'g3', title: 'Zqx Genre Horror', pub: 'Zqx Verlag Vier', genres: ['Zqx-Horror'], bands: { 1: 'owned' }, status: 'owned' },
        ],
      };
      await page.addInitScript((seed) => {
        localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
        localStorage.setItem('mtDE', JSON.stringify(seed.db));
      }, { session: freshSession(), db: seedDb });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(250);

      await page.click('[data-action="set-genre-filter"][data-genre="Zqx-Action"]');
      await page.waitForTimeout(150);
      await page.click('[data-action="set-genre-filter"][data-genre="Zqx-Drama"]');
      await page.waitForTimeout(200);

      const gridHtml = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Genre Action/.test(gridHtml) || !/Zqx Genre Drama/.test(gridHtml)) {
        throw new Error('OR-Semantik: bei aktiven Genres Action+Drama sollten beide Serien sichtbar sein. Grid: ' + gridHtml.slice(0, 300));
      }
      if (/Zqx Genre Horror/.test(gridHtml)) {
        throw new Error('OR-Semantik: Horror-Serie darf bei Filter Action+Drama nicht sichtbar sein. Grid: ' + gridHtml.slice(0, 300));
      }

      // Ein Genre wieder abwaehlen -> nur noch Action sichtbar
      await page.click('[data-action="set-genre-filter"][data-genre="Zqx-Drama"]');
      await page.waitForTimeout(200);
      const gridHtml2 = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Genre Action/.test(gridHtml2)) throw new Error('Nach Abwahl von Drama sollte Action weiterhin sichtbar sein. Grid: ' + gridHtml2.slice(0, 300));
      if (/Zqx Genre Drama/.test(gridHtml2)) throw new Error('Nach Abwahl von Drama darf Drama nicht mehr sichtbar sein. Grid: ' + gridHtml2.slice(0, 300));

      await context.close();
    });

  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
  if (_failed > 0) {
    console.log('\nFehlgeschlagene Tests:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
