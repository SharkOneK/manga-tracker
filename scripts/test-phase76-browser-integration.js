#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase76-browser-integration.js — Phase 76 (Airing-Kalender)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase73/74/75/78-browser-integration.js).
 *
 * Grund fuer eine echte Browser-Suite (Phase-72/73-Lehre): DOM-freie Mirror-
 * Unit-Tests sehen die reale Kalender-Render-Logik in src/app.js NICHT.
 * Getestet wird gegen das ECHTE src/app.js + index.html, mit deterministischer
 * Uhr (page.clock) statt echtem Date.now() — sonst wuerde der Test je nach
 * Kalendertag beim Ausfuehren unterschiedlich (durch)fallen (Phase-76-Lehre,
 * siehe spec.md).
 *
 * Aufruf: node scripts/test-phase76-browser-integration.js
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

// ─── Mini static file server (wie in Phase 72/73/74/75/78) ────────────────
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

// Fixes "heute" fuer den gesamten Testlauf: 2026-01-10, 12:00 Uhr lokal.
// Mittags gewaehlt, damit keine Assertion versehentlich von einer Uhrzeit
// nahe der Tagesgrenze abhaengt.
const FIXED_TODAY = new Date(2026, 0, 10, 12, 0, 0).getTime();

async function seedPage(page, db) {
  await page.route('**/rpc/get_my_collection_ids', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.addInitScript((seed) => {
    localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', seed.session);
    localStorage.setItem('mtDE', JSON.stringify(seed.db));
  }, { session: freshSession(), db });
  // Deterministische Uhr: Date.now()/new Date() liefern im Browser ab jetzt
  // immer den fixen Zeitpunkt — genau die Referenz, gegen die airingCountdownDays
  // rechnet. Vor page.goto() installiert, damit sie auch beim Boot-Render greift.
  await page.clock.setFixedTime(FIXED_TODAY);
}

// Baut einen minimalen Anime-Eintrag (wie er nach Phase 73 in db.m landet).
function animeEntry(overrides) {
  return Object.assign({
    id: 'anime-fixture', title: 'Fixture Anime', pub: '', mediaType: 'anime',
    bands: {}, bandCovers: {}, owned: 0, status: 'owned', current: null,
    total: 24, ongoing: 'true', nextDate: null, cover: null, notes: '',
    genres: [], startedAt: null, finishedAt: null, at: 1700000000000, seasons: {},
    externalIds: { anilistId: 1 },
    anilistAiring: { episode: 1, airingAt: 1770000000 },
  }, overrides || {});
}

function mangaEntry(overrides) {
  return Object.assign({
    id: 'manga-fixture', title: 'Fixture Manga', pub: 'TestVerlag', mediaType: 'manga',
    bands: { 1: 'owned' }, bandCovers: {}, owned: 1, status: 'owned', current: null,
    total: 5, ongoing: 'true', nextDate: null, cover: null, notes: '',
    genres: [], startedAt: null, finishedAt: null, at: 1700000000000, seasons: {},
  }, overrides || {});
}

async function openKalenderInSeriesMode(page) {
  await page.click('[data-action="set-mode"][data-mode="series"]');
  await page.waitForTimeout(150);
  await page.click('[data-action="set-tab"][data-tab="kalender"]');
  await page.waitForTimeout(300);
}

async function kalRows(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#content .kal-row')).map((r) => ({
    title: r.querySelector('.kal-title') ? r.querySelector('.kal-title').textContent : null,
    sub: r.querySelector('.kal-sub') ? r.querySelector('.kal-sub').textContent : null,
    avail: r.classList.contains('kal-avail'),
  })));
}

