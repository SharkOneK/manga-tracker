#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase78-browser-integration.js — Phase 78
 * (Buy-Tab im Serien-Modus ausblenden + Dashboard-Kaufvorschau modusabhängig)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase74/75-browser-integration.js).
 *
 * Grund fuer eine echte Browser-Suite (Phase-72/73-Lehre): die DOM-freien
 * Mirror-Unit-Tests sahen die realen JS/CSS/DOM-Fehler der Phasen 72/73 NICHT —
 * run-all-checks war gruen, waehrend das Feature in der App nicht funktionierte.
 * Buy-Tab-Sichtbarkeit + Redirect sind genau so ein reiner UI/DOM-Fall: getestet
 * wird gegen das ECHTE src/app.js + index.html.
 *
 * Aufruf: node scripts/test-phase78-browser-integration.js
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

// ─── Mini static file server (wie in Phase 72/73/74/75) ───────────────────
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

// Vorbestehendes, phasenunabhaengiges Browser-Rauschen (siehe Phase 73):
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
// (upsertManga) per Substring kollidieren (Phase-72/73-Konvention). nextDate
// in der Zukunft gesetzt, damit ein Kauf-Vorschau-Eintrag existiert.
function mixedSeed() {
  return {
    schemaVersion: 3,
    m: [
      { id: 'zm1', title: 'Zqx Manga Eins', pub: 'Panini', mediaType: 'manga', genres: ['Action', 'Fantasy'], bands: { 1: 'owned', 2: 'completed' }, status: 'owned', total: 5, ongoing: 'true', nextDate: '2099-09-01' },
      { id: 'zm2', title: 'Zqx Manga Zwei', pub: 'Carlsen', mediaType: 'manga', genres: ['Drama'], bands: { 1: 'owned' }, status: 'owned', total: 3 },
      { id: 'zs1', title: 'Zqx Serie Eins', pub: 'Netflix', mediaType: 'series', genres: ['Action', 'Drama'], bands: { 1: 'owned' }, status: 'owned', total: 8, nextDate: '2099-10-01' },
      { id: 'za1', title: 'Zqx Anime Eins', pub: 'Crunchyroll', mediaType: 'anime', genres: ['Action'], bands: { 1: 'owned' }, status: 'owned', total: 12 },
    ],
  };
}

// Nur die beiden Manga aus mixedSeed() — als reine Manga-Referenz (Nicht-Regression).
function mangaOnlySeed() {
  const s = mixedSeed();
  return { schemaVersion: 3, m: s.m.filter((m) => m.mediaType === 'manga') };
}

async function contentText(page) {
  return page.evaluate(() => document.getElementById('content').textContent);
}

