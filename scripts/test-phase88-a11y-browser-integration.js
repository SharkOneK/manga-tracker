#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase88-a11y-browser-integration.js — Phase 88
 * (HIG/Barrierefreiheit: Touch-Ziele >= 44 px, Tastaturbedienung von Tabs/Karten,
 * <main> + Skip-Link, Fokusring, Kontrast von --text-dim, Reduced Motion, Icons)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase72/73/74/75-browser-integration.js).
 *
 * Aufruf: node scripts/test-phase88-a11y-browser-integration.js
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


function seed() {
  return {
    schemaVersion: 3,
    m: [
      { id: 'a1', title: 'Zqx Manga Eins', pub: 'Panini', mediaType: 'manga', genres: ['Action', 'Fantasy'], bands: { 1: 'owned', 2: 'completed' }, status: 'owned', total: 5, ongoing: 'true', nextDate: '2026-09-01' },
      { id: 'a2', title: 'Zqx Manga Zwei', pub: 'Carlsen', mediaType: 'manga', genres: ['Drama'], bands: { 1: 'reading' }, status: 'reading', total: 3 },
    ],
  };
}

const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const browser = await chromium.launch();
  console.log('Phase 88 — HIG/Barrierefreiheit (Browser)\n');

  async function open(opts) {
    const context = await browser.newContext(Object.assign({}, MOBILE, opts || {}));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text())) errors.push(m.text()); });
    await seedPage(page, seed());
    await page.goto(base);
    await page.waitForTimeout(500);
    return { context, page, errors };
  }

  try {
    await runTest('Landmarks: <main id="main"> und Skip-Link als erstes Fokus-Ziel', async () => {
      const { context, page, errors } = await open();
      const r = await page.evaluate(() => ({
        main: !!document.querySelector('main#main'),
        skip: document.querySelector('a.skip-link')?.getAttribute('href'),
        toast: document.getElementById('toast').getAttribute('role'),
      }));
      if (!r.main) throw new Error('<main id="main"> fehlt');
      if (r.skip !== '#main') throw new Error('Skip-Link fehlt/zeigt nicht auf #main: ' + r.skip);
      if (r.toast !== 'status') throw new Error('#toast hat kein role="status"');
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => document.activeElement.className);
      if (!/skip-link/.test(first)) throw new Error('Erster Tab-Stopp ist nicht der Skip-Link: ' + first);
      await page.keyboard.press('Enter');
      const target = await page.evaluate(() => document.activeElement.id);
      if (target !== 'main') throw new Error('Skip-Link fokussiert #main nicht: ' + target);
      if (errors.length) throw new Error(errors.join(' | '));
      await context.close();
    });

    await runTest('Touch-Ziele: alle sichtbaren Bedienelemente >= 44 x 44 px (Handy)', async () => {
      const { context, page } = await open();
      const small = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('button,select,input:not([type=hidden]),[role="button"],[role="tab"],a[href]').forEach((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) return;
          if (el.closest('.skip-link') || el.classList.contains('skip-link')) return;
          if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
        return out;
      });
      if (small.length) throw new Error('Zu kleine Ziele: ' + small.join('; '));
      await context.close();
    });

    await runTest('Suchfeld bleibt auf dem Handy breit genug (eigene Zeile)', async () => {
      const { context, page } = await open();
      const w = await page.evaluate(() => document.getElementById('search-input').getBoundingClientRect().width);
      if (w < 200) throw new Error('Suchfeld nur ' + Math.round(w) + ' px breit');
      await context.close();
    });

    await runTest('Tabs: role=tab, aria-selected folgt dem Zustand, Enter/Leertaste schalten um', async () => {
      const { context, page, errors } = await open();
      await page.focus('#tabs .tab[data-tab="owned"]');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      let sel = await page.evaluate(() => Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.dataset.tab + ':' + t.getAttribute('aria-selected') + ':' + t.getAttribute('role') + ':' + t.getAttribute('tabindex')));
      if (!sel.includes('owned:true:tab:0') || !sel.includes('reading:false:tab:0')) throw new Error('Regal-Tabs: ' + sel.join(','));
      await page.focus('#mode-switch .tab[data-mode="series"]');
      await page.keyboard.press(' ');
      await page.waitForTimeout(150);
      const mode = await page.evaluate(() => Array.from(document.querySelectorAll('#mode-switch .tab')).map((t) => t.dataset.mode + ':' + t.getAttribute('aria-selected')));
      if (!mode.includes('series:true') || !mode.includes('manga:false')) throw new Error('Modus-Tabs: ' + mode.join(','));
      if (errors.length) throw new Error(errors.join(' | '));
      await context.close();
    });

    await runTest('Karten: per Tastatur fokussierbar, Enter oeffnet den Bearbeiten-Dialog', async () => {
      const { context, page } = await open();
      await page.click('#vbtn-series');
      await page.waitForTimeout(200);
      const card = await page.evaluate(() => { const c = document.querySelector('.manga-card'); return c ? c.getAttribute('role') + ':' + c.getAttribute('tabindex') : null; });
      if (card !== 'button:0') throw new Error('Manga-Karte: ' + card);
      await page.focus('.manga-card');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const open_ = await page.evaluate(() => getComputedStyle(document.getElementById('overlay')).display === 'flex');
      if (!open_) throw new Error('Enter auf der Karte oeffnet den Dialog nicht');
      await context.close();
    });

    await runTest('Sync-Knopf ist ein echter <button> mit Namen', async () => {
      const { context, page } = await open();
      const r = await page.evaluate(() => { const e = document.getElementById('sync-dot'); return e.tagName + ':' + e.getAttribute('aria-label'); });
      if (r !== 'BUTTON:Jetzt synchronisieren') throw new Error(r);
      await context.close();
    });

    await runTest('Sichtbarer Tastaturfokus auf Suchfeld (Fokusring trotz outline:none)', async () => {
      const { context, page } = await open({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
      await page.focus('#search-input');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { id: document.activeElement.id, style: s.outlineStyle, w: parseFloat(s.outlineWidth) }; });
      if (r.id !== 'search-input') throw new Error('Fokus nicht im Suchfeld: ' + r.id);
      if (r.style === 'none' || r.w < 2) throw new Error('Kein Fokusring: ' + JSON.stringify(r));
      await context.close();
    });

    await runTest('Kontrast: --text-dim >= 4.5:1 auf --bg, --surface und --surface-2', async () => {
      const { context, page } = await open();
      const ratios = await page.evaluate(() => {
        const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const rgb = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); return Array.from(cv.getImageData(0, 0, 1, 1).data).slice(0, 3); };
        const L = (a) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
        const cs = getComputedStyle(document.body);
        const fg = L(rgb(cs.getPropertyValue('--text-dim').trim()));
        const out = {};
        ['--bg', '--surface', '--surface-2'].forEach((n) => { const bg = L(rgb(cs.getPropertyValue(n).trim())); out[n] = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05); });
        return out;
      });
      Object.keys(ratios).forEach((k) => { if (ratios[k] < 4.5) throw new Error('--text-dim auf ' + k + ' nur ' + ratios[k].toFixed(2) + ':1'); });
      await context.close();
    });

    await runTest('prefers-reduced-motion: Uebergaenge werden praktisch abgeschaltet', async () => {
      const { context, page } = await open({ reducedMotion: 'reduce' });
      const d = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.botnav button, .nav-item')).transitionDuration));
      if (!(d <= 0.001)) throw new Error('transition-duration = ' + d);
      await context.close();
    });

    await runTest('Systemschema: color-scheme dark; kleinste Schrift >= 11 px in Navigation', async () => {
      const { context, page } = await open();
      const r = await page.evaluate(() => ({
        cs: getComputedStyle(document.documentElement).colorScheme,
        meta: document.querySelector('meta[name="color-scheme"]')?.content,
        sizes: ['.brand-sub', '.nav-group-label', '.botnav button'].map((q) => parseFloat(getComputedStyle(document.querySelector(q)).fontSize)),
      }));
      if (r.cs !== 'dark' || r.meta !== 'dark') throw new Error(JSON.stringify(r));
      if (r.sizes.some((s) => s < 11)) throw new Error('Schrift < 11 px: ' + r.sizes.join(','));
      await context.close();
    });

    await runTest('Icons: apple-touch-icon + PNG-Manifest-Icons existieren', async () => {
      const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
      if (!/<link rel="apple-touch-icon" href="\.\/apple-touch-icon\.png">/.test(html)) throw new Error('apple-touch-icon-Link fehlt');
      const man = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
      const png = man.icons.filter((i) => i.type === 'image/png');
      if (png.length < 2) throw new Error('weniger als 2 PNG-Icons im Manifest');
      ['apple-touch-icon.png'].concat(png.map((i) => i.src.replace('./', ''))).forEach((f) => {
        const b = fs.readFileSync(path.join(repoRoot, f));
        if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(f + ' ist kein PNG');
      });
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
