#!/usr/bin/env node
'use strict';

/**
 * test-audit-json-pipe-truncation.js — Phase 54b
 *
 * Regressionstest fuer den stdout-Truncation-Bug aus Phase 54.
 *
 * Hintergrund:
 *   audit-release-cache-coverage.js schrieb das --json-Report mit
 *   process.stdout.write() und rief direkt danach process.exit() auf. Auf eine
 *   Pipe ist dieser Write asynchron — der Prozess endete vor dem Flush und
 *   schnitt die Ausgabe ab ~128 KiB (131072 Bytes) ab. Dadurch brach
 *   `Release Intake` Step 8 (sync-release-coverage-gap-docs.js) mit
 *   "kein parsbares JSON" ab.
 *
 * Warum der bestehende test-audit-json-contract.js den Bug NICHT gefangen hat:
 *   Er laeuft gegen die echten data/-Dateien, deren Audit-Ausgabe aktuell unter
 *   128 KiB liegt. Der Fehlermodus tritt erst oberhalb der Flush-Schwelle auf.
 *
 * Dieser Test:
 *   - generiert ein Fixture, dessen --json-Ausgabe GARANTIERT > 128 KiB ist
 *     (via AUDIT_WATCHLIST_FILE / AUDIT_CACHE_FILE-Overrides),
 *   - liest die Ausgabe durch eine echte Pipe (stdio 'pipe', wie das Sync-Skript),
 *   - prueft, dass die Ausgabe vollstaendig ankommt und sauber parst.
 *
 * Bei einer Regression (process.exit nach grossem stdout-Write) waere die
 * Ausgabe bei ~131072 Bytes abgeschnitten und JSON.parse wuerde werfen.
 *
 * PLATTFORM-HINWEIS (verifiziert 2026-06-04):
 *   Der Fehlermodus ist plattformabhaengig. Unter Linux (GitHub Actions / CI)
 *   sind stdout-Pipe-Writes in libuv asynchron — dort schneidet ein sofortiges
 *   process.exit() ab und DIESER TEST WIRD ROT. Unter Windows sind dieselben
 *   Writes synchron; dort liefert selbst die fehlerhafte Variante vollstaendige
 *   Ausgabe, der Test bleibt also gruen (kein False-Positive, aber auch kein
 *   Schutz). Der Test ist damit primaer ein CI-/Linux-Guard — genau dort, wo der
 *   Originalfehler (`Release Intake` Step 8) aufgetreten ist.
 */

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const repoRoot    = path.resolve(__dirname, '..');
const auditScript = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');

const TRUNCATION_THRESHOLD = 131072; // 128 KiB — die historische Flush-Schwelle

function fail(msg, extra) {
  console.error(`\n✖ FAIL: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// Baut ein Watchlist-Fixture, dessen Audit-Report (mit leerem Cache → alles
// "missing") deutlich ueber TRUNCATION_THRESHOLD liegt. Konservativ
// dimensioniert: jede Serie expandiert in mehrere Baende, jeder Band erzeugt
// Eintraege in checked[] und missing[].
function buildBigWatchlist() {
  const SERIES = 80;
  const VOLUMES_PER_SERIES = 8;
  const items = [];
  for (let s = 0; s < SERIES; s++) {
    items.push({
      enabled: true,
      seriesTitle: `Regressions-Testreihe ${s} mit absichtlich langem Titel zur Groessensteuerung`,
      publisher: `Testverlag ${s % 7}`,
      volumeNumbers: Array.from({ length: VOLUMES_PER_SERIES }, (_, v) => v + 1),
    });
  }
  return { items };
}

console.log('Phase 54b — Audit JSON Pipe-Truncation Regressionstest');
console.log('──────────────────────────────');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pipe-test-'));
const watchlistFile = path.join(tmpDir, 'release-watchlist.json');
const cacheFile = path.join(tmpDir, 'release-cache.json');

try {
  fs.writeFileSync(watchlistFile, JSON.stringify(buildBigWatchlist()), 'utf8');
  fs.writeFileSync(cacheFile, JSON.stringify({ items: [] }), 'utf8');

  // Audit durch eine echte Pipe lesen — exakt wie sync-release-coverage-gap-docs.js.
  const res = cp.spawnSync(process.execPath, [auditScript, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      AUDIT_WATCHLIST_FILE: watchlistFile,
      AUDIT_CACHE_FILE: cacheFile,
    },
  });

  if (res.error) fail(`Subprozess konnte nicht gestartet werden: ${res.error.message}`);
  if (typeof res.status !== 'number') fail('Subprozess ohne Statuscode beendet');
  ok(`Subprozess beendet mit exit code ${res.status}`);

  const stdout = String(res.stdout || '');
  const bytes = Buffer.byteLength(stdout, 'utf8');

  // Vorbedingung des Tests: das Fixture muss die historische Schwelle ueberschreiten,
  // sonst koennte der Test den Bug gar nicht provozieren.
  if (bytes <= TRUNCATION_THRESHOLD) {
    fail(`Fixture zu klein: Ausgabe ${bytes} B <= ${TRUNCATION_THRESHOLD} B. ` +
      'Test kann die Truncation nicht provozieren — Fixture vergroessern.');
  }
  ok(`Ausgabe ist ${bytes} B (> ${TRUNCATION_THRESHOLD} B = 128 KiB Schwelle)`);

  // Kein klassischer 128-KiB-Schnitt: bei Regression waere die Ausgabe exakt
  // bei der Flush-Schwelle gekappt.
  if (bytes === TRUNCATION_THRESHOLD) {
    fail('Ausgabe exakt bei 131072 B abgeschnitten — Truncation-Regression!');
  }

  const trimmed = stdout.trim();
  if (!trimmed.endsWith('}')) {
    fail('Ausgabe endet nicht auf "}" — vermutlich abgeschnitten (Truncation-Regression)',
      `--- letzte 120 Zeichen ---\n${trimmed.slice(-120)}`);
  }
  ok('Ausgabe endet sauber auf "}"');

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    fail(`Ausgabe ist kein parsbares JSON (Truncation-Regression): ${e.message}`,
      `--- letzte 200 Zeichen ---\n${trimmed.slice(-200)}`);
  }
  ok('JSON.parse erfolgreich — Ausgabe vollstaendig durch die Pipe angekommen');

  // Konsistenzpruefung: missing[] muss vollstaendig sein.
  if (!Array.isArray(parsed.missing)) fail('parsed.missing ist kein Array');
  if (parsed.missing.length !== parsed.summary.missingCacheCoverage) {
    fail(`missing.length (${parsed.missing.length}) != summary.missingCacheCoverage ` +
      `(${parsed.summary.missingCacheCoverage}) — unvollstaendiges JSON`);
  }
  ok(`missing.length === summary.missingCacheCoverage (${parsed.missing.length})`);

  if (parsed.schemaVersion !== 1) fail(`schemaVersion erwartet 1, gefunden ${parsed.schemaVersion}`);
  ok('schemaVersion === 1');

  console.log('\n✓ Audit JSON Pipe-Truncation OK');
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