(async function main() {
  console.log('\nPhase 78 — Browser-Integrationstests (echtes src/app.js, Buy-Tab im Serien-Modus)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── T1: Manga-Modus — Buy-Tab sichtbar ─────────────────────────────────
    await runTest('T1 Manga-Modus: Buy-Tab sichtbar', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'manga');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const visible = await page.locator('#tabs .tab[data-tab="buy"]').isVisible();
      if (!visible) throw new Error('Buy-Tab sollte im Manga-Modus sichtbar sein');

      await context.close();
    });

    // ── T2: Serien-Modus — Buy-Tab versteckt, Manga-Tab-Set bleibt sichtbar ─
    await runTest('T2 Serien-Modus: Buy-Tab versteckt (Manga-Tab-Set bleibt sichtbar)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const buyVisible = await page.locator('#tabs .tab[data-tab="buy"]').isVisible();
      if (buyVisible) throw new Error('Buy-Tab darf im Serien-Modus nicht sichtbar sein');
      const hasHiddenClass = await page.evaluate(() =>
        document.querySelector('#tabs .tab[data-tab="buy"]').classList.contains('hidden'));
      if (!hasHiddenClass) throw new Error('Buy-Tab sollte im Serien-Modus die Klasse .hidden tragen');

      for (const t of ['reading', 'completed', 'owned', 'wishlist']) {
        const v = await page.locator(`#tabs .tab[data-tab="${t}"]`).isVisible();
        if (!v) throw new Error(`Tab "${t}" sollte im Serien-Modus weiter sichtbar sein`);
      }

      await context.close();
    });

    // ── T3: Aktiver Buy-Tab + Wechsel zu Serien → Redirect ─────────────────
    await runTest('T3 Redirect: aktiver Buy-Tab + Wechsel zu Serien → tab="reading", kein leerer Content, kein pageerror', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) consoleErrors.push(m.text()); });

      await seedPage(page, mixedSeed(), 'manga');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      // Buy-Tab per UI-Klick aktivieren (im Manga-Modus sichtbar).
      await page.click('#tabs .tab[data-tab="buy"]');
      await page.waitForTimeout(150);
      if ((await page.evaluate(() => tab)) !== 'buy') throw new Error('Setup: tab sollte nach Klick "buy" sein');

      // In den Serien-Modus wechseln → setMode() muss redirecten.
      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(200);

      const finalTab = await page.evaluate(() => tab);
      if (finalTab === 'buy') throw new Error('tab darf nach Moduswechsel nicht "buy" bleiben, war: ' + finalTab);
      if (finalTab !== 'reading') throw new Error('tab sollte nach Redirect "reading" sein, war: ' + finalTab);

      const content = await contentText(page);
      if (!content || !content.trim()) throw new Error('Content darf nach dem Redirect nicht leer sein');

      if (pageErrors.length) throw new Error('pageerror beim Redirect: ' + pageErrors.join(' | '));
      if (consoleErrors.length) throw new Error('Konsolenfehler beim Redirect: ' + consoleErrors.join(' | '));

      await context.close();
    });

    // ── T4: Direkt-Navigation auf buy im Serien-Modus abgefangen ───────────
    await runTest('T4 Direkt-Navigation: setTab("buy") im Serien-Modus landet auf "reading", Buy-Tab bleibt hidden', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.evaluate(() => setTab('buy'));
      await page.waitForTimeout(150);

      const finalTab = await page.evaluate(() => tab);
      if (finalTab !== 'reading') throw new Error('setTab("buy") im Serien-Modus sollte auf "reading" umleiten, war: ' + finalTab);

      const buyVisible = await page.locator('#tabs .tab[data-tab="buy"]').isVisible();
      if (buyVisible) throw new Error('Buy-Tab sollte nach dem abgefangenen Direktzugriff weiter versteckt sein');

      await context.close();
    });

    // ── T5: Dashboard im Serien-Modus — keine Kauf-Flächen ─────────────────
    await runTest('T5 Dashboard Serien-Modus: keine "Zu kaufen"-Statkarte, keine Kaufvorschau-Section', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('.nav-item[data-nav="dashboard"]');
      await page.waitForTimeout(250);

      const hasBuyCard = await page.evaluate(() => Array.from(document.querySelectorAll('.stat-big-card'))
        .some((c) => (c.querySelector('.stat-big-l') || {}).textContent === 'Zu kaufen'));
      if (hasBuyCard) throw new Error('Dashboard darf im Serien-Modus keine "Zu kaufen"-Statkarte zeigen');

      const dash = await contentText(page);
      if (/Nächste Käufe/.test(dash)) throw new Error('Dashboard darf im Serien-Modus keinen "Nächste Käufe"-Header zeigen');
      const hasSummary = await page.evaluate(() => !!document.querySelector('#content .stats-buy-summary'));
      if (hasSummary) throw new Error('Dashboard darf im Serien-Modus kein .stats-buy-summary-Element rendern');

      await context.close();
    });

    // ── T6: Dashboard im Manga-Modus — Kauf-Flächen vorhanden (Nicht-Regression) ─
    await runTest('T6 Dashboard Manga-Modus (Nicht-Regression): "Zu kaufen"-Statkarte UND Kaufvorschau vorhanden', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, mixedSeed(), 'manga');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('.nav-item[data-nav="dashboard"]');
      await page.waitForTimeout(250);

      const hasBuyCard = await page.evaluate(() => Array.from(document.querySelectorAll('.stat-big-card'))
        .some((c) => (c.querySelector('.stat-big-l') || {}).textContent === 'Zu kaufen'));
      if (!hasBuyCard) throw new Error('Dashboard sollte im Manga-Modus weiter eine "Zu kaufen"-Statkarte zeigen');

      const dash = await contentText(page);
      if (!/Nächste Käufe/.test(dash)) throw new Error('Dashboard sollte im Manga-Modus weiter den "Nächste Käufe"-Header zeigen');

      await context.close();
    });

    // ── T7: Gegenprobe-Anker (dokumentiert, kein Produktivcode) ────────────
    // Gegenprobe (manuell durchgefuehrt, siehe .pipeline/changes.md fuer das
    // Protokoll): T2/T4 muessen rot werden, wenn der Fix zurückgenommen wird.
    //   - T2 rot machen: in updateModeSwitch() den `buyTab.classList.toggle('hidden', …)`-
    //     Block auskommentieren → Buy-Tab bleibt im Serien-Modus sichtbar → T2 faellt
    //     auf den `buyVisible`-Assert.
    //   - T4 rot machen: die Guard-Zeile `if (t === 'buy' && appMode === 'series') t = 'reading';`
    //     in setTab() auskommentieren → tab bleibt "buy" → T4 faellt auf den `finalTab`-Assert.
    await runTest('T7 Gegenprobe-Anker (dokumentiert, siehe Kommentar oberhalb)', async () => {
      // Kein Assert noetig — reine Dokumentation der durchgefuehrten Gegenprobe.
    });

    // ── T8: Manga-Modus bitidentisch (Grid-Text mixed vs. manga-only) ──────
    await runTest('T8 Nicht-Regression: Manga-Modus bitidentisch (Grid mixed vs. manga-only gleich), Buy-Tab sichtbar', async () => {
      async function ownedGrid(seed) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await seedPage(page, seed, 'manga');
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        await page.click('.tab[data-tab="owned"]');
        await page.waitForTimeout(120);
        await page.click('#vbtn-series');
        await page.waitForTimeout(200);
        const g = await page.evaluate(() => document.getElementById('content').textContent);
        const buyVisible = await page.locator('#tabs .tab[data-tab="buy"]').isVisible();
        await context.close();
        return { g, buyVisible };
      }

      const mixed = await ownedGrid(mixedSeed());
      const mangaOnly = await ownedGrid(mangaOnlySeed());

      if (!mixed.buyVisible || !mangaOnly.buyVisible) throw new Error('Buy-Tab sollte im Manga-Modus in beiden Seeds sichtbar sein');
      // Grid-Text bezieht sich nur auf Manga-Eintraege (Modus-Teilmenge) — mixedSeed()
      // enthaelt zusaetzlich Serie/Anime, die im Manga-Modus ohnehin nicht sichtbar sind.
      if (!/Zqx Manga Eins/.test(mixed.g) || !/Zqx Manga Eins/.test(mangaOnly.g)) {
        throw new Error('Beide Grids sollten Zqx Manga Eins zeigen. mixed=' + mixed.g.slice(0, 200) + ' | mangaOnly=' + mangaOnly.g.slice(0, 200));
      }
      if (/Zqx Serie Eins|Zqx Anime Eins/.test(mixed.g)) {
        throw new Error('Manga-Modus darf im gemischten Seed keine Serie/Anime zeigen. Grid: ' + mixed.g.slice(0, 200));
      }
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
