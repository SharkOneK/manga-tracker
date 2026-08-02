#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase77-browser-integration.js — Phase 77 (Streaming-Anbieter, TMDB watch/providers DE)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase73/74/75/76/78-browser-integration.js).
 * Zweck: das Feature gegen das ECHTE src/app.js + index.html pruefen — insbesondere
 * dass ein boesartiger provider_name in der Streaming-Zeile des TMDB-Overlays NIE
 * als Markup interpretiert wird, sondern ausschliesslich als escapter Text (E-Sweep,
 * spec.md Phase 77 "Sicherheit / Escaping").
 *
 * data/tmdb-series-catalog.json wird per page.route() gestubbt (der Katalog selbst
 * ist server-seitig vorgeneriert) — der Client spricht nie direkt mit TMDB.
 *
 * Aufruf: node scripts/test-phase77-browser-integration.js
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

// ─── Mini static file server (wie in Phase 72–76/78) ──────────────────────
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

// Vorbestehendes, von Phase 77 unabhaengiges Browser-Rauschen (existiert schon vor
// dieser Phase, index.html:5) — siehe scripts/test-phase75-browser-integration.js.
function isKnownCspNoise(text) {
  return /frame-ancestors' is ignored when delivered via a <meta> element/.test(text);
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
    streamingProviders: [],
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
  console.log('\nPhase 77 — Browser-Integrationstests (Streaming-Anbieter, echtes src/app.js, TMDB-Katalog gestubbt)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test: normale Provider erscheinen kommagetrennt als "Streaming: ..."-Zeile ──
    await runTest('Vorhandene DE-flatrate-Provider: Streaming-Zeile zeigt "Streaming: Netflix, Crunchyroll, Disney Plus" kommagetrennt', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord({ streamingProviders: ['Netflix', 'Crunchyroll', 'Disney Plus'] })]),
        });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openTmdbSearchAndQuery(page, 'Game of Thrones');

      if (pageErrors.length) throw new Error('pageerror im TMDB-Overlay: ' + pageErrors.join(' | '));

      const hitText = await page.evaluate(() => document.getElementById('tmdb-results').textContent);
      if (!hitText.includes('Streaming: Netflix, Crunchyroll, Disney Plus')) {
        throw new Error('Erwartete kommagetrennte Streaming-Zeile fehlt. Text: ' + hitText.slice(0, 400));
      }

      await context.close();
    });

    // ── Test: streamingProviders wird NICHT in db.m persistiert (tmdbRecordToEntry unverändert) ──
    await runTest('Übernahme in die Sammlung: streamingProviders landet NICHT im db.m-Eintrag (nur Browse-Overlay, wie overview)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('dialog', (d) => d.accept());

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord({ tmdbId: 7070, title: 'Zqx Streaming Persistenz Serie', streamingProviders: ['Netflix', 'Crunchyroll'] })]),
        });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openTmdbSearchAndQuery(page, 'Zqx Streaming Persistenz Serie');
      await page.click('[data-action="tmdb-import"]');
      await page.waitForTimeout(400);

      const entry = await page.evaluate(() => {
        const e = db.m.find((m) => m.mediaType === 'series' && m.title === 'Zqx Streaming Persistenz Serie');
        return e ? JSON.parse(JSON.stringify(e)) : null;
      });
      if (!entry) throw new Error('Kein Serien-Eintrag in db.m nach der Übernahme gefunden');
      if ('streamingProviders' in entry) throw new Error('streamingProviders wurde in db.m persistiert — muss volatil bleiben, nur im Browse-Overlay: ' + JSON.stringify(entry));

      const persisted = await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('mtDE'));
        const e = raw.m.find((m) => m.title === 'Zqx Streaming Persistenz Serie');
        return e ? Object.keys(e) : null;
      });
      if (!persisted) throw new Error('Eintrag nicht im localStorage gefunden');
      if (persisted.includes('streamingProviders')) throw new Error('streamingProviders im localStorage-Roundtrip gefunden, Keys: ' + JSON.stringify(persisted));

      await context.close();
    });

    // ── Test: Serie ohne Streaming-Daten → keine Streaming-Zeile (kein leeres "Streaming: ") ──
    await runTest('Serie ohne Streaming-Daten (streamingProviders: []): keine Streaming-Zeile im Overlay', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord({ streamingProviders: [] })]),
        });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openTmdbSearchAndQuery(page, 'Game of Thrones');

      const hitText = await page.evaluate(() => document.getElementById('tmdb-results').textContent);
      if (hitText.includes('Streaming:')) {
        throw new Error('Streaming-Zeile sollte bei leerem streamingProviders komplett fehlen (kein leeres "Streaming: "). Text: ' + hitText.slice(0, 400));
      }

      await context.close();
    });

    // ── Test: Katalog-Item ganz ohne streamingProviders-Feld (Array.isArray-Guard) ──
    await runTest('Katalog-Item ohne streamingProviders-Feld (alte Daten): Array.isArray-Guard greift, keine Streaming-Zeile, kein pageerror', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      const legacyItem = tmdbRecord();
      delete legacyItem.streamingProviders;

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: tmdbCatalogBody([legacyItem]) });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openTmdbSearchAndQuery(page, 'Game of Thrones');

      if (pageErrors.length) throw new Error('pageerror bei fehlendem streamingProviders-Feld: ' + pageErrors.join(' | '));
      const hitText = await page.evaluate(() => document.getElementById('tmdb-results').textContent);
      if (hitText.includes('Streaming:')) throw new Error('Streaming-Zeile sollte bei fehlendem Feld nicht erscheinen. Text: ' + hitText.slice(0, 400));

      await context.close();
    });

    // ── Test: XSS — boesartiger provider_name erscheint NIE als Markup, nur als Text ──
    await runTest('XSS: boesartiger provider_name ("<img src=x onerror=...>") wird ueber escapeHtml() ausschliesslich als Text gerendert, nie als Element', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleMessages = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => consoleMessages.push(m.text()));

      const evilProvider = '<img src=x onerror="window.__xssProvider=1">';

      await seedPage(page, { schemaVersion: 3, m: [] });
      await routeTmdbCatalog(page, async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: tmdbCatalogBody([tmdbRecord({ tmdbId: 5050, streamingProviders: [evilProvider, 'Netflix'] })]),
        });
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      // Ohne Suchbegriff öffnen (Titel bleibt unverändert 'Game of Thrones' — Filter würde sonst nicht greifen).
      await openTmdbSearchAndQuery(page, '');

      const state = await page.evaluate(() => ({
        xssFired: window.__xssProvider,
        text: document.getElementById('tmdb-results').textContent,
        injectedImgsInStreamingContext: Array.from(document.querySelectorAll('#tmdb-results img')).filter((img) => img.getAttribute('src') === 'x').length,
      }));

      if (state.xssFired) throw new Error('XSS aus provider_name wurde ausgefuehrt (onerror feuerte) — escapeHtml() greift nicht');
      if (state.injectedImgsInStreamingContext > 0) throw new Error('Injiziertes <img src="x"> im Ergebnis-DOM gefunden — provider_name wurde als Markup interpretiert');
      if (!state.text.includes('Streaming: <img src=x onerror="window.__xssProvider=1">, Netflix')) {
        throw new Error('Streaming-Zeile sollte den boesartigen Namen als sichtbaren TEXT (unescaped im textContent, escaped im HTML) plus "Netflix" zeigen. Text: ' + state.text.slice(0, 500));
      }

      const cspViolations = consoleMessages
        .filter((t) => /Content Security Policy|Refused to/i.test(t))
        .filter((t) => !isKnownCspNoise(t));
      if (cspViolations.length) throw new Error('CSP-Violations in der Konsole (deutet auf injiziertes Inline-Element hin): ' + cspViolations.join(' | '));
      if (pageErrors.length) throw new Error('pageerror im XSS-Test: ' + pageErrors.join(' | '));

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
