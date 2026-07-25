#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase75-browser-integration.js — Phase 75 (TMDB-Provider für Realserien)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase73/74-browser-integration.js).
 * Zweck: das Feature gegen das ECHTE src/app.js + index.html pruefen.
 *
 * Anders als Phase 73 (AniList) spricht der Client hier NIE mit einer externen
 * API: data/tmdb-series-catalog.json wird per page.route() gestubbt (der
 * Katalog selbst ist server-seitig vorgeneriert). Ein zusaetzlicher Request-
 * Monitor stellt sicher, dass waehrend des gesamten Testlaufs KEIN Request an
 * TMDB (themoviedb.org/image.tmdb.org) rausgeht (E2, spec.md Phase 75).
 *
 * Aufruf: node scripts/test-phase75-browser-integration.js
 * Voraussetzung: `npx playwright install chromium` (einmalig).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
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

// ─── Mini static file server (wie in Phase 72/73/74) ──────────────────────
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
        // Angefragten Pfad NICHT in die Antwort spiegeln (CodeQL js/reflected-xss).
        if (err) { console.error('[test-server] 404:', reqPath); res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
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

// ─── TMDB-Katalog-Fixtures (rein lokal, kein Netz) ────────────────────────
function tmdbRecord(overrides) {
  return Object.assign({
    tmdbId: 1399,
    title: 'Game of Thrones',
    network: 'HBO',
    total: 73,
    seasonCount: 8,
    ongoing: 'false',
    cover: 'https://127.0.0.1/never-loaded-cover.jpg',
    genres: ['Drama', 'Fantasy'],
    overview: 'Sieben Adelshäuser kämpfen um die Kontrolle des mythischen Landes Westeros.',
    seasons: { 1: 1, 2: 1 },
  }, overrides || {});
}

function tmdbCatalogBody(items) {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'update-tmdb-catalog.js',
    items,
  });
}

// Vorbestehendes, von Phase 73 unabhaengiges Browser-Rauschen (existiert schon vor
// dieser Phase, index.html:5).
function isKnownCspNoise(text) {
  return /frame-ancestors' is ignored when delivered via a <meta> element/.test(text);
}

// Stubbt den TMDB-Katalog. `handler` bekommt die Route.
function routeTmdbCatalog(page, handler) {
  return page.route('**/data/tmdb-series-catalog.json', handler);
}

