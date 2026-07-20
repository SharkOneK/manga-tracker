#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase73-browser-integration.js — Phase 73 (AniList-Provider)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase72-browser-integration.js).
 * Zweck: das Feature gegen das ECHTE src/app.js + index.html pruefen — Phase 72
 * war 86/86 gruen, waehrend der Medienfilter live unsichtbar war.
 *
 * Der Netzwerkpfad zu https://graphql.anilist.co wird per page.route() gestubbt;
 * es findet KEIN echter AniList-Zugriff statt.
 *
 * Aufruf: node scripts/test-phase73-browser-integration.js
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

// ─── Mini static file server (wie in Phase 72) ────────────────────────────
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

// ─── AniList-Fixtures (rein lokal) ────────────────────────────────────────
function media(overrides) {
  return Object.assign({
    id: 25777,
    title: { romaji: 'Shingeki no Kyojin Season 2', english: 'Attack on Titan Season 2', native: '進撃の巨人 Season 2' },
    episodes: 12,
    status: 'RELEASING',
    format: 'TV',
    seasonYear: 2017,
    season: 'SPRING',
    coverImage: { large: 'https://127.0.0.1/never-loaded-cover.jpg' },
    genres: ['Action', 'Drama'],
    nextAiringEpisode: { episode: 13, airingAt: 1770000000 },
    relations: { edges: [{ relationType: 'PREQUEL', node: { id: 16498 } }] },
  }, overrides || {});
}

function anilistBody(list) {
  return JSON.stringify({ data: { Page: { media: list } } });
}

// Vorbestehendes, von Phase 73 unabhaengiges Browser-Rauschen: Chromium meldet fuer
// jede per <meta> ausgelieferte CSP, dass 'frame-ancestors' dort ignoriert wird.
// Das ist keine Violation und existiert schon vor dieser Phase (index.html:5).
function isKnownCspNoise(text) {
  return /frame-ancestors' is ignored when delivered via a <meta> element/.test(text);
}

// Stubbt den AniList-Endpunkt. `handler` bekommt die Route.
function routeAniList(page, handler) {
  return page.route('https://graphql.anilist.co', handler);
}

