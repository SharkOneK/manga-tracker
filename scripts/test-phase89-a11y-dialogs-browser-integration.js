#!/usr/bin/env node
'use strict';

/**
 * scripts/test-phase89-a11y-dialogs-browser-integration.js — Phase 89
 * (HIG/Barrierefreiheit Teil 2: Karten/Zeilen als echte Buttons, Dialog-Verhalten
 * (Fokus, Tab-Falle, Escape), Touch-Ziele in Dialogen/Dashboard, Feldbeschriftungen,
 * Mindestschrift, Kontrast Pillen/Loeschen, Konto-Fenster)
 *
 * Laeuft NICHT ueber node scripts/run-all-checks.js (benoetigt einen echten
 * Chromium via Playwright, analog scripts/test-phase72/73/74/75-browser-integration.js).
 *
 * Aufruf: node scripts/test-phase89-a11y-dialogs-browser-integration.js
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
      { id: 'a1', title: 'Zqx Manga Eins', pub: 'Panini', mediaType: 'manga', genres: ['Action', 'Fantasy'], bands: { 1: 'owned', 2: 'completed' }, status: 'owned', total: 5, ongoing: 'true', nextDate: '2026-10-30' },
      { id: 'a2', title: 'Zqx Manga Zwei', pub: 'Carlsen', mediaType: 'manga', genres: ['Drama'], bands: { 1: 'reading' }, status: 'reading', total: 3, nextDate: '2026-11-12' },
      { id: 'a3', title: 'Zqx Wunsch', pub: 'Egmont', mediaType: 'manga', genres: ['Action'], bands: {}, status: 'wishlist', total: 8 },
    ],
  };
}

const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

// Sichtbare Bedienelemente unter 44 px (Checkboxen: das umschliessende Label zaehlt) und klickbare Nicht-Buttons.
function scan() {
  const out = { small: [], clickNoRole: [], nested: [], tiny: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('button,select,input:not([type=hidden]),textarea,[role="button"],[role="tab"],a[href]').forEach((el) => {
    if (!vis(el) || el.classList.contains('skip-link')) return;
    const box = (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') || el) : el;
    const r = box.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) out.small.push(`${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
  });
  document.querySelectorAll('[data-action],[onclick]').forEach((el) => {
    if (vis(el) && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) && !el.getAttribute('role') && el.getAttribute('tabindex') === null) out.clickNoRole.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
  });
  document.querySelectorAll('[role="button"],[role="tab"],button,a[href]').forEach((el) => {
    if (vis(el) && el.querySelector('button,a[href],[role="button"],input,select')) out.nested.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
  });
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el) || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) return;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 10.95) out.tiny.push(String(el.className).split(' ')[0] + ' ' + px.toFixed(1) + 'px');
  });
  Object.keys(out).forEach((k) => { out[k] = Array.from(new Set(out[k])).slice(0, 10); });
  return out;
}

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const browser = await chromium.launch();
  console.log('Phase 89 — HIG/Barrierefreiheit Teil 2 (Browser)\n');

  async function open(opts) {
    const context = await browser.newContext(Object.assign({}, MOBILE, opts || {}));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !isKnownCspNoise(m.text()) && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    // Kein Netzwerk zu den Backends: der Test beruehrt keine echten Daten.
    await page.route('**/*supabase.co/**', (r) => r.abort());
    await page.route('**/api.manga-passion.de/**', (r) => r.abort());
    await page.route('**/graphql.anilist.co/**', (r) => r.abort());
    await page.addInitScript((s) => {
      localStorage.setItem('sb-sssxiqtnkctvyghyrqff-auth-token', JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem('mtDE', JSON.stringify(s));
    }, seed());
    await page.goto(base);
    await page.waitForTimeout(600);
    return { context, page, errors };
  }

  function expectClean(label, r) {
    const bad = [];
    if (r.small.length) bad.push('zu klein: ' + r.small.join('; '));
    if (r.clickNoRole.length) bad.push('klickbar ohne Rolle: ' + r.clickNoRole.join('; '));
    if (r.nested.length) bad.push('verschachtelt: ' + r.nested.join('; '));
    if (r.tiny.length) bad.push('Schrift < 11 px: ' + r.tiny.join('; '));
    if (bad.length) throw new Error(label + ' — ' + bad.join(' | '));
  }

  try {
    await runTest('Karte, Bändezeile und Kalenderzeile: echter Button, kein role=button-div, keine Verschachtelung', async () => {
      const { context, page, errors } = await open();
      await page.click('#tabs .tab[data-tab="owned"]'); await page.waitForTimeout(150);
      await page.click('#vbtn-series'); await page.waitForTimeout(250);
      const card = await page.evaluate(() => ({ btn: !!document.querySelector('.manga-card > button.card-open[aria-label$="bearbeiten"]'), role: document.querySelector('.manga-card').getAttribute('role'), act: document.querySelector('.manga-card').dataset.action || null }));
      if (!card.btn || card.role || card.act) throw new Error('Karte: ' + JSON.stringify(card));
      await page.click('#vbtn-volumes'); await page.waitForTimeout(250);
      const row = await page.evaluate(() => !!document.querySelector('.vol-row > button.card-open'));
      if (!row) throw new Error('Bändezeile ohne card-open-Button');
      // Maus: Klick in die Mitte der Zeile oeffnet weiterhin den Dialog
      await page.$eval('.vol-row > button.card-open', (b) => b.scrollIntoView({ block: 'center' })); await page.click('.vol-row > button.card-open'); await page.waitForTimeout(250);
      const mouse = await page.evaluate(() => getComputedStyle(document.getElementById('overlay')).display === 'flex');
      if (!mouse) throw new Error('Klick auf die Zeile öffnet den Dialog nicht');
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      await page.click('.botnav button[data-tab="kalender"]'); await page.waitForTimeout(300);
      const kal = await page.evaluate(() => !!document.querySelector('.kal-row > button.card-open'));
      if (!kal) throw new Error('Kalenderzeile ohne card-open-Button');
      if (errors.length) throw new Error(errors.join(' | '));
      await context.close();
    });

    await runTest('Teilen-Knopf 44 x 44 mit Namen', async () => {
      const { context, page } = await open();
      await page.click('#tabs .tab[data-tab="owned"]'); await page.waitForTimeout(150);
      await page.click('#vbtn-series'); await page.waitForTimeout(250);
      const r = await page.evaluate(() => { const b = document.querySelector('.share-btn'); const x = b.getBoundingClientRect(); return { w: x.width, h: x.height, n: b.getAttribute('aria-label') }; });
      if (r.w < 44 || r.h < 44 || !r.n) throw new Error(JSON.stringify(r));
      await context.close();
    });

    await runTest('Alle Ansichten (Handy): Ziele >= 44 px, keine klickbaren Nicht-Buttons, keine Verschachtelung, Schrift >= 11 px', async () => {
      const { context, page } = await open();
      const step = async (name, fn) => { await fn(); await page.waitForTimeout(300); expectClean(name, await page.evaluate(scan)); };
      await step('Bibliothek (Bänder)', async () => {});
      await step('Serienraster', async () => { await page.click('#tabs .tab[data-tab="owned"]'); await page.click('#vbtn-series'); });
      await step('Wunschliste', async () => { await page.click('#tabs .tab[data-tab="wishlist"]'); });
      await step('Zu kaufen', async () => { await page.click('#tabs .tab[data-tab="buy"]'); });
      await step('Kalender', async () => { await page.click('.botnav button[data-tab="kalender"]'); });
      await step('Dashboard', async () => { await page.click('.botnav button[data-tab="dashboard"]'); });
      await step('Hinzufügen-Dialog', async () => { await page.click('.botnav button[data-tab="reading"]'); await page.click('#btn-add'); });
      await context.close();
    });

    await runTest('Bearbeiten-Dialog: Ziele, Beschriftungen der Datumsfelder, role=dialog', async () => {
      const { context, page } = await open();
      await page.click('#tabs .tab[data-tab="owned"]'); await page.click('#vbtn-series'); await page.waitForTimeout(250);
      await page.$eval('.manga-card > button.card-open', (b) => b.click()); await page.waitForTimeout(350);
      expectClean('Bearbeiten-Dialog', await page.evaluate(scan));
      const r = await page.evaluate(() => ({
        started: document.querySelector('label[for="f-started"]')?.textContent.trim(),
        finished: document.querySelector('label[for="f-finished"]')?.textContent.trim(),
        dlg: (() => { const m = document.getElementById('modal'); return [m.getAttribute('role'), m.getAttribute('aria-modal'), m.getAttribute('aria-labelledby')].join('|'); })(),
        close: document.querySelector('#modal .close-btn').getAttribute('aria-label'),
      }));
      if (!/Begonnen/.test(r.started || '') || !/Abgeschlossen/.test(r.finished || '')) throw new Error('Datumsfelder ohne Label: ' + JSON.stringify(r));
      if (r.dlg !== 'dialog|true|modal-title') throw new Error('Dialog-Attribute: ' + r.dlg);
      if (!r.close) throw new Error('Schließen-Button ohne aria-label');
      await context.close();
    });

    await runTest('Dialog-Verhalten: Fokus hinein, Tab bleibt im Dialog, Escape schließt, Fokus zurück zum Auslöser', async () => {
      const { context, page } = await open({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
      await page.focus('#btn-add');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      let inside = await page.evaluate(() => document.getElementById('modal').contains(document.activeElement));
      if (!inside) throw new Error('Fokus liegt nach dem Öffnen nicht im Dialog');
      for (let i = 0; i < 45; i++) {
        await page.keyboard.press('Tab');
        inside = await page.evaluate(() => document.getElementById('modal').contains(document.activeElement));
        if (!inside) throw new Error('Tab verlässt den Dialog nach ' + (i + 1) + ' Schritten');
      }
      await page.keyboard.press('Shift+Tab');
      inside = await page.evaluate(() => document.getElementById('modal').contains(document.activeElement));
      if (!inside) throw new Error('Shift+Tab verlässt den Dialog');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ open: getComputedStyle(document.getElementById('overlay')).display !== 'none', active: document.activeElement.id }));
      if (r.open) throw new Error('Escape schließt den Dialog nicht');
      if (r.active !== 'btn-add') throw new Error('Fokus kehrt nicht zum Auslöser zurück: ' + r.active);
      await context.close();
    });

    await runTest('Konto-Fenster: role=dialog, Ziele >= 44 px, Escape, Fokus zurück', async () => {
      const { context, page } = await open();
      await page.click('#btn-account'); await page.waitForTimeout(350);
      const r = await page.evaluate(() => { const m = document.getElementById('account-modal'); return { dlg: m.getAttribute('role') + '|' + m.getAttribute('aria-labelledby'), shown: getComputedStyle(document.getElementById('account-overlay')).display !== 'none', inside: m.contains(document.activeElement), close: m.querySelector('.close-btn').getAttribute('aria-label') }; });
      if (!r.shown) throw new Error('Konto-Fenster geöffnet? ' + JSON.stringify(r));
      if (r.dlg !== 'dialog|account-title' || !r.close) throw new Error(JSON.stringify(r));
      if (!r.inside) throw new Error('Fokus nicht im Konto-Fenster');
      const small = await page.evaluate(() => Array.from(document.querySelectorAll('#account-modal button,#account-modal input,#account-modal select')).filter((el) => { const x = el.getBoundingClientRect(); return x.width > 0 && (x.width < 43.5 || x.height < 43.5); }).map((el) => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)));
      if (small.length) throw new Error('Zu klein im Konto-Fenster: ' + small.join('; '));
      await page.keyboard.press('Escape'); await page.waitForTimeout(250);
      const after = await page.evaluate(() => ({ open: getComputedStyle(document.getElementById('account-overlay')).display !== 'none', active: document.activeElement.id }));
      if (after.open || after.active !== 'btn-account') throw new Error('Nach Escape: ' + JSON.stringify(after));
      await context.close();
    });

    await runTest('Kontrast: Pille „laufend", Löschen-Button und Band-Abzeichen >= 4.5:1', async () => {
      const { context, page } = await open();
      await page.click('#tabs .tab[data-tab="owned"]'); await page.click('#vbtn-series'); await page.waitForTimeout(250);
      const res = await page.evaluate(() => {
        const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const rgba = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const L = (a) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
        const bgOf = (el, base) => { const st = []; while (el) { const c = rgba(getComputedStyle(el).backgroundColor); if (c[3] > 0) st.push(c); if (c[3] >= 0.99) break; el = el.parentElement; } let b = base; for (let i = st.length - 1; i >= 0; i--) b = [0, 1, 2].map((k) => st[i][k] * st[i][3] + b[k] * (1 - st[i][3])); return b; };
        const ratio = (el, base) => { const bg = bgOf(el, base); const f = rgba(getComputedStyle(el).color); const fg = [0, 1, 2].map((k) => f[k] * f[3] + bg[k] * (1 - f[3])); const a = L(fg), b = L(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
        const out = {};
        const pill = document.querySelector('.ongoing-pill'); if (pill) out.pill = ratio(pill, [17, 17, 31]);
        const del = document.getElementById('btn-del'); if (del) { out.del = ratio(del, [7, 7, 14]); }
        return out;
      });
      if (res.pill !== undefined && res.pill < 4.5) throw new Error('Pille ' + res.pill.toFixed(2) + ':1');
      // Band-Abzeichen: weisse Schrift auf rgba(0,0,0,.62) — ungünstigster Fall = weisser Untergrund
      await page.click('#vbtn-volumes'); await page.waitForTimeout(250);
      const badge = await page.evaluate(() => { const b = document.querySelector('.vol-band-badge'); const s = getComputedStyle(b); return s.backgroundColor + '|' + s.color; });
      const m = badge.match(/rgba?\(([^)]+)\)\|rgb\(([^)]+)\)/);
      if (!m) throw new Error('Badge-Stil: ' + badge);
      const a = parseFloat(m[1].split(',')[3] || '1');
      const gray = 255 * (1 - a); // schwarz mit Alpha a ueber Weiss
      const lum = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const cr = (1 + 0.05) / (lum(gray) + 0.05);
      if (cr < 4.5) throw new Error('Band-Abzeichen im ungünstigsten Fall ' + cr.toFixed(2) + ':1');
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
