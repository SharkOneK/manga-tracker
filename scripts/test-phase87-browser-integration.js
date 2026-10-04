#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase87-browser-integration.js — Phase 87
 * (Add/Edit-Modal an den Anzeige-Modus koppeln: Medientyp-Default/Optionen,
 * AniList-Button-Sichtbarkeit, Modal-Titel/Empty-State/Toast ueber MODE_TERMS)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase72/73/74/75-browser-integration.js).
 *
 * Aufruf: node scripts/test-phase87-browser-integration.js
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

function emptyDb() {
  return { schemaVersion: 3, m: [] };
}

// Liest hidden/disabled/value des #f-mediatype-Selects aus.
async function readMediaTypeSelect(page) {
  return page.evaluate(() => {
    const sel = document.getElementById('f-mediatype');
    return {
      value: sel.value,
      options: Array.from(sel.options).map((o) => ({ value: o.value, hidden: o.hidden, disabled: o.disabled })),
    };
  });
}

(async function main() {
  console.log('\nPhase 87 — Browser-Integrationstests (Add/Edit-Modal an appMode gekoppelt)\n');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  try {
    // ── Test 1: Manga-Modus + openAdd() — Default + Options ────────────────
    await runTest('Manga-Modus openAdd(): Wert "manga", series/anime hidden+disabled, manga waehlbar', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      const state = await readMediaTypeSelect(page);
      if (state.value !== 'manga') throw new Error('Default im Manga-Modus sollte "manga" sein, war: ' + state.value);
      const byValue = Object.fromEntries(state.options.map((o) => [o.value, o]));
      if (byValue.manga.hidden || byValue.manga.disabled) throw new Error('"manga"-Option darf im Manga-Modus nicht hidden/disabled sein: ' + JSON.stringify(byValue.manga));
      if (!byValue.series.hidden || !byValue.series.disabled) throw new Error('"series"-Option muss im Manga-Modus hidden+disabled sein: ' + JSON.stringify(byValue.series));
      if (!byValue.anime.hidden || !byValue.anime.disabled) throw new Error('"anime"-Option muss im Manga-Modus hidden+disabled sein: ' + JSON.stringify(byValue.anime));

      await context.close();
    });

    // ── Test 2: Serien-Modus + openAdd() — Default + Options ───────────────
    await runTest('Serien-Modus openAdd(): Wert "series", series/anime waehlbar, manga hidden+disabled', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      const state = await readMediaTypeSelect(page);
      if (state.value !== 'series') throw new Error('Default im Serien-Modus sollte "series" sein, war: ' + state.value);
      const byValue = Object.fromEntries(state.options.map((o) => [o.value, o]));
      if (byValue.series.hidden || byValue.series.disabled) throw new Error('"series"-Option darf im Serien-Modus nicht hidden/disabled sein: ' + JSON.stringify(byValue.series));
      if (byValue.anime.hidden || byValue.anime.disabled) throw new Error('"anime"-Option darf im Serien-Modus nicht hidden/disabled sein: ' + JSON.stringify(byValue.anime));
      if (!byValue.manga.hidden || !byValue.manga.disabled) throw new Error('"manga"-Option muss im Serien-Modus hidden+disabled sein: ' + JSON.stringify(byValue.manga));

      await context.close();
    });

    // ── Test 3: Kernbugfix — im Serien-Modus angelegter Eintrag ist sichtbar ──
    await runTest('Serien-Modus: ohne Medientyp-Aenderung angelegter Eintrag hat mediaType "series" und ist sichtbar (vorher: unsichtbar)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb(), 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.fill('#f-title', 'Zqx Serie Ohne Typwechsel');
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(300);

      const saved = await page.evaluate(() => db.m.find((m) => m.title === 'Zqx Serie Ohne Typwechsel'));
      if (!saved) throw new Error('Eintrag wurde nicht in db.m gefunden');
      if (saved.mediaType !== 'series') throw new Error('mediaType sollte "series" sein, war: ' + saved.mediaType);

      // Ein Eintrag ohne Baende landet unter Status "owned" (mSeriesStatus), nicht
      // "reading" — daher den "owned"-Tab pruefen (Boot-Seeds aus src/app.js sind
      // mediaType "manga" und im Serien-Modus ohnehin ausgefiltert, s. inActiveMode()).
      await page.click('.tab[data-tab="owned"]');
      await page.waitForTimeout(120);
      await page.click('#vbtn-series');
      await page.waitForTimeout(150);
      const gridText = await page.evaluate(() => document.getElementById('content').textContent);
      if (!/Zqx Serie Ohne Typwechsel/.test(gridText)) throw new Error('Eintrag ist in der Bibliothek des Serien-Modus nicht sichtbar');

      await context.close();
    });

    // ── Test 4: Nicht-Regression — Manga-Modus-Eintrag bleibt "manga" ───────
    await runTest('Manga-Modus: ohne Medientyp-Aenderung angelegter Eintrag hat weiter mediaType "manga" (Nicht-Regression)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.fill('#f-title', 'Zqx Manga Ohne Typwechsel');
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(300);

      const saved = await page.evaluate(() => db.m.find((m) => m.title === 'Zqx Manga Ohne Typwechsel'));
      if (!saved) throw new Error('Eintrag wurde nicht in db.m gefunden');
      if (saved.mediaType !== 'manga') throw new Error('mediaType sollte "manga" sein, war: ' + saved.mediaType);

      await context.close();
    });

    // ── Test 5: Edge Case 2 — Eintrag mit modusfremdem mediaType bearbeiten ──
    await runTest('openEdit() im Manga-Modus mit einem "series"-Eintrag (Fremddaten): Option bleibt sichtbar+waehlbar, Wert bleibt nach Speichern unveraendert', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, {
        schemaVersion: 3,
        m: [{ id: 'zx1', title: 'Zqx Fremdserie', pub: '', mediaType: 'series', bands: {}, status: 'owned', total: null, ongoing: 'true', nextDate: '' }],
      }); // Default-Modus: manga — der Eintrag passt NICHT zum aktuellen Modus.
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.evaluate(() => openEdit('zx1'));
      await page.waitForTimeout(150);
      const state = await readMediaTypeSelect(page);
      if (state.value !== 'series') throw new Error('select.value sollte der Original-mediaType "series" bleiben (fail-open), war: ' + state.value);
      const byValue = Object.fromEntries(state.options.map((o) => [o.value, o]));
      if (byValue.series.hidden || byValue.series.disabled) throw new Error('"series"-Option muss trotz Modus-Mismatch sichtbar+waehlbar bleiben: ' + JSON.stringify(byValue.series));

      // Speichern ohne Medientyp-Aenderung darf den Typ NICHT stillschweigend umschreiben.
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(300);
      const saved = await page.evaluate(() => db.m.find((m) => m.id === 'zx1'));
      if (saved.mediaType !== 'series') throw new Error('mediaType darf beim Speichern nicht umgeschrieben werden, war: ' + saved.mediaType);

      await context.close();
    });

    // ── Test 6: Modal-Titel je Modus (Add + Edit) ───────────────────────────
    await runTest('Modal-Titel: Manga-Modus "Manga hinzufuegen"/"Manga bearbeiten", Serien-Modus "Serie/Anime hinzufuegen"/"Serie/Anime bearbeiten"', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, {
        schemaVersion: 3,
        m: [{ id: 'zx2', title: 'Zqx Titeltest', pub: '', mediaType: 'manga', bands: {}, status: 'owned', total: null, ongoing: 'true', nextDate: '' }],
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      let title = await page.evaluate(() => document.getElementById('modal-title').textContent);
      if (title !== 'Manga hinzufügen') throw new Error('Manga-Modus Add-Titel falsch: ' + JSON.stringify(title));
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.evaluate(() => openEdit('zx2'));
      await page.waitForTimeout(150);
      title = await page.evaluate(() => document.getElementById('modal-title').textContent);
      if (title !== 'Manga bearbeiten') throw new Error('Manga-Modus Edit-Titel falsch: ' + JSON.stringify(title));
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('#btn-add');
      await page.waitForTimeout(150);
      title = await page.evaluate(() => document.getElementById('modal-title').textContent);
      if (title !== 'Serie/Anime hinzufügen') throw new Error('Serien-Modus Add-Titel falsch: ' + JSON.stringify(title));
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.evaluate(() => openEdit('zx2'));
      await page.waitForTimeout(150);
      title = await page.evaluate(() => document.getElementById('modal-title').textContent);
      if (title !== 'Serie/Anime bearbeiten') throw new Error('Serien-Modus Edit-Titel falsch: ' + JSON.stringify(title));

      await context.close();
    });

    // ── Test 7: Empty-State (reading) je Modus ──────────────────────────────
    await runTest('Empty-State "reading": Manga-Modus wortgleich zu heute, Serien-Modus mit Serien-Begriffen', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      // Boot-Seeds (src/app.js upsertManga(), mediaType "manga") fuellen den
      // Reading-Tab sonst mit Default-Daten — fuer den Empty-State-Text hier
      // explizit auf eine leere Sammlung zuruecksetzen (reine DOM-Pruefung,
      // kein Produktivcode-Pfad wird dabei umgangen). Der Phase-87-Text steckt
      // in renderSeriesGrid() (Serienansicht ⊞) — viewMode startet hier als
      // "volumes" (Baendenansicht ☰, eigener Empty-State), daher explizit auf
      // die Serienansicht wechseln.
      await page.evaluate(() => { db.m = []; render(); });
      await page.click('#vbtn-series');
      await page.waitForTimeout(150);

      let html = await page.evaluate(() => document.getElementById('content').innerHTML);
      if (!/Füge Mangas hinzu, die du gerade liest\./.test(html)) throw new Error('Manga-Empty-State-Hinweistext fehlt/falsch');
      if (!/＋ Manga hinzufügen/.test(html)) throw new Error('Manga-Empty-State-Button-Label fehlt/falsch');

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(200);
      html = await page.evaluate(() => document.getElementById('content').innerHTML);
      if (!/Füge Serien oder Animes hinzu, die du gerade schaust\./.test(html)) throw new Error('Serien-Empty-State-Hinweistext fehlt/falsch');
      if (!/＋ Serie\/Anime hinzufügen/.test(html)) throw new Error('Serien-Empty-State-Button-Label fehlt/falsch');

      await context.close();
    });

    // ── Test 8: Speichern-Toast beim Bearbeiten je Modus ────────────────────
    await runTest('Toast beim Bearbeiten: "Manga aktualisiert" im Manga-Modus, "Serie/Anime aktualisiert" im Serien-Modus', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, {
        schemaVersion: 3,
        m: [{ id: 'zx3', title: 'Zqx Toasttest', pub: '', mediaType: 'manga', bands: {}, status: 'owned', total: null, ongoing: 'true', nextDate: '' }],
      });
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.evaluate(() => openEdit('zx3'));
      await page.waitForTimeout(150);
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(150);
      let toastText = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
      if (!/✅ Manga aktualisiert/.test(toastText)) throw new Error('Manga-Modus-Toast falsch: ' + JSON.stringify(toastText));

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.evaluate(() => openEdit('zx3'));
      await page.waitForTimeout(150);
      await page.click('[data-action="do-save"]');
      await page.waitForTimeout(150);
      toastText = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
      if (!/✅ Serie\/Anime aktualisiert/.test(toastText)) throw new Error('Serien-Modus-Toast falsch: ' + JSON.stringify(toastText));

      await context.close();
    });

    // ── Test 9: AniList-/TMDB-Button-Sichtbarkeit sind synchron ─────────────
    await runTest('#btn-anilist-search ist genau dann sichtbar wie #btn-tmdb-search (Hinzufuegen + Serien-Modus; sonst beide versteckt)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, emptyDb());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const visible = async () => ({
        anilist: await page.locator('[data-action="open-anilist-search"]').isVisible(),
        tmdb: await page.locator('[data-action="open-tmdb-search"]').isVisible(),
      });

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      let v = await visible();
      if (v.anilist !== false || v.tmdb !== false) throw new Error('Im Manga-Modus muessen beide Buttons versteckt sein: ' + JSON.stringify(v));
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('#btn-add');
      await page.waitForTimeout(150);
      v = await visible();
      if (v.anilist !== true || v.tmdb !== true) throw new Error('Im Serien-Modus + Hinzufuegen-Modal muessen beide Buttons sichtbar sein: ' + JSON.stringify(v));

      await context.close();
    });

    // ── Test 10: Idempotenz — mehrfaches Oeffnen hinterlaesst keinen Reststatus ──
    await runTest('Add → schliessen → Edit → schliessen → Add: syncMediaTypeOptions() setzt hidden/disabled jedes Mal vollstaendig neu', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await seedPage(page, {
        schemaVersion: 3,
        m: [{ id: 'zx4', title: 'Zqx Idempotenztest', pub: '', mediaType: 'series', bands: {}, status: 'owned', total: null, ongoing: 'true', nextDate: '' }],
      }, 'series');
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.evaluate(() => openEdit('zx4'));
      await page.waitForTimeout(150);
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      const state = await readMediaTypeSelect(page);
      if (state.value !== 'series') throw new Error('Nach mehrfachem Oeffnen: Default im Serien-Modus sollte wieder "series" sein, war: ' + state.value);
      const byValue = Object.fromEntries(state.options.map((o) => [o.value, o]));
      if (!byValue.manga.hidden || !byValue.manga.disabled) throw new Error('"manga" muss nach erneutem Add() wieder hidden+disabled sein (kein Reststatus): ' + JSON.stringify(byValue.manga));

      await context.close();
    });

    // ── Test 11: Keine Konsolen-/Seitenfehler beim Oeffnen/Schliessen in beiden Modi ──
    await runTest('Keine Konsolen-/Page-Errors beim Oeffnen/Schliessen des Modals in Manga- UND Serien-Modus', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) consoleErrors.push(m.text()); });

      await seedPage(page, emptyDb());
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      await page.click('#mode-switch [data-mode="series"]');
      await page.waitForTimeout(150);
      await page.click('#btn-add');
      await page.waitForTimeout(150);
      await page.click('[data-action="close-modal"]');
      await page.waitForTimeout(150);

      if (pageErrors.length) throw new Error('pageerror beim Oeffnen/Schliessen: ' + pageErrors.join(' | '));
      if (consoleErrors.length) throw new Error('Konsolenfehler beim Oeffnen/Schliessen: ' + consoleErrors.join(' | '));

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