(async function main() {
  console.log('\nPhase 76 — Browser-Integrationstests (Airing-Kalender, deterministische Uhr)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test: Serien-Modus zeigt Episode + Countdown korrekt (heute/morgen/+N Tage) ──
    await runTest('Serien-Modus: Kalender zeigt anilistAiring.episode + korrekten Countdown-Text', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      const seed = {
        schemaVersion: 3,
        m: [
          animeEntry({ id: 'a-today', title: 'Airing Heute', nextDate: '2026-01-10', anilistAiring: { episode: 12, airingAt: 1 } }),
          animeEntry({ id: 'a-tomorrow', title: 'Airing Morgen', nextDate: '2026-01-11', anilistAiring: { episode: 5, airingAt: 1 } }),
          animeEntry({ id: 'a-in7', title: 'Airing In Sieben Tagen', nextDate: '2026-01-17', anilistAiring: { episode: 3, airingAt: 1 } }),
        ],
      };
      await seedPage(page, seed);
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openKalenderInSeriesMode(page);

      if (pageErrors.length) throw new Error('pageerror im Kalender-Render: ' + pageErrors.join(' | '));

      const rows = await kalRows(page);
      const byTitle = (t) => rows.find((r) => r.title === t);

      const today = byTitle('Airing Heute');
      if (!today) throw new Error('Zeile "Airing Heute" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      if (today.sub !== 'Folge 12 · heute') throw new Error('Sub-Zeile "heute" falsch: ' + JSON.stringify(today));

      const tomorrow = byTitle('Airing Morgen');
      if (!tomorrow) throw new Error('Zeile "Airing Morgen" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      if (tomorrow.sub !== 'Folge 5 · morgen') throw new Error('Sub-Zeile "morgen" falsch: ' + JSON.stringify(tomorrow));

      const in7 = byTitle('Airing In Sieben Tagen');
      if (!in7) throw new Error('Zeile "Airing In Sieben Tagen" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      if (in7.sub !== 'Folge 3 · in 7 Tagen') throw new Error('Sub-Zeile "in 7 Tagen" falsch: ' + JSON.stringify(in7));

      await context.close();
    });

    // ── Test: Grenzfall "vergangen" — kein Countdown-Suffix, Datums-Box zeigt weiterhin "Jetzt" ──
    await runTest('Serien-Modus: vergangener Airing-Termin zeigt kein Countdown-Suffix (Box zeigt "Jetzt")', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      const seed = {
        schemaVersion: 3,
        m: [
          animeEntry({ id: 'a-past', title: 'Airing Vergangen', nextDate: '2026-01-09', anilistAiring: { episode: 8, airingAt: 1 } }),
        ],
      };
      await seedPage(page, seed);
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openKalenderInSeriesMode(page);

      const rows = await kalRows(page);
      const past = rows.find((r) => r.title === 'Airing Vergangen');
      if (!past) throw new Error('Zeile "Airing Vergangen" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      if (past.sub !== 'Folge 8') throw new Error('Vergangener Termin sollte OHNE Countdown-Suffix erscheinen, war: ' + JSON.stringify(past));
      if (!past.avail) throw new Error('Vergangener Termin sollte weiterhin die bestehende kal-avail/"Jetzt"-Hervorhebung tragen');

      await context.close();
    });

    // ── Test: anilistAiring.episode null (pausiert/beendet) → Fallback auf band-basierte Nummer ──
    await runTest('Serien-Modus: anilistAiring.episode null faellt auf die band-basierte Nummer zurueck, Countdown bleibt aus nextDate', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      const seed = {
        schemaVersion: 3,
        m: [
          animeEntry({
            id: 'a-fallback', title: 'Airing Fallback', nextDate: '2026-01-12',
            bands: { 1: 'owned' }, total: null,
            anilistAiring: { episode: null, airingAt: null },
          }),
        ],
      };
      await seedPage(page, seed);
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await openKalenderInSeriesMode(page);

      const rows = await kalRows(page);
      const fb = rows.find((r) => r.title === 'Airing Fallback');
      if (!fb) throw new Error('Zeile "Airing Fallback" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      // bands={1:'owned'}, total=null → mFirstMissingBand liefert 2 (erster fehlender Band).
      if (fb.sub !== 'Folge 2 · in 2 Tagen') throw new Error('Fallback-Episode/Countdown falsch: ' + JSON.stringify(fb));

      await context.close();
    });

    // ── Test: Manga-Modus rendert die Kalender-Sub-Zeile bitidentisch zur Baseline ──
    await runTest('Manga-Modus: Kalender-Sub-Zeile bleibt exakt "Band N · Verlag" (Nicht-Regression, byte-identisch)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      const seed = {
        schemaVersion: 3,
        m: [
          mangaEntry({ id: 'm-fixture', title: 'Fixture Manga Kalender', nextDate: '2026-01-13', bands: { 1: 'owned' }, total: 5, pub: 'TestVerlag' }),
          // Anime-Eintrag im gleichen Datensatz — darf im Manga-Modus nicht erscheinen.
          animeEntry({ id: 'a-noise', title: 'Sollte Im Manga-Modus Fehlen', nextDate: '2026-01-14' }),
        ],
      };
      await seedPage(page, seed);
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      // Default-Modus ist bereits "manga" — kein Moduswechsel noetig.
      await page.click('[data-action="set-tab"][data-tab="kalender"]');
      await page.waitForTimeout(300);

      // Die App seedet beim Boot zusaetzlich eine eingebaute Demo-Sammlung (unabhaengig
      // von den hier gesetzten Fixtures) — deshalb NICHT auf rows.length pruefen,
      // sondern gezielt auf unsere eigenen Titel filtern.
      const rows = await kalRows(page);
      const fixture = rows.find((r) => r.title === 'Fixture Manga Kalender');
      if (!fixture) throw new Error('Zeile "Fixture Manga Kalender" fehlt im Kalender. Zeilen: ' + JSON.stringify(rows));
      // bands={1:'owned'}, total=5 → mFirstMissingBand liefert 2.
      if (fixture.sub !== 'Band 2 · TestVerlag') throw new Error('Manga-Sub-Zeile weicht von der Baseline "Band N · Verlag" ab: ' + JSON.stringify(fixture));
      if (rows.some((r) => r.title === 'Sollte Im Manga-Modus Fehlen')) {
        throw new Error('Anime-Eintrag ist im Manga-Modus sichtbar — Modusfilterung verletzt (mediaModeItems())');
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