// Ein angemeldeter Owner ohne Cloud-Sammlung, mit definierter lokaler Sammlung.
async function seedPage(page, db) {
  await page.route('**/rpc/get_my_collection_ids', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.addInitScript((seed) => {
    localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
    localStorage.setItem('mtDE', JSON.stringify(seed.db));
  }, { session: freshSession(), db });
}

// Oeffnet Hinzufuegen-Modal → AniList-Overlay und sucht nach `q`.
async function openSearchAndQuery(page, q) {
  await page.click('#btn-add');
  await page.waitForTimeout(150);
  await page.click('[data-action="open-anilist-search"]');
  await page.waitForTimeout(150);
  await page.fill('#anilist-search-input', q);
  await page.click('[data-action="run-anilist-search"]');
}

(async function main() {
  console.log('\nPhase 73 — Browser-Integrationstests (echtes src/app.js, AniList gestubbt)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test 16: Boot mit geladenem anilist-utils.js, keine Konsolenfehler ──
    await runTest('Boot: anilist-utils.js ist geladen, keine Konsolen-/Seitenfehler (Ladereihenfolge/TDZ)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) consoleErrors.push(m.text()); });

      await seedPage(page, { schemaVersion: 3, m: [] });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      if (pageErrors.length) throw new Error('pageerror beim Boot: ' + pageErrors.join(' | '));
      if (consoleErrors.length) throw new Error('Konsolenfehler beim Boot: ' + consoleErrors.join(' | '));

      const state = await page.evaluate(() => ({
        hasUtils: typeof window.MangaTrackerAniListUtils === 'object' && window.MangaTrackerAniListUtils !== null,
        hasFetchGlue: typeof anilistFetch === 'function',
        hasOpen: typeof openAniListSearch === 'function',
        // AniListUtils wird in app.js als const gebunden — bei falscher Ladereihenfolge waere es undefined
        boundInApp: typeof AniListUtils === 'object' && AniListUtils !== null,
      }));
      if (!state.hasUtils) throw new Error('window.MangaTrackerAniListUtils fehlt — anilist-utils.js nicht geladen');
      if (!state.boundInApp) throw new Error('AniListUtils in app.js ist nicht gebunden — anilist-utils.js wird zu spaet geladen');
      if (!state.hasFetchGlue || !state.hasOpen) throw new Error('AniList-Glue-Funktionen fehlen in app.js');

      await context.close();
    });

    // ── Test 17: Such-Overlay ist tatsaechlich SICHTBAR (Phase-72-Fehlertyp) ─
    await runTest('Such-Overlay oeffnet sich und ist tatsaechlich sichtbar (isVisible, nicht nur "Element existiert")', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, { schemaVersion: 3, m: [] });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const entryBtn = page.locator('[data-action="open-anilist-search"]');
      // Vor dem Oeffnen des Hinzufuegen-Modals darf der Einstieg nicht sichtbar sein.
      if (await entryBtn.isVisible()) throw new Error('AniList-Einstiegsbutton darf ausserhalb des Hinzufuegen-Modals nicht sichtbar sein');

      await page.click('#btn-add');
      await page.waitForTimeout(200);
      if (!(await entryBtn.isVisible())) {
        const diag = await page.evaluate(() => {
          const b = document.getElementById('btn-anilist-search');
          return { className: b && b.className, computed: b ? window.getComputedStyle(b).display : 'MISSING' };
        });
        throw new Error('AniList-Einstiegsbutton ist im Hinzufuegen-Modal unsichtbar: ' + JSON.stringify(diag));
      }

      await entryBtn.click();
      await page.waitForTimeout(200);
      const overlay = page.locator('#anilist-overlay');
      if (!(await overlay.isVisible())) {
        const diag = await page.evaluate(() => {
          const ov = document.getElementById('anilist-overlay');
          return { className: ov && ov.className, computed: ov ? window.getComputedStyle(ov).display : 'MISSING' };
        });
        throw new Error('AniList-Overlay ist nach dem Oeffnen nicht sichtbar (Phase-72-Fehlertyp: hidden-Klasse nie entfernt): ' + JSON.stringify(diag));
      }
      if (!(await page.locator('#anilist-search-input').isVisible())) throw new Error('Suchfeld im Overlay ist nicht sichtbar');

      // Schliessen blendet wieder aus
      await page.click('[data-action="close-anilist-search"]');
      await page.waitForTimeout(150);
      if (await overlay.isVisible()) throw new Error('AniList-Overlay bleibt nach dem Schliessen sichtbar');

      await context.close();
    });

    // ── Test 18: Gestubbter Treffer → Auswahl → Eintrag in db.m ─────────────
    await runTest('Gestubbter Treffer → Uebernahme: Eintrag liegt in db.m mit mediaType "anime", total und seasons', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('dialog', (d) => d.accept());

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([media()]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openSearchAndQuery(page, 'Attack on Titan Season 2');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });

      // Trefferzeile zeigt die geforderten Metadaten
      const hitText = await page.evaluate(() => document.getElementById('anilist-results').textContent);
      ['Attack on Titan Season 2', '2017', 'TV', '12 Episoden', 'läuft'].forEach((needle) => {
        if (!hitText.includes(needle)) throw new Error('Trefferliste zeigt "' + needle + '" nicht. Text: ' + hitText.slice(0, 300));
      });

      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      if (pageErrors.length) throw new Error('pageerror beim Import: ' + pageErrors.join(' | '));

      const entry = await page.evaluate(() => {
        const e = db.m.find((m) => m.mediaType === 'anime');
        return e ? JSON.parse(JSON.stringify(e)) : null;
      });
      if (!entry) throw new Error('Kein Anime-Eintrag in db.m nach der Uebernahme');
      if (entry.title !== 'Attack on Titan Season 2') throw new Error('Titel falsch: ' + entry.title);
      if (entry.total !== 12) throw new Error('total sollte 12 sein (nicht aus existing abgeleitet!), war: ' + entry.total);
      if (entry.ongoing !== 'true') throw new Error('ongoing sollte "true" sein, war: ' + entry.ongoing);
      if (!Array.isArray(entry.genres) || entry.genres.join(',') !== 'Action,Drama') throw new Error('genres gingen verloren: ' + JSON.stringify(entry.genres));
      if (entry.cover !== 'https://127.0.0.1/never-loaded-cover.jpg') throw new Error('cover ging verloren: ' + JSON.stringify(entry.cover));
      if (Object.keys(entry.seasons || {}).length !== 12) throw new Error('seasons sollte 12 Eintraege haben, hatte: ' + Object.keys(entry.seasons || {}).length);
      if (entry.seasons['1'] !== 2) throw new Error('seasons-Ordinal sollte 2 sein ("Season 2"), war: ' + entry.seasons['1']);
      if (!entry.externalIds || entry.externalIds.anilistId !== 25777) throw new Error('externalIds.anilistId fehlt: ' + JSON.stringify(entry.externalIds));
      if (entry.externalIds.anilistRootId !== 16498) throw new Error('externalIds.anilistRootId (PREQUEL-Anker) falsch: ' + JSON.stringify(entry.externalIds));
      if (Object.keys(entry.bands || {}).length !== 0) throw new Error('bands muss beim Import leer bleiben, war: ' + JSON.stringify(entry.bands));

      // Persistenz: der Eintrag ueberlebt den localStorage-Roundtrip
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('mtDE')).m.filter((m) => m.mediaType === 'anime').length);
      if (persisted !== 1) throw new Error('Anime-Eintrag wurde nicht persistiert (localStorage), gefunden: ' + persisted);

      // Doppelimport derselben anilistId wird geblockt
      await openSearchAndQuery(page, 'Attack on Titan Season 2');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(300);
      const countAfter = await page.evaluate(() => db.m.filter((m) => m.mediaType === 'anime').length);
      if (countAfter !== 1) throw new Error('Doppelimport derselben anilistId wurde nicht geblockt, Eintraege: ' + countAfter);
      const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
      if (!/bereits in der Sammlung/.test(toastText)) throw new Error('Erwartete Duplikatmeldung, bekam: ' + toastText);

      await context.close();
    });

    // ── Test 19: Medienfilter aus Phase 72 wird nach dem Import real sichtbar ─
    await runTest('Nach dem Anime-Import ist der Medienfilter (Phase 72) sichtbar und filtert Anime korrekt', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      // Reine Manga-Sammlung vorher → Medienfilter MUSS zunaechst unsichtbar sein.
      await seedPage(page, {
        schemaVersion: 3,
        m: [{ id: 'zq1', title: 'Zqx Manga Testserie', pub: 'Panini', mediaType: 'manga', genres: ['Action'], bands: { 1: 'owned' }, status: 'owned' }],
      });
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([media({ title: { english: 'Zqx Anime Import', romaji: null, native: null } })]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series'); // Medienfilter haengt nur in der Serienansicht
      await page.waitForTimeout(250);

      const visibleBefore = await page.locator('#media-filter').isVisible();
      if (visibleBefore) throw new Error('Kontrollzustand verletzt: Medienfilter darf vor dem Anime-Import (reine Manga-Sammlung) nicht sichtbar sein');

      await openSearchAndQuery(page, 'Zqx Anime Import');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(300);

      const visibleAfter = await page.locator('#media-filter').isVisible();
      if (!visibleAfter) {
        const diag = await page.evaluate(() => {
          const sel = document.getElementById('media-filter');
          return {
            shouldShow: shouldShowMediaFilter(db.m),
            mediaTypes: Array.from(new Set(db.m.map((m) => m.mediaType || 'manga'))),
            className: sel && sel.className,
            computed: sel ? window.getComputedStyle(sel).display : 'MISSING',
          };
        });
        throw new Error('Medienfilter ist nach dem Anime-Import unsichtbar, obwohl die Sammlung jetzt mehrere Medientypen enthaelt: ' + JSON.stringify(diag));
      }

      // Und er filtert korrekt: "anime" → nur der importierte Eintrag
      await page.selectOption('#media-filter', 'anime');
      await page.waitForTimeout(300);
      const gridAnime = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Anime Import/.test(gridAnime)) throw new Error('Filter "anime" sollte den importierten Anime zeigen. Grid: ' + gridAnime.slice(0, 300));
      if (/Zqx Manga Testserie/.test(gridAnime)) throw new Error('Filter "anime" darf die Manga-Serie nicht zeigen. Grid: ' + gridAnime.slice(0, 300));

      await page.selectOption('#media-filter', 'manga');
      await page.waitForTimeout(300);
      const gridManga = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Manga Testserie/.test(gridManga)) throw new Error('Filter "manga" sollte die Manga-Serie zeigen. Grid: ' + gridManga.slice(0, 300));
      if (/Zqx Anime Import/.test(gridManga)) throw new Error('Filter "manga" darf den Anime nicht zeigen. Grid: ' + gridManga.slice(0, 300));

      await context.close();
    });

    // ── Test 20: Fehlerpfade (429 / Timeout / 5xx / GraphQL-errors) ─────────
    await runTest('429, Timeout, 5xx und GraphQL-errors: Meldung sichtbar, Sammlung unveraendert, UI nicht blockiert (_anilistBusy-Reset)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      const seed = {
        schemaVersion: 3,
        m: [{ id: 'zq1', title: 'Zqx Manga Testserie', pub: 'Panini', mediaType: 'manga', bands: { 1: 'owned' }, status: 'owned' }],
      };
      await seedPage(page, seed);
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      const idsBefore = await page.evaluate(() => db.m.map((m) => m.id).sort().join('|'));

      // (a) 429 mit zu langem Retry-After → kein Auto-Retry, klare Meldung mit Wartezeit.
      // WICHTIG: Retry-After ist kein CORS-safelisted Response-Header. Ohne
      // `Access-Control-Expose-Headers` kann der Browser ihn bei einer Cross-Origin-
      // Antwort NICHT lesen — der Stub setzt ihn deshalb explizit, sonst testet man
      // nur den Degradationspfad (siehe (a2)).
      await routeAniList(page, async (route) => {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '60', 'Access-Control-Expose-Headers': 'Retry-After' },
          contentType: 'application/json',
          body: JSON.stringify({}),
        });
      });
      await openSearchAndQuery(page, 'Rate Limit Test');
      await page.waitForFunction(() => /Rate Limit/i.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 6000 });
      const rateText = await page.evaluate(() => document.getElementById('anilist-results').textContent);
      if (!/60/.test(rateText)) throw new Error('429-Meldung sollte die Wartezeit aus Retry-After nennen. Text: ' + rateText);
      const runBtnEnabled = await page.evaluate(() => !document.getElementById('btn-anilist-run').disabled);
      if (!runBtnEnabled) throw new Error('Suchen-Button bleibt nach dem 429-Fehler deaktiviert — _anilistBusy wurde nicht zurueckgesetzt (kein finally?)');
      const busyFlag = await page.evaluate(() => _anilistBusy);
      if (busyFlag !== false) throw new Error('_anilistBusy ist nach dem Fehlerfall nicht false, war: ' + busyFlag);

      // (a2) 429 OHNE lesbaren Retry-After (der Realfall, wenn AniList den Header nicht
      // exponiert): trotzdem verstaendliche Meldung, kein Absturz, kein "undefined s".
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 429, headers: { 'Retry-After': '60' }, contentType: 'application/json', body: JSON.stringify({}) });
      });
      await page.fill('#anilist-search-input', 'Rate Limit ohne Header');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForFunction(() => /Rate Limit/i.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 6000 });
      const rateText2 = await page.evaluate(() => document.getElementById('anilist-results').textContent);
      if (/undefined|NaN|null/.test(rateText2)) throw new Error('429-Meldung ohne lesbaren Retry-After enthaelt Platzhaltermuell: ' + rateText2);
      if (await page.evaluate(() => _anilistBusy)) throw new Error('_anilistBusy nach 429 ohne Retry-After nicht zurueckgesetzt');

      // (b) Netzwerk-/Timeout-Pfad: abgebrochene Anfrage
      await routeAniList(page, async (route) => { await route.abort('timedout'); });
      await page.fill('#anilist-search-input', 'Timeout Test');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForFunction(() => /AniList/.test(document.getElementById('anilist-results').textContent)
        && !/Suche bei AniList/.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 10000 });
      const timeoutBusy = await page.evaluate(() => _anilistBusy);
      if (timeoutBusy !== false) throw new Error('_anilistBusy nach Timeout nicht zurueckgesetzt');
      if (await page.evaluate(() => document.getElementById('btn-anilist-run').disabled)) throw new Error('Suchen-Button nach Timeout weiter deaktiviert');

      // (c) HTTP 500
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({}) });
      });
      await page.fill('#anilist-search-input', '5xx Test');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForFunction(() => /Fehler|Verbindung/.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 6000 });

      // (d) HTTP 200 mit errors-Array — res.ok allein ist kein Erfolgssignal
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Too complex' }], data: null }) });
      });
      await page.fill('#anilist-search-input', 'GraphQL Fehler');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForTimeout(600);
      const graphqlHits = await page.evaluate(() => document.querySelectorAll('[data-action="anilist-import"]').length);
      if (graphqlHits !== 0) throw new Error('HTTP 200 mit errors-Array darf keine Treffer anzeigen, hatte: ' + graphqlHits);

      // (e) leere Trefferliste
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([]) });
      });
      await page.fill('#anilist-search-input', 'Gibt es nicht');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForFunction(() => /Keine Treffer/.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 6000 });

      // (f) kaputtes JSON
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{ das ist kein json' });
      });
      await page.fill('#anilist-search-input', 'Kaputtes JSON');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForFunction(() => /Unerwartete Antwort/.test(document.getElementById('anilist-results').textContent), undefined, { timeout: 6000 });

      if (pageErrors.length) throw new Error('pageerror in einem Fehlerpfad (Absturz statt Meldung): ' + pageErrors.join(' | '));

      // Sammlung ist in allen Fehlerfaellen unveraendert geblieben
      const idsAfter = await page.evaluate(() => db.m.map((m) => m.id).sort().join('|'));
      if (idsBefore !== idsAfter) throw new Error('Sammlung wurde durch Fehlerpfade veraendert. Vorher: ' + idsBefore + ' Nachher: ' + idsAfter);

      // Nach allen Fehlern funktioniert eine erfolgreiche Suche weiterhin (UI nicht blockiert)
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([media()]) });
      });
      await page.fill('#anilist-search-input', 'Attack on Titan Season 2');
      await page.click('[data-action="run-anilist-search"]');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 6000 });

      await context.close();
    });

    // ── Test 21: XSS-Gegenprobe ────────────────────────────────────────────
    await runTest('XSS: gestubbter Treffer mit <img onerror>/<script> im Titel wird escaped, kein Script laeuft, keine CSP-Violation', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleMessages = [];
      const pageErrors = [];
      page.on('console', (m) => consoleMessages.push(m.text()));
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('dialog', (d) => d.accept());

      const evilTitle = '<img src=x onerror="window.__xss=1"><script>window.__xss2=1<\/script>';
      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeAniList(page, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: anilistBody([media({
            id: 4242,
            title: { english: evilTitle, romaji: null, native: null },
            genres: ['<img src=x onerror="window.__xss3=1">'],
            coverImage: { large: 'javascript:window.__xss4=1' },
            format: '<b>TV</b>',
          })]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openSearchAndQuery(page, 'boese');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });

      const xssState = await page.evaluate(() => ({
        x1: window.__xss, x2: window.__xss2, x3: window.__xss3, x4: window.__xss4,
        text: document.getElementById('anilist-results').textContent,
        injectedImgs: document.querySelectorAll('#anilist-results img[src="x"]').length,
        injectedScripts: document.querySelectorAll('#anilist-results script').length,
        // Cover mit javascript:-URL darf gar nicht erst gerendert werden
        coverImgs: document.querySelectorAll('#anilist-results img.anilist-hit-cover').length,
      }));
      if (xssState.x1 || xssState.x2 || xssState.x3 || xssState.x4) throw new Error('XSS ausgefuehrt: ' + JSON.stringify(xssState));
      if (xssState.injectedImgs) throw new Error('Injizierte <img>-Elemente im Ergebnis-DOM gefunden');
      if (xssState.injectedScripts) throw new Error('Injizierte <script>-Elemente im Ergebnis-DOM gefunden');
      if (xssState.coverImgs !== 0) throw new Error('javascript:-Cover-URL wurde gerendert statt verworfen');
      if (!xssState.text.includes('<img src=x onerror=')) throw new Error('Der Titel sollte als sichtbarer TEXT (escaped) erscheinen. Text: ' + xssState.text.slice(0, 200));

      // Import des boesartigen Treffers darf ebenfalls nichts ausfuehren
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);
      const afterImport = await page.evaluate(() => ({
        x1: window.__xss, x2: window.__xss2, x3: window.__xss3, x4: window.__xss4,
        title: (db.m.find((m) => m.mediaType === 'anime') || {}).title,
        cover: (db.m.find((m) => m.mediaType === 'anime') || {}).cover,
        gridScripts: document.querySelectorAll('#content script').length,
      }));
      if (afterImport.x1 || afterImport.x2 || afterImport.x3 || afterImport.x4) throw new Error('XSS nach dem Import ausgefuehrt: ' + JSON.stringify(afterImport));
      if (afterImport.gridScripts) throw new Error('Injiziertes <script> im gerenderten Grid gefunden');
      if (afterImport.cover !== null) throw new Error('javascript:-Cover-URL wurde in die Sammlung uebernommen: ' + JSON.stringify(afterImport.cover));

      const cspViolations = consoleMessages
        .filter((t) => /Content Security Policy|Refused to/i.test(t))
        .filter((t) => !isKnownCspNoise(t));
      if (cspViolations.length) throw new Error('CSP-Violations in der Konsole: ' + cspViolations.join(' | '));
      if (pageErrors.length) throw new Error('pageerror im XSS-Test: ' + pageErrors.join(' | '));

      await context.close();
    });

    // ── Test 22: Nicht-Regression der bestehenden Manga-Sammlung ───────────
    await runTest('Nicht-Regression: bestehende Manga-Eintraege sind nach dem Anime-Import feldgleich', async () => {
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
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([media({ title: { english: 'Zqx Anime Neu', romaji: null, native: null } })]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const before = await page.evaluate(() => JSON.stringify(db.m.filter((m) => m.id === 'zq1' || m.id === 'zq2')));

      await openSearchAndQuery(page, 'Zqx Anime Neu');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      const after = await page.evaluate(() => JSON.stringify(db.m.filter((m) => m.id === 'zq1' || m.id === 'zq2')));
      if (before !== after) throw new Error('Bestehende Manga-Eintraege wurden durch den Anime-Import veraendert.\nVorher: ' + before + '\nNachher: ' + after);

      const animeCount = await page.evaluate(() => db.m.filter((m) => m.mediaType === 'anime').length);
      if (animeCount !== 1) throw new Error('Erwartet genau einen Anime-Eintrag, gefunden: ' + animeCount);

      // Public Projection des Anime-Eintrags enthaelt keine privaten AniList-Felder
      const projected = await page.evaluate(() => {
        const anime = db.m.find((m) => m.mediaType === 'anime');
        return buildPublicCollectionData({ schemaVersion: 3, m: [anime] }).m[0];
      });
      ['externalIds', 'anilistAiring', 'notes', 'startedAt', 'finishedAt'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(projected, k)) throw new Error('Privates Feld "' + k + '" in der Public Projection des Anime-Eintrags');
      });
      if (projected.mediaType !== 'anime') throw new Error('mediaType in der Projektion falsch: ' + projected.mediaType);
      if (Object.keys(projected.seasons || {}).length !== 12) throw new Error('seasons kommen nicht durch die Projektion: ' + JSON.stringify(projected.seasons));

      await context.close();
    });

    // ── Test 23: Wunschlisten-Kontext ──────────────────────────────────────
    await runTest('Import aus dem Wunschlisten-Tab setzt status "wishlist"', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeAniList(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: anilistBody([media({ title: { english: 'Zqx Wunsch Anime', romaji: null, native: null } })]) });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await page.click('.tab[data-tab="wishlist"]');
      await page.waitForTimeout(200);

      await openSearchAndQuery(page, 'Zqx Wunsch Anime');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      const status = await page.evaluate(() => (db.m.find((m) => m.mediaType === 'anime') || {}).status);
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