async function seedPage(page, db) {
  await page.route('**/rpc/get_my_collection_ids', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.addInitScript((seed) => {
    localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
    localStorage.setItem('mtDE', JSON.stringify(seed.db));
  }, { session: freshSession(), db });
}

// Oeffnet Hinzufuegen-Modal (im Serien-Modus) → TMDB-Overlay und filtert nach `q`.
async function openTmdbSearchAndQuery(page, q) {
  await page.click('#mode-switch [data-mode="series"]');
  await page.waitForTimeout(150);
  await page.click('#btn-add');
  await page.waitForTimeout(150);
  await page.click('[data-action="open-tmdb-search"]');
  await page.waitForTimeout(150);
  if (q) {
    await page.fill('#tmdb-search-input', q);
    await page.waitForTimeout(150);
  }
}

(async function main() {
  console.log('\nPhase 75 — Browser-Integrationstests (echtes src/app.js, TMDB-Katalog gestubbt)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test: Boot mit geladenem TMDB-Katalog, keine Konsolenfehler, kein TMDB-Request ──
    await runTest('Boot: TMDB-Katalog geladen (tmdbCatalogStatus="loaded"), keine Konsolen-/Seitenfehler, kein Request an TMDB', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      const tmdbRequests = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) consoleErrors.push(m.text()); });
      page.on('request', (req) => { if (/themoviedb\.org|image\.tmdb\.org/i.test(req.url())) tmdbRequests.push(req.url()); });

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: tmdbCatalogBody([tmdbRecord()]) });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      if (pageErrors.length) throw new Error('pageerror beim Boot: ' + pageErrors.join(' | '));
      if (consoleErrors.length) throw new Error('Konsolenfehler beim Boot: ' + consoleErrors.join(' | '));
      if (tmdbRequests.length) throw new Error('Client hat TMDB direkt angesprochen (E2 verletzt): ' + tmdbRequests.join(', '));

      const state = await page.evaluate(() => ({
        status: tmdbCatalogStatus,
        itemCount: tmdbCatalog ? tmdbCatalog.items.length : -1,
        hasOpen: typeof openTmdbSearch === 'function',
      }));
      if (state.status !== 'loaded') throw new Error('tmdbCatalogStatus sollte "loaded" sein, war: ' + state.status);
      if (state.itemCount !== 1) throw new Error('tmdbCatalog.items sollte 1 Eintrag haben, war: ' + state.itemCount);
      if (!state.hasOpen) throw new Error('openTmdbSearch fehlt in app.js');

      await context.close();
    });

    // ── Test: TMDB-Einstieg nur im Hinzufuegen-Kontext UND nur im Serien-Modus sichtbar ──
    await runTest('TMDB-Einstiegsbutton nur im Hinzufuegen-Modal + nur im Serien-Modus sichtbar, Overlay oeffnet sich real', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: tmdbCatalogBody([tmdbRecord()]) });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const entryBtn = page.locator('[data-action="open-tmdb-search"]');
      if (await entryBtn.isVisible()) throw new Error('TMDB-Einstiegsbutton darf ausserhalb des Hinzufuegen-Modals nicht sichtbar sein');

      // Manga-Modus (default): Hinzufuegen-Modal oeffnen → Button bleibt versteckt.
      await page.click('#btn-add');
      await page.waitForTimeout(200);
      if (await entryBtn.isVisible()) throw new Error('TMDB-Einstiegsbutton darf im Manga-Modus nicht sichtbar sein (nur appMode==="series")');
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      // Serien-Modus: Button muss sichtbar werden.
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('#btn-add');
      await page.waitForTimeout(200);
      if (!(await entryBtn.isVisible())) {
        const diag = await page.evaluate(() => {
          const b = document.getElementById('btn-tmdb-search');
          return { className: b && b.className, appMode, computed: b ? window.getComputedStyle(b).display : 'MISSING' };
        });
        throw new Error('TMDB-Einstiegsbutton ist im Serien-Modus/Hinzufuegen-Modal unsichtbar: ' + JSON.stringify(diag));
      }

      await entryBtn.click();
      await page.waitForTimeout(200);
      const overlay = page.locator('#tmdb-overlay');
      if (!(await overlay.isVisible())) throw new Error('TMDB-Overlay ist nach dem Oeffnen nicht sichtbar');
      if (!(await page.locator('#tmdb-search-input').isVisible())) throw new Error('Suchfeld im TMDB-Overlay ist nicht sichtbar');

      await page.click('[data-action="close-tmdb-search"]');
      await page.waitForTimeout(150);
      if (await overlay.isVisible()) throw new Error('TMDB-Overlay bleibt nach dem Schliessen sichtbar');

      await context.close();
    });

    // ── Test: Katalog-Browse/Filter + Uebernahme ────────────────────────────
    await runTest('Katalog-Treffer → Uebernahme: Eintrag liegt in db.m mit mediaType "series", total, seasons, pub=network, externalIds.tmdbId', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const tmdbRequests = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('dialog', (d) => d.accept());
      page.on('request', (req) => { if (/themoviedb\.org|image\.tmdb\.org/i.test(req.url())) tmdbRequests.push(req.url()); });

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord(), tmdbRecord({ tmdbId: 1396, title: 'Breaking Bad', network: 'AMC', genres: ['Crime'] })]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openTmdbSearchAndQuery(page, 'Game of Thrones');

      const hitText = await page.evaluate(() => document.getElementById('tmdb-results').textContent);
      ['Game of Thrones', 'HBO', '73 Episoden', 'abgeschlossen', 'Drama', 'Fantasy'].forEach((needle) => {
        if (!hitText.includes(needle)) throw new Error('Trefferliste zeigt "' + needle + '" nicht. Text: ' + hitText.slice(0, 300));
      });
      if (hitText.includes('Breaking Bad')) throw new Error('Suchfilter sollte "Breaking Bad" bei Suche nach "Game of Thrones" ausblenden');

      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(400);

      if (pageErrors.length) throw new Error('pageerror beim Import: ' + pageErrors.join(' | '));
      if (tmdbRequests.length) throw new Error('Client hat TMDB direkt angesprochen (E2 verletzt): ' + tmdbRequests.join(', '));

      const entry = await page.evaluate(() => {
        const e = db.m.find((m) => m.mediaType === 'series');
        return e ? JSON.parse(JSON.stringify(e)) : null;
      });
      if (!entry) throw new Error('Kein Serien-Eintrag in db.m nach der Uebernahme');
      if (entry.title !== 'Game of Thrones') throw new Error('Titel falsch: ' + entry.title);
      if (entry.pub !== 'HBO') throw new Error('pub sollte das TMDB-network sein ("HBO"), war: ' + entry.pub);
      if (entry.total !== 73) throw new Error('total sollte 73 sein, war: ' + entry.total);
      if (entry.ongoing !== 'false') throw new Error('ongoing sollte "false" sein, war: ' + entry.ongoing);
      if (!Array.isArray(entry.genres) || entry.genres.join(',') !== 'Drama,Fantasy') throw new Error('genres gingen verloren: ' + JSON.stringify(entry.genres));
      if (entry.cover !== 'https://127.0.0.1/never-loaded-cover.jpg') throw new Error('cover ging verloren: ' + JSON.stringify(entry.cover));
      if (Object.keys(entry.seasons || {}).length !== 2 || entry.seasons['1'] !== 1 || entry.seasons['2'] !== 1) throw new Error('seasons falsch: ' + JSON.stringify(entry.seasons));
      if (!entry.externalIds || entry.externalIds.tmdbId !== 1399) throw new Error('externalIds.tmdbId fehlt: ' + JSON.stringify(entry.externalIds));
      if (Object.keys(entry.bands || {}).length !== 0) throw new Error('bands muss beim Import leer bleiben, war: ' + JSON.stringify(entry.bands));
      if (entry.notes !== '') throw new Error('notes muss beim Import leer sein');
      if ('overview' in entry) throw new Error('overview darf NICHT persistiert werden (nur Browse-Overlay), war im Eintrag vorhanden');

      // Persistenz: der Eintrag ueberlebt den localStorage-Roundtrip
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('mtDE')).m.filter((m) => m.mediaType === 'series').length);
      if (persisted !== 1) throw new Error('Serien-Eintrag wurde nicht persistiert (localStorage), gefunden: ' + persisted);

      // Doppelimport derselben tmdbId wird geblockt
      await openTmdbSearchAndQuery(page, 'Game of Thrones');
      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(300);
      const countAfter = await page.evaluate(() => db.m.filter((m) => m.mediaType === 'series').length);
      if (countAfter !== 1) throw new Error('Doppelimport derselben tmdbId wurde nicht geblockt, Eintraege: ' + countAfter);
      const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
      if (!/bereits in der Sammlung/.test(toastText)) throw new Error('Erwartete Duplikatmeldung, bekam: ' + toastText);

      await context.close();
    });

    // ── Test: Katalogdatei fehlt/kaputt → neutrale Meldung, kein Absturz ────
    await runTest('Katalog fehlt (404)/kaputt (Invalid JSON): tmdbCatalogStatus "missing"/"invalid", Overlay zeigt neutrale Meldung, kein pageerror', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const statusMissing = await page.evaluate(() => tmdbCatalogStatus);
      if (statusMissing !== 'missing') throw new Error('tmdbCatalogStatus sollte bei HTTP 404 "missing" sein, war: ' + statusMissing);

      await openTmdbSearchAndQuery(page, '');
      const emptyText = await page.evaluate(() => document.getElementById('tmdb-results').textContent);
      if (!emptyText.trim()) throw new Error('Overlay sollte eine neutrale Meldung zeigen, war leer');

      await context.close();

      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      page2.on('pageerror', (e) => pageErrors.push(String(e)));
      await seedPage(page2, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page2, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{ das ist kein json' });
      });
      await page2.goto(base, { waitUntil: 'load' });
      await page2.waitForTimeout(500);

      const statusInvalid = await page2.evaluate(() => tmdbCatalogStatus);
      if (statusInvalid !== 'invalid') throw new Error('tmdbCatalogStatus sollte bei kaputtem JSON "invalid" sein, war: ' + statusInvalid);

      if (pageErrors.length) throw new Error('pageerror bei fehlendem/kaputtem Katalog: ' + pageErrors.join(' | '));

      await context2.close();
    });

    // ── Test: XSS-Gegenprobe (Overlay + Sammlungs-Sinks, insbesondere pub) ──
    await runTest('XSS: TMDB-Katalogrecord mit <script>/<img onerror>/javascript: in title/genres/overview/network wird ueberall escaped', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleMessages = [];
      const pageErrors = [];
      page.on('console', (m) => consoleMessages.push(m.text()));
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('dialog', (d) => d.accept());

      const evilTitle = '<img src=x onerror="window.__xss=1"><script>window.__xss2=1<\/script>';
      const evilNetwork = '<img src=x onerror="window.__xssPub=1">';
      const evilGenre = '<img src=x onerror="window.__xss3=1">';
      const evilOverview = '<img src=x onerror="window.__xss5=1">';

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord({
            tmdbId: 4242,
            title: evilTitle,
            network: evilNetwork,
            genres: [evilGenre],
            overview: evilOverview,
            cover: 'javascript:window.__xss4=1',
          })]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      // Anders als bei AniList filtert der Client den Katalog clientseitig nach Titel —
      // ein Suchbegriff, der im (bösartigen) Titel nicht vorkommt, würde den Treffer
      // wegfiltern. Deshalb hier ohne Suchtext öffnen (zeigt den ganzen Katalog).
      await openTmdbSearchAndQuery(page, '');

      const xssStateOverlay = await page.evaluate(() => ({
        x1: window.__xss, x2: window.__xss2, x3: window.__xss3, x4: window.__xss4, x5: window.__xss5,
        text: document.getElementById('tmdb-results').textContent,
        injectedImgs: document.querySelectorAll('#tmdb-results img[src="x"]').length,
        injectedScripts: document.querySelectorAll('#tmdb-results script').length,
        coverImgs: document.querySelectorAll('#tmdb-results img.anilist-hit-cover').length,
      }));
      if (xssStateOverlay.x1 || xssStateOverlay.x2 || xssStateOverlay.x3 || xssStateOverlay.x4 || xssStateOverlay.x5) {
        throw new Error('XSS im Overlay ausgefuehrt: ' + JSON.stringify(xssStateOverlay));
      }
      if (xssStateOverlay.injectedImgs) throw new Error('Injizierte <img>-Elemente im Ergebnis-DOM gefunden');
      if (xssStateOverlay.injectedScripts) throw new Error('Injizierte <script>-Elemente im Ergebnis-DOM gefunden');
      if (xssStateOverlay.coverImgs !== 0) throw new Error('javascript:-Cover-URL wurde gerendert statt verworfen');
      if (!xssStateOverlay.text.includes('<img src=x onerror=')) throw new Error('Titel/Network/Genre/Overview sollten als sichtbarer TEXT (escaped) erscheinen. Text: ' + xssStateOverlay.text.slice(0, 300));

      // Import: network → pub landet jetzt in ALLEN Sammlungs-Sinks (E-Sweep der Spec).
      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(400);

      // Sammlung: Serienansicht (card-pub) + Verlagsfilter (pub-filter <option>) + Dashboard (bar-label).
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(300);

      const cardPubTexts = await page.evaluate(() => Array.from(document.querySelectorAll('.card-pub')).map((el) => el.textContent));
      const cardPubImgs = await page.evaluate(() => document.querySelectorAll('.card-pub img').length);
      if (cardPubImgs > 0) throw new Error('.card-pub rendert das TMDB-network unescaped (injiziertes <img>)');
      if (!cardPubTexts.some((t) => t.includes('<img src=x onerror='))) {
        throw new Error('.card-pub sollte das network escaped als Text zeigen, war: ' + JSON.stringify(cardPubTexts));
      }

      const pubFilterImgs = await page.evaluate(() => document.querySelectorAll('#pub-filter img').length);
      const pubFilterHtml = await page.evaluate(() => document.getElementById('pub-filter').innerHTML);
      if (pubFilterImgs > 0) throw new Error('#pub-filter rendert das TMDB-network unescaped (injiziertes <img>)');
      if (!pubFilterHtml.includes('&lt;img src=x onerror=')) throw new Error('#pub-filter sollte das network als escapte Entities enthalten, innerHTML: ' + pubFilterHtml.slice(0, 300));

      await page.click('[data-action="set-tab"][data-tab="dashboard"]');
      await page.waitForTimeout(400);
      const barLabelImgs = await page.evaluate(() => document.querySelectorAll('#content .bar-label img').length);
      const barLabelTexts = await page.evaluate(() => Array.from(document.querySelectorAll('#content .bar-label')).map((el) => el.textContent));
      if (barLabelImgs > 0) throw new Error('.bar-label (Verlage) rendert das TMDB-network unescaped (injiziertes <img>)');
      if (!barLabelTexts.some((t) => t.includes('<img src=x onerror='))) {
        throw new Error('.bar-label (Verlage) sollte das network escaped als Text zeigen, war: ' + JSON.stringify(barLabelTexts));
      }

      const afterImportXss = await page.evaluate(() => ({
        x1: window.__xss, x2: window.__xss2, x3: window.__xss3, x4: window.__xss4, x5: window.__xss5, xPub: window.__xssPub,
        cover: (db.m.find((m) => m.mediaType === 'series') || {}).cover,
        gridScripts: document.querySelectorAll('#content script').length,
      }));
      if (afterImportXss.x1 || afterImportXss.x2 || afterImportXss.x3 || afterImportXss.x4 || afterImportXss.x5 || afterImportXss.xPub) {
        throw new Error('XSS nach dem Import ausgefuehrt: ' + JSON.stringify(afterImportXss));
      }
      if (afterImportXss.gridScripts) throw new Error('Injiziertes <script> im gerenderten Grid gefunden');
      if (afterImportXss.cover !== null && afterImportXss.cover !== '') throw new Error('javascript:-Cover-URL wurde in die Sammlung uebernommen: ' + JSON.stringify(afterImportXss.cover));

      const cspViolations = consoleMessages
        .filter((t) => /Content Security Policy|Refused to/i.test(t))
        .filter((t) => !isKnownCspNoise(t));
      if (cspViolations.length) throw new Error('CSP-Violations in der Konsole: ' + cspViolations.join(' | '));
      if (pageErrors.length) throw new Error('pageerror im XSS-Test: ' + pageErrors.join(' | '));

      await context.close();
    });

    // ── Test: Nicht-Regression der bestehenden Manga-/Anime-Sammlung ───────
    await runTest('Nicht-Regression: bestehende Manga-Eintraege sind nach dem TMDB-Import feldgleich, Public Projection ohne externalIds', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      const mangaSeed = {
        schemaVersion: 3,
        m: [
          {
            id: 'zq1', title: 'Zqx Manga Eins', pub: 'Panini', mediaType: 'manga',
            genres: ['Action'], bands: { 1: 'owned', 2: 'completed' }, bandCovers: {},
            status: 'owned', total: 5, ongoing: 'true', nextDate: '2026-09-01',
            notes: 'privat', isbn13: '9780000000000', startedAt: '2026-01-01',
            finishedAt: null, cover: null, owned: 2, current: null, at: 1700000000000,
            seasons: {}, externalIds: { mpEditionId: 'x' },
          },
          {
            id: 'zq2', title: 'Zqx Manga Zwei', pub: 'Carlsen', mediaType: 'manga',
            genres: ['Drama'], bands: { 1: 'owned' }, bandCovers: {}, status: 'owned',
            total: null, ongoing: null, nextDate: null, notes: '', cover: null,
            owned: 1, current: null, at: 1700000000001,
          },
        ],
      };
      await seedPage(page, mangaSeed);
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: tmdbCatalogBody([tmdbRecord({ title: 'Zqx TMDB Serie Neu' })]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const before = await page.evaluate(() => JSON.stringify(db.m.filter((m) => m.id === 'zq1' || m.id === 'zq2')));

      await openTmdbSearchAndQuery(page, 'Zqx TMDB Serie Neu');
      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(400);

      const after = await page.evaluate(() => JSON.stringify(db.m.filter((m) => m.id === 'zq1' || m.id === 'zq2')));
      if (before !== after) throw new Error('Bestehende Manga-Eintraege wurden durch den TMDB-Import veraendert.\nVorher: ' + before + '\nNachher: ' + after);

      const seriesCount = await page.evaluate(() => db.m.filter((m) => m.mediaType === 'series').length);
      if (seriesCount !== 1) throw new Error('Erwartet genau einen Serien-Eintrag, gefunden: ' + seriesCount);

      // Manga-Modus zurueckwechseln — Manga-Bestand bleibt sichtbar/unangetastet (Nicht-Regression).
      await page.click('#mode-switch [data-mode="manga"]');
      await page.waitForTimeout(200);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      const mangaGrid = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Manga Eins/.test(mangaGrid)) throw new Error('Nicht-Regression verletzt: Manga-Sammlung wurde durch Serien-Modus-Import veraendert. Grid: ' + mangaGrid.slice(0, 300));

      // Public Projection des Serien-Eintrags enthaelt keine privaten TMDB-Felder (E4)
      const projected = await page.evaluate(() => {
        const series = db.m.find((m) => m.mediaType === 'series');
        return buildPublicCollectionData({ schemaVersion: 3, m: [series] }).m[0];
      });
      if (Object.prototype.hasOwnProperty.call(projected, 'externalIds')) throw new Error('externalIds in der Public Projection des Serien-Eintrags gefunden');
      if (projected.mediaType !== 'series') throw new Error('mediaType in der Projektion falsch: ' + projected.mediaType);
      if (Object.keys(projected.seasons || {}).length !== 2) throw new Error('seasons kommen nicht durch die Projektion: ' + JSON.stringify(projected.seasons));

      await context.close();
    });

    // ── Test: Wunschlisten-Kontext ──────────────────────────────────────────
    await runTest('Import aus dem Wunschlisten-Tab setzt status "wishlist"', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: tmdbCatalogBody([tmdbRecord({ title: 'Zqx Wunsch Serie' })]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('.tab[data-tab="wishlist"]');
      await page.waitForTimeout(200);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.click('[data-action="open-tmdb-search"]');
      await page.waitForTimeout(150);
      await page.fill('#tmdb-search-input', 'Zqx Wunsch Serie');
      await page.waitForTimeout(150);
      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(400);

      const status = await page.evaluate(() => (db.m.find((m) => m.mediaType === 'series') || {}).status);
      if (status !== 'wishlist') throw new Error('Import aus dem Wunschlisten-Tab sollte status "wishlist" setzen, war: ' + status);

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
