#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase74-browser-integration.js — Phase 74
 * (UI-Trennung Manga vs. Serien & Anime über Top-Level-Umschalter)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase72/73-browser-integration.js).
 *
 * Grund fuer eine echte Browser-Suite (Phase-72/73-Lehre): die DOM-freien
 * Mirror-Unit-Tests sahen die realen JS/CSS/DOM-Fehler der Phasen 72/73 NICHT —
 * run-all-checks war gruen, waehrend das Feature in der App nicht funktionierte.
 * Die Modus-Trennung ist genau so ein reiner UI/DOM-Fall: getestet wird gegen das
 * ECHTE src/app.js + index.html.
 *
 * Aufruf: node scripts/test-phase74-browser-integration.js
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

// ─── Mini static file server (wie in Phase 72/73) ─────────────────────────
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
  return JSON.stringify({
    access_token: 'jwt-test-1',
    refresh_token: 'refresh-test-1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

// Vorbestehendes, Phase-74-unabhaengiges Browser-Rauschen (siehe Phase 73):
function isKnownCspNoise(text) {
  return /frame-ancestors' is ignored when delivered via a <meta> element/.test(text);
}

// Ein angemeldeter Owner ohne Cloud-Sammlung mit definierter lokaler Sammlung.
// `mode` optional: schreibt localStorage['mtMode'] vor dem ersten Boot.
async function seedPage(page, db, mode) {
  await page.route('**/rpc/get_my_collection_ids', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.addInitScript((seed) => {
    localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
    localStorage.setItem('mtDE', JSON.stringify(seed.db));
    if (seed.mode) localStorage.setItem('mtMode', seed.mode);
  }, { session: freshSession(), db, mode: mode || null });
}

// Titel bewusst mit "Zqx"-Praefix, damit sie mit KEINEM der HTML-Seed-Keys
// (upsertManga) per Substring kollidieren (Phase-72/73-Konvention).
function mixedSeed() {
  return {
    schemaVersion: 3,
    m: [
      { id: 'zm1', title: 'Zqx Manga Eins', pub: 'Panini', mediaType: 'manga', genres: ['Action', 'Fantasy'], bands: { 1: 'owned', 2: 'completed' }, status: 'owned', total: 5, ongoing: 'true', nextDate: '2026-09-01' },
      { id: 'zm2', title: 'Zqx Manga Zwei', pub: 'Carlsen', mediaType: 'manga', genres: ['Drama'], bands: { 1: 'owned' }, status: 'owned', total: 3 },
      { id: 'zs1', title: 'Zqx Serie Eins', pub: 'Netflix', mediaType: 'series', genres: ['Action', 'Drama'], bands: { 1: 'owned' }, status: 'owned', total: 8, nextDate: '2026-10-01' },
      { id: 'za1', title: 'Zqx Anime Eins', pub: 'Crunchyroll', mediaType: 'anime', genres: ['Action'], bands: { 1: 'owned' }, status: 'owned', total: 12 },
    ],
  };
}

// Nur die beiden Manga aus mixedSeed() — als reine Manga-Referenz (Nicht-Regression).
function mangaOnlySeed() {
  const s = mixedSeed();
  return { schemaVersion: 3, m: s.m.filter((m) => m.mediaType === 'manga') };
}

// Zur Serienansicht (⊞) im gegebenen Tab wechseln — die Filter-/Grid-Pfade
// (renderSeriesGrid) haengen dort. reading/owned/completed starten in ☰.
async function libraryGrid(page, tab) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(120);
  await page.click('#vbtn-series');
  await page.waitForTimeout(200);
}

async function gridText(page) {
  return page.evaluate(() => document.getElementById('content').textContent);
}

(async function main() {
  console.log('\nPhase 74 — Browser-Integrationstests (echtes src/app.js, Modus-Trennung)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test 1: Erststart ohne mtMode → Modus Manga; Bibliothek nur manga ──
    await runTest('Erststart ohne mtMode → Modus = Manga; Bibliothek zeigt nur mediaType "manga"', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) consoleErrors.push(m.text()); });

      await seedPage(page, mixedSeed()); // KEIN mtMode gesetzt
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      if (pageErrors.length) throw new Error('pageerror beim Boot: ' + pageErrors.join(' | '));
      if (consoleErrors.length) throw new Error('Konsolenfehler beim Boot: ' + consoleErrors.join(' | '));

      const mode = await page.evaluate(() => appMode);
      if (mode !== 'manga') throw new Error('Default-Modus muss "manga" sein, war: ' + mode);

      // Umschalter sichtbar, Manga-Button aktiv
      const switchVisible = await page.locator('#mode-switch [data-mode="manga"]').isVisible();
      if (!switchVisible) throw new Error('Modus-Umschalter ist nicht sichtbar');
      const mangaActive = await page.evaluate(() => document.querySelector('#mode-switch [data-mode="manga"]').classList.contains('active'));
      if (!mangaActive) throw new Error('Manga-Button muss im Default-Modus aktiv sein');

      await libraryGrid(page, 'owned');
      const g = await gridText(page);
      if (!/Zqx Manga Eins/.test(g) || !/Zqx Manga Zwei/.test(g)) throw new Error('Manga-Modus sollte beide Manga zeigen. Grid: ' + g.slice(0, 300));
      if (/Zqx Serie Eins/.test(g) || /Zqx Anime Eins/.test(g)) throw new Error('Manga-Modus darf keine Serie/Anime zeigen. Grid: ' + g.slice(0, 300));

      await context.close();
    });

    // ── Test 2: Wechsel zu Serien und zurueck ──────────────────────────────
    await runTest('Wechsel zu Serien → nur series+anime (kein manga); zurück → wieder nur manga', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      if ((await page.evaluate(() => appMode)) !== 'series') throw new Error('appMode sollte nach Klick "series" sein');
      await libraryGrid(page, 'owned');
      let g = await gridText(page);
      if (!/Zqx Serie Eins/.test(g) || !/Zqx Anime Eins/.test(g)) throw new Error('Serien-Modus sollte Serie UND Anime zeigen. Grid: ' + g.slice(0, 300));
      if (/Zqx Manga Eins/.test(g) || /Zqx Manga Zwei/.test(g)) throw new Error('Serien-Modus darf keinen Manga zeigen. Grid: ' + g.slice(0, 300));

      await page.click('#mode-switch [data-mode="manga"]');
      await page.waitForTimeout(150);
      await libraryGrid(page, 'owned');
      g = await gridText(page);
      if (!/Zqx Manga Eins/.test(g) || /Zqx Serie Eins/.test(g)) throw new Error('Zurück zu Manga: nur Manga sichtbar. Grid: ' + g.slice(0, 300));

      await context.close();
    });

    // ── Test 3: Persistenz ueber Reload ────────────────────────────────────
    await runTest('Persistenz: Modus setzen, Reload → Modus (localStorage) und Anzeige bleiben', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      const stored = await page.evaluate(() => localStorage.getItem('mtMode'));
      if (stored !== 'series') throw new Error('mtMode sollte in localStorage "series" sein, war: ' + JSON.stringify(stored));

      // Reload (gleicher Kontext → localStorage bleibt). addInitScript setzt mtMode NICHT,
      // daher entscheidet der zuvor persistierte Wert.
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      if ((await page.evaluate(() => appMode)) !== 'series') throw new Error('appMode nach Reload nicht "series" (Persistenz gebrochen)');
      const seriesActive = await page.evaluate(() => document.querySelector('#mode-switch [data-mode="series"]').classList.contains('active'));
      if (!seriesActive) throw new Error('Serien-Button nach Reload nicht aktiv');
      await libraryGrid(page, 'owned');
      const g = await gridText(page);
      if (!/Zqx Serie Eins/.test(g) || /Zqx Manga Eins/.test(g)) throw new Error('Nach Reload sollte weiter der Serien-Modus angezeigt werden. Grid: ' + g.slice(0, 300));

      await context.close();
    });

    // ── Test 4: Dashboard Manga-Modus = Kennzahlen der Manga-Teilmenge ──────
    await runTest('Dashboard Manga-Modus (gemischt) = numerisch identisch zur reinen Manga-Referenz (Nicht-Regression)', async () => {
      const LABELS = ['Serien', 'Bände besessen', 'Aktiv lesend', 'Bände abgeschlossen', 'Zu kaufen', 'Fehlende Bände', 'Vollständig gesammelt'];
      async function dashboardStats(seed, mode) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await seedPage(page, seed, mode);
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        await page.click('.nav-item[data-nav="dashboard"]');
        await page.waitForTimeout(250);
        const stats = await page.evaluate((labels) => {
          const cards = Array.from(document.querySelectorAll('.stat-big-card'));
          const out = {};
          labels.forEach((l) => {
            const card = cards.find((c) => (c.querySelector('.stat-big-l') || {}).textContent === l);
            out[l] = card ? Number((card.querySelector('.stat-big-n') || {}).textContent) : null;
          });
          return out;
        }, LABELS);
        await context.close();
        return stats;
      }

      const mixedMangaMode = await dashboardStats(mixedSeed(), 'manga');
      const mangaOnly = await dashboardStats(mangaOnlySeed(), 'manga');

      LABELS.forEach((l) => {
        if (mixedMangaMode[l] === null) throw new Error('Statkarte "' + l + '" im Dashboard nicht gefunden');
        if (mixedMangaMode[l] !== mangaOnly[l]) {
          throw new Error('Nicht-Regression verletzt: "' + l + '" im Manga-Modus (gemischt)=' + mixedMangaMode[l] + ', reine Manga-Referenz=' + mangaOnly[l]);
        }
      });
    });

    // ── Test 5: Dashboard Serien-Modus bei leerem Serien-Bestand ────────────
    await runTest('Dashboard Serien-Modus bei reiner Manga-Sammlung → Nullen/Empty-State, keine Manga-Zahlen', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await seedPage(page, mangaOnlySeed(), 'series'); // Serien-Modus, aber nur Manga vorhanden
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      if (pageErrors.length) throw new Error('pageerror (Division-durch-0/Crash?) im leeren Serien-Modus: ' + pageErrors.join(' | '));

      await page.click('.nav-item[data-nav="dashboard"]');
      await page.waitForTimeout(250);
      const serienCard = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.stat-big-card'));
        const c = cards.find((x) => (x.querySelector('.stat-big-l') || {}).textContent === 'Serien');
        return c ? Number((c.querySelector('.stat-big-n') || {}).textContent) : null;
      });
      if (serienCard !== 0) throw new Error('Serien-Modus bei reiner Manga-Sammlung: "Serien"-Kennzahl muss 0 sein (keine Manga-Phantomzahl), war: ' + serienCard);

      await context.close();
    });

    // ── Test 6: Begriffe pro Modus (definierte DOM-Stellen) ────────────────
    await runTest('Begriffe: Serien-Modus zeigt angepasste Labels (Folgen/Weiterschauen/Anbieter), Manga-Modus die alten', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      // Manga-Modus: side-vol-total endet auf "Bände"
      const mangaSide = await page.evaluate(() => document.getElementById('side-vol-total').textContent);
      if (!/Bände\s*$/.test(mangaSide)) throw new Error('Manga-Modus side-vol-total sollte auf "Bände" enden, war: ' + JSON.stringify(mangaSide));

      // Manga-Modus Dashboard: "Zu lesen" (Balkenlabel) und "Verlage" (Sektion)
      await page.click('.nav-item[data-nav="dashboard"]');
      await page.waitForTimeout(250);
      let dash = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zu lesen/.test(dash) || !/Verlage/.test(dash)) throw new Error('Manga-Dashboard sollte "Zu lesen" und "Verlage" zeigen');
      if (/Weiterschauen/.test(dash) || /Anbieter/.test(dash)) throw new Error('Manga-Dashboard darf keine Serien-Labels zeigen');

      // Serien-Modus
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(200);
      const seriesSide = await page.evaluate(() => document.getElementById('side-vol-total').textContent);
      if (!/Folgen\s*$/.test(seriesSide)) throw new Error('Serien-Modus side-vol-total sollte auf "Folgen" enden, war: ' + JSON.stringify(seriesSide));

      await page.click('.nav-item[data-nav="dashboard"]');
      await page.waitForTimeout(250);
      dash = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Weiterschauen/.test(dash)) throw new Error('Serien-Dashboard sollte "Weiterschauen" statt "Zu lesen" zeigen');
      if (!/Anbieter/.test(dash)) throw new Error('Serien-Dashboard sollte "Anbieter" statt "Verlage" zeigen');

      await context.close();
    });

    // ── Test 6b: sichtbare Tab-Pillen + Sidebar-Nav + Band-Status-Labels ───
    await runTest('Begriffe: Tab-Pillen/Sidebar/Band-Status-Buttons schalten je Modus (Manga wortgleich)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const pills = () => page.$$eval('#tabs .tab-lbl[data-status]', els =>
        Object.fromEntries(els.map(e => [e.dataset.status, e.textContent])));
      const navs = () => page.$$eval('.nav-lbl[data-status]', els =>
        Object.fromEntries(els.map(e => [e.dataset.status, e.textContent])));

      // Manga-Modus: wortgleich zum bisherigen statischen HTML (Nicht-Regressions-Anker).
      const pM = await pills();
      if (pM.reading !== '📖 Lese ich' || pM.completed !== '✅ Gelesen' || pM.owned !== '📚 Zu lesen') {
        throw new Error('Manga-Tab-Pillen nicht wortgleich: ' + JSON.stringify(pM));
      }
      const nM = await navs();
      if (nM.reading !== 'Lese ich' || nM.owned !== 'Zu lesen') {
        throw new Error('Manga-Sidebar-Nav nicht wortgleich: ' + JSON.stringify(nM));
      }

      // Serien-Modus: angepasste Begriffe, UND die Manga-Wörter dürfen NICHT mehr in den Pillen stehen.
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(250);
      const pS = await pills();
      if (pS.reading !== '📺 Schaue ich' || pS.completed !== '✅ Gesehen' || pS.owned !== '📺 Weiterschauen') {
        throw new Error('Serien-Tab-Pillen nicht angepasst: ' + JSON.stringify(pS));
      }
      if (/Lese ich|Zu lesen|Gelesen/.test(Object.values(pS).join('|'))) {
        throw new Error('Serien-Modus zeigt noch Manga-Begriffe in den Pillen: ' + JSON.stringify(pS));
      }
      const nS = await navs();
      if (nS.reading !== 'Schaue ich' || nS.owned !== 'Weiterschauen') {
        throw new Error('Serien-Sidebar-Nav nicht angepasst: ' + JSON.stringify(nS));
      }

      // Band-Status-Button (stLabel) schaltet ebenfalls: in der Bändenansicht eines Serien-Eintrags.
      // Wir prüfen den in Serien-Modus gerenderten owned-Button-Text via ST-Label-Konstanten indirekt:
      const btnText = await page.evaluate(() => {
        const b = document.querySelector('.band-status-btn');
        return b ? b.textContent.trim() : null;
      });
      if (btnText && /Zu lesen|Lese ich|Gelesen/.test(btnText)) {
        throw new Error('Band-Status-Button zeigt im Serien-Modus noch Manga-Begriff: ' + JSON.stringify(btnText));
      }

      // Zurück zu Manga: Pillen wieder bitidentisch.
      await page.click('#mode-switch [data-mode="manga"]');
      await page.waitForTimeout(250);
      const pBack = await pills();
      if (pBack.reading !== '📖 Lese ich' || pBack.completed !== '✅ Gelesen' || pBack.owned !== '📚 Zu lesen') {
        throw new Error('Rückwechsel zu Manga nicht bitidentisch: ' + JSON.stringify(pBack));
      }

      await context.close();
    });

    // ── Test 7: Kalender pro Modus ─────────────────────────────────────────
    await runTest('Kalender zeigt je Modus nur passende Termine', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('.nav-item[data-nav="kalender"]');
      await page.waitForTimeout(200);
      let kal = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Manga Eins/.test(kal)) throw new Error('Manga-Kalender sollte den Manga-Termin zeigen. Inhalt: ' + kal.slice(0, 300));
      if (/Zqx Serie Eins/.test(kal)) throw new Error('Manga-Kalender darf den Serien-Termin nicht zeigen. Inhalt: ' + kal.slice(0, 300));

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      // nach Moduswechsel bleibt der Kalender-Tab aktiv (render() gleicher Tab)
      kal = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Serie Eins/.test(kal)) throw new Error('Serien-Kalender sollte den Serien-Termin zeigen. Inhalt: ' + kal.slice(0, 300));
      if (/Zqx Manga Eins/.test(kal)) throw new Error('Serien-Kalender darf den Manga-Termin nicht zeigen. Inhalt: ' + kal.slice(0, 300));

      await context.close();
    });

    // ── Test 8: Unterfilter Sichtbarkeit + Filterwirkung ───────────────────
    await runTest('Unterfilter: im Manga-Modus versteckt; im Serien-Modus (series+anime) sichtbar und filternd', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      // Manga-Modus: #media-filter unsichtbar (nur ein Typ in der Modus-Teilmenge)
      await libraryGrid(page, 'owned');
      if (await page.locator('#media-filter').isVisible()) {
        const diag = await page.evaluate(() => ({ appMode, filterMedia, cls: document.getElementById('media-filter').className }));
        throw new Error('Manga-Modus: #media-filter muss versteckt sein. Diag: ' + JSON.stringify(diag));
      }

      // Serien-Modus: series+anime vorhanden → sichtbar
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await libraryGrid(page, 'owned');
      if (!(await page.locator('#media-filter').isVisible())) {
        const diag = await page.evaluate(() => ({
          appMode,
          shouldShow: shouldShowMediaFilter(mediaModeItems()),
          types: Array.from(new Set(mediaModeItems().map((m) => m.mediaType || 'manga'))),
          cls: document.getElementById('media-filter').className,
        }));
        throw new Error('Serien-Modus: #media-filter muss sichtbar sein (series+anime). Diag: ' + JSON.stringify(diag));
      }

      // Filter "anime" → nur der Anime
      await page.selectOption('#media-filter', 'anime');
      await page.waitForTimeout(200);
      let g = await gridText(page);
      if (!/Zqx Anime Eins/.test(g) || /Zqx Serie Eins/.test(g)) throw new Error('Unterfilter "anime" sollte nur den Anime zeigen. Grid: ' + g.slice(0, 300));

      // Filter "series" → nur die Serie
      await page.selectOption('#media-filter', 'series');
      await page.waitForTimeout(200);
      g = await gridText(page);
      if (!/Zqx Serie Eins/.test(g) || /Zqx Anime Eins/.test(g)) throw new Error('Unterfilter "series" sollte nur die Serie zeigen. Grid: ' + g.slice(0, 300));

      // Es gibt bewusst KEINE "manga"-Option mehr im Serien-Unterfilter.
      const hasMangaOption = await page.evaluate(() => !!document.querySelector('#media-filter option[value="manga"]'));
      if (hasMangaOption) throw new Error('#media-filter darf im Modus-Modell keine "manga"-Option mehr haben');

      await context.close();
    });

    // ── Test 9: Zusammenspiel Genre/Suche/Sortierung/viewMode im Modus ─────
    await runTest('Zusammenspiel: Genre (Phase 67) + Suche + Sortierung + viewMode ⊞/☰ bleiben innerhalb des Modus', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      await libraryGrid(page, 'owned');

      // Genre "Drama": nur Zqx Serie Eins (hat Drama), kein Anime, kein Manga
      const dramaChip = page.locator('[data-action="set-genre-filter"][data-genre="Drama"]');
      if (await dramaChip.count()) {
        await dramaChip.click();
        await page.waitForTimeout(200);
        const g = await gridText(page);
        if (!/Zqx Serie Eins/.test(g)) throw new Error('Genre "Drama" im Serien-Modus sollte Zqx Serie Eins zeigen. Grid: ' + g.slice(0, 300));
        if (/Zqx Manga Eins/.test(g) || /Zqx Manga Zwei/.test(g)) throw new Error('Genre-Filter darf nicht aus dem Modus ausbrechen (kein Manga). Grid: ' + g.slice(0, 300));
        // Genre zuruecksetzen
        const allChip = page.locator('[data-action="set-genre-filter"][data-genre=""]');
        if (await allChip.count()) { await allChip.click(); await page.waitForTimeout(120); }
      }

      // Suche "Zqx" → nur Modus-Eintraege (Serie+Anime), niemals Manga
      await page.fill('#search-input', 'Zqx');
      await page.waitForTimeout(200);
      let g = await gridText(page);
      if (/Zqx Manga/.test(g)) throw new Error('Suche darf im Serien-Modus keine Manga zeigen. Grid: ' + g.slice(0, 300));
      if (!/Zqx Serie Eins/.test(g) || !/Zqx Anime Eins/.test(g)) throw new Error('Suche "Zqx" sollte Serie+Anime zeigen. Grid: ' + g.slice(0, 300));
      await page.fill('#search-input', '');
      await page.waitForTimeout(120);

      // Sortierung Z-A + viewMode ☰ (Baendenliste) — weiterhin nur Modus-Eintraege
      await page.selectOption('#sort-select', 'za');
      await page.waitForTimeout(120);
      await page.click('#vbtn-volumes');
      await page.waitForTimeout(200);
      g = await gridText(page);
      if (/Zqx Manga/.test(g)) throw new Error('Baendenansicht (☰) im Serien-Modus darf keine Manga zeigen. Grid: ' + g.slice(0, 300));

      await context.close();
    });

    // ── Test 10: Gegenprobe Modus-Zustandslogik (reconcile-Reset misst wirklich) ──
    await runTest('Gegenprobe: stale Unterfilter wird beim Moduswechsel/Datenschwund von der PRODUKTIVLOGIK zurückgesetzt (Reset entfernen → rot)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      await libraryGrid(page, 'owned');

      // (a) Unterfilter auf "anime" setzen, dann in den Manga-Modus wechseln.
      await page.selectOption('#media-filter', 'anime');
      await page.waitForTimeout(150);
      if ((await page.evaluate(() => filterMedia)) !== 'anime') throw new Error('Setup: filterMedia sollte "anime" sein');

      await page.click('#mode-switch [data-mode="manga"]');
      await page.waitForTimeout(150);
      // Manga-Zweig von reconcileMediaFilterState() MUSS filterMedia leeren. Ohne diesen
      // Reset bliebe filterMedia="anime" — genau das misst dieser Assert (Gegenprobe:
      // den Manga-Zweig-Reset entfernen → dieser Test wird rot).
      let fm = await page.evaluate(() => filterMedia);
      if (fm !== '') throw new Error('Moduswechsel zu Manga muss stale filterMedia zurücksetzen ("" erwartet), war: ' + JSON.stringify(fm));
      let g = await (async () => { await libraryGrid(page, 'owned'); return gridText(page); })();
      if (!/Zqx Manga Eins/.test(g)) throw new Error('Nach Moduswechsel darf die Bibliothek nicht durch einen stale Unterfilter leer erscheinen. Grid: ' + g.slice(0, 300));

      // (b) Serien-Zweig: Unterfilter "anime" aktiv, dann die letzte Anime-Serie loeschen,
      //     WAEHREND der Serien-Modus aktiv bleibt → Serien-Teilmenge hat nur noch "series",
      //     shouldShowMediaFilter()=false → Reset. Ohne den Serien-Zweig-Reset (VOR der
      //     Filterkette) waere die Bibliothek leer, obwohl die Serie existiert.
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await libraryGrid(page, 'owned');
      await page.selectOption('#media-filter', 'anime');
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('mtDE'));
        raw.m = raw.m.filter((m) => m.mediaType !== 'anime');
        localStorage.setItem('mtDE', JSON.stringify(raw));
        db.m = raw.m;
        render();
      });
      await page.waitForTimeout(200);
      fm = await page.evaluate(() => filterMedia);
      if (fm !== '') throw new Error('Nach Löschen der letzten Anime-Serie im Serien-Modus muss filterMedia zurückgesetzt sein ("" erwartet), war: ' + JSON.stringify(fm));
      g = await gridText(page);
      if (!/Zqx Serie Eins/.test(g)) throw new Error('Verbliebene Serie muss sichtbar sein (Bibliothek nicht leer trotz stale Unterfilter). Grid: ' + g.slice(0, 300));
      const filterHidden = await page.evaluate(() => { const s = document.getElementById('media-filter'); return !s || window.getComputedStyle(s).display === 'none'; });
      if (!filterHidden) throw new Error('Unterfilter muss versteckt sein, wenn die Serien-Teilmenge nur noch einen Typ enthält');

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
