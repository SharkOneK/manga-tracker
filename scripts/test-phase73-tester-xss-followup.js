#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase73-tester-xss-followup.js — Phase 73 (AniList-Provider), Tester-Nachtrag
 *
 * NICHT Teil von run-all-checks. Prüft zwei Rendering-Pfade, die von
 * scripts/test-phase73-browser-integration.js (Test 21) NICHT erfasst werden:
 * das Ergebnis-Overlay dort escaped korrekt, aber ein importierter Anime-Eintrag
 * landet danach als GANZ NORMALER db.m-Eintrag in bestehenden, von Phase 73 nicht
 * geänderten Rendering-Pfaden (Kalender-Tab, Genre-Filter), die vor dieser Phase
 * nie mit freiem, drittanbieter-kontrolliertem Text gefüttert wurden.
 *
 * Aufruf: node scripts/test-phase73-tester-xss-followup.js
 * Voraussetzung: `npx playwright install chromium` (einmalig).
 *
 * STATUS (Fix-Durchlauf 1): Beide Tests waren beim Tester rot und belegten die
 * Luecke. Sie sind seit dem Fix (escapeHtml() in beiden Senken, src/app.js
 * kal-title + updateGenreFilter()) gruen und bleiben als PERMANENTE
 * Regressionstests bestehen. Die Assertions des Testers sind unveraendert;
 * ergaenzt wurde lediglich je eine ZUSAETZLICHE Pruefung, dass der Titel/das
 * Genre weiterhin als sichtbarer TEXT ankommt — sonst wuerde auch ein "Fix",
 * der das Feld schlicht nicht mehr rendert, gruen laufen.
 *
 * STATUS (Phase 76, Robustheits-Fix): Finding 1 + 2 waren seit Phase 74
 * (Modus-Trennung Manga/Serien, mediaModeItems()) erneut rot — NICHT weil
 * das Escaping regressiert waere, sondern weil beide Senken jetzt modus-
 * gefiltert rendern und der importierte `mediaType: anime`-Eintrag im
 * Default-Modus "manga" gar nicht mehr auftaucht. Fix: vor der Assertion
 * in den Serien-Modus wechseln ([data-action="set-mode"][data-mode="series"]).
 * Die Escaping-Assertions selbst sind UNVERAENDERT.
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

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(repoRoot, reqPath);
      if (!filePath.startsWith(repoRoot)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function freshSession() {
  return JSON.stringify({ access_token: 'jwt-test-1', refresh_token: 'refresh-test-1', expires_at: Math.floor(Date.now() / 1000) + 3600 });
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

function anilistBody(list) {
  return JSON.stringify({ data: { Page: { media: list } } });
}

async function openSearchAndQuery(page, q) {
  await page.click('#btn-add');
  await page.waitForTimeout(150);
  await page.click('[data-action="open-anilist-search"]');
  await page.waitForTimeout(150);
  await page.fill('#anilist-search-input', q);
  await page.click('[data-action="run-anilist-search"]');
}

(async function main() {
  console.log('\nPhase 73 — Tester-Nachtrag: XSS-Pfade jenseits des Such-Overlays\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Finding 1: Kalender-Tab rendert m.title unescaped ───────────────────
    await runTest('Kalender-Tab: importierter Anime-Titel mit HTML wird ESCAPED gerendert (kal-title)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      const evilTitle = '<img src=x onerror="window.__xssKal=1">';
      await seedPage(page, { schemaVersion: 3, m: [] });
      await page.route('https://graphql.anilist.co', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: anilistBody([{
            id: 990001,
            title: { english: evilTitle, romaji: null, native: null },
            episodes: 12, status: 'RELEASING', format: 'TV', seasonYear: 2026, season: 'SPRING',
            coverImage: { large: null }, genres: [],
            // RELEASING + nextAiringEpisode → nextDate wird gesetzt → Eintrag landet im Kalender-Tab.
            // Deterministisch 7 Tage in die Zukunft (statt +86400), damit die lokale
            // Datumsumrechnung nie an eine Tagesgrenze rutscht.
            nextAiringEpisode: { episode: 5, airingAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
            relations: { edges: [] },
          }]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openSearchAndQuery(page, 'evil kalender');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      const nextDate = await page.evaluate(() => (db.m.find((m) => m.mediaType === 'anime') || {}).nextDate);
      if (!nextDate) throw new Error('Testvoraussetzung verletzt: importierter Eintrag hat kein nextDate, Kalender-Pfad nicht erreichbar');

      // Phase 76: der Kalender rendert modusabhaengig (mediaModeItems()) — der
      // importierte Anime-Eintrag taucht im Default-Modus "manga" nicht auf.
      // In den Serien-Modus wechseln, um die Senke ueberhaupt zu erreichen.
      await page.click('[data-action="set-mode"][data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('[data-action="set-tab"][data-tab="kalender"]');
      await page.waitForTimeout(400);

      const injectedImgCount = await page.evaluate(() => document.querySelectorAll('#content .kal-title img').length);
      const xssFired = await page.evaluate(() => !!window.__xssKal);
      if (injectedImgCount > 0 || xssFired) {
        throw new Error(
          'src/app.js render() Kalender-Zweig (~Zeile 2265) baut `<div class="kal-title">${m.title}</div>` OHNE escapeHtml(). ' +
          'Ein importierter Anime-Titel mit HTML/`<img onerror>` wird als DOM-Knoten gerendert statt als Text. ' +
          'injectedImgCount=' + injectedImgCount + ', xssFired(window.__xssKal)=' + xssFired
        );
      }

      // Zusatzpruefung (Fix-Durchlauf 1): der Titel muss weiterhin als TEXT ankommen.
      // Ohne diese Assertion wuerde auch ein "Fix" gruen laufen, der kal-title einfach weglaesst.
      // Der Kalender enthaelt auch die eingebaute Startsammlung — daher ALLE .kal-title
      // einsammeln und nur pruefen, dass unser importierter Eintrag darunter ist.
      const kalTitles = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#content .kal-title')).map((el) => el.textContent));
      if (!kalTitles.length) throw new Error('Kein .kal-title im Kalender-Tab gefunden — der Eintrag wird gar nicht mehr gerendert (kein gueltiger Fix)');
      if (!kalTitles.some((t) => t.includes('<img src=x onerror='))) {
        throw new Error('Der importierte Titel muss escaped als sichtbarer TEXT erscheinen, war: ' + JSON.stringify(kalTitles));
      }

      await context.close();
    });

    // ── Finding 2: Genre-Filter-Chip rendert Genre-Text unescaped ───────────
    await runTest('Genre-Filter (Serienansicht): importiertes Anime-Genre mit HTML wird ESCAPED gerendert (genre-filter-chip)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      const evilGenre = '<img src=x onerror="window.__xssGenre=1">';
      await seedPage(page, { schemaVersion: 3, m: [] });
      await page.route('https://graphql.anilist.co', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: anilistBody([{
            id: 990002,
            title: { english: 'Harmless Title For Genre Test', romaji: null, native: null },
            episodes: 12, status: 'FINISHED', format: 'TV', seasonYear: 2026, season: 'SPRING',
            coverImage: { large: null }, genres: [evilGenre],
            nextAiringEpisode: null,
            relations: { edges: [] },
          }]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openSearchAndQuery(page, 'harmless genre test');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      const entryGenres = await page.evaluate(() => (db.m.find((m) => m.mediaType === 'anime') || {}).genres);
      if (!entryGenres || !entryGenres.length) throw new Error('Testvoraussetzung verletzt: importierter Eintrag hat keine genres, Filter-Pfad nicht erreichbar');

      // Phase 76: updateGenreFilter() rechnet ueber mediaModeItems() (modusgefiltert)
      // — der importierte Anime-Eintrag ist im Default-Modus "manga" unsichtbar.
      // Erst in den Serien-Modus wechseln, danach wie gehabt die Serienansicht oeffnen.
      await page.click('[data-action="set-mode"][data-mode="series"]');
      await page.waitForTimeout(150);
      // updateGenreFilter() wird nur in der Serienansicht (renderSeriesGrid) aufgerufen.
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(150);
      await page.click('#vbtn-series');
      await page.waitForTimeout(300);

      const injectedImgCount = await page.evaluate(() => document.querySelectorAll('#genre-filter-wrap img').length);
      const xssFired = await page.evaluate(() => !!window.__xssGenre);
      if (injectedImgCount > 0 || xssFired) {
        throw new Error(
          'src/app.js updateGenreFilter() (~Zeile 1701) baut den sichtbaren Chip-Text als ' +
          '`${g||\'Alle\'}` OHNE escapeHtml() (nur das data-genre-Attribut ist escaped). ' +
          'Ein importiertes Anime-Genre mit HTML wird als DOM-Knoten gerendert statt als Text. ' +
          'injectedImgCount=' + injectedImgCount + ', xssFired(window.__xssGenre)=' + xssFired
        );
      }

      // Zusatzpruefung (Fix-Durchlauf 1): das Genre muss weiterhin als TEXT im Chip stehen.
      const chipTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#genre-filter-wrap .genre-filter-chip')).map((el) => el.textContent));
      if (!chipTexts.length) throw new Error('Keine Genre-Chips gefunden — der Filter wird gar nicht mehr gerendert (kein gueltiger Fix)');
      if (!chipTexts.some((t) => t.includes('<img src=x onerror='))) {
        throw new Error('Das Genre muss escaped als sichtbarer TEXT im Chip erscheinen, war: ' + JSON.stringify(chipTexts));
      }

      await context.close();
    });

    // ── Finding 3 (Nachtest 1): Dashboard „Genre-Verteilung" rendert g unescaped ─
    await runTest('Dashboard Genre-Verteilung: importiertes Anime-Genre mit HTML wird ESCAPED gerendert (bar-label)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      const evilGenre = '<img src=x onerror="window.__xssDash=1">';
      // Die Dashboard-Genre-Verteilung zeigt nur die TOP 8 Genres (src/app.js:1360,
      // slice(0,8)). Die eingebaute Startsammlung liefert bereits 8 Genres mit hoher
      // Frequenz (Action=30 … Romance=8). Damit das boese Genre garantiert in den
      // Balken landet und nicht vom Top-8-Cap verdraengt wird, wird die Sammlung mit
      // genug Traegern vorbelegt (count ~15). Der spaetere AniList-Import fuegt
      // demselben Feld einen weiteren Treffer hinzu und beweist die Erreichbarkeit
      // ueber den Importpfad; das Ranking haengt aber nicht allein an diesem +1.
      const primerEntries = [];
      for (let i = 0; i < 15; i++) {
        primerEntries.push({
          id: 'zq-primer-' + i, title: 'Zqx Dashboard Primer ' + i, pub: '',
          mediaType: 'manga', genres: [evilGenre], bands: { 1: 'owned' }, status: 'owned',
        });
      }
      await seedPage(page, { schemaVersion: 3, m: primerEntries });
      await page.route('https://graphql.anilist.co', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: anilistBody([{
            id: 990003,
            title: { english: 'Harmless Dashboard Test', romaji: null, native: null },
            episodes: 12, status: 'FINISHED', format: 'TV', seasonYear: 2026, season: 'SPRING',
            coverImage: { large: null }, genres: [evilGenre],
            nextAiringEpisode: null,
            relations: { edges: [] },
          }]),
        });
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openSearchAndQuery(page, 'harmless dashboard test');
      await page.waitForSelector('[data-action="anilist-import"]', { timeout: 5000 });
      await page.click('[data-action="anilist-import"]');
      await page.waitForTimeout(400);

      const entryGenres = await page.evaluate(() => (db.m.find((m) => m.mediaType === 'anime') || {}).genres);
      if (!entryGenres || !entryGenres.length) throw new Error('Testvoraussetzung verletzt: importierter Eintrag hat keine genres, Dashboard-Pfad nicht erreichbar');

      // Dashboard-Tab oeffnen → renderDashboard() baut die Genre-Verteilungs-Balken.
      await page.click('[data-action="set-tab"][data-tab="dashboard"]');
      await page.waitForTimeout(400);

      const injectedImgCount = await page.evaluate(() => document.querySelectorAll('#content .bar-label img').length);
      const xssFired = await page.evaluate(() => !!window.__xssDash);
      if (injectedImgCount > 0 || xssFired) {
        throw new Error(
          'src/app.js renderDashboard() Genre-Verteilung (~Zeile 1641) baut `<div class="bar-label">${g}</div>` ' +
          'OHNE escapeHtml(). Ein importiertes Anime-Genre mit HTML wird als DOM-Knoten gerendert statt als Text. ' +
          'injectedImgCount=' + injectedImgCount + ', xssFired(window.__xssDash)=' + xssFired
        );
      }

      // Zusatzpruefung: das Genre muss weiterhin als TEXT im bar-label erscheinen —
      // sonst wuerde auch ein "Fix", der das Label weglaesst, gruen laufen.
      const barLabelTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#content .bar-label')).map((el) => el.textContent));
      if (!barLabelTexts.some((t) => t.includes('<img src=x onerror='))) {
        throw new Error('Das Genre muss escaped als sichtbarer TEXT im bar-label erscheinen, war: ' + JSON.stringify(barLabelTexts));
      }

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
