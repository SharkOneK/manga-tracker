#!/usr/bin/env node
'use strict';

/**
 * Phase 46a — Einheitlicher Validierungs-Runner.
 *
 * Führt alle Pflicht-Checks des Manga-Trackers in einem Lauf aus, damit lokal
 * und in CI exakt dieselbe Abdeckung gilt. Verhindert Drift, bei der ein neues
 * Test-/Validator-Script in CI oder lokal vergessen wird.
 *
 * Verhalten:
 *  - Fail-fast: Der erste rote Check bricht den Lauf mit dessen Exit-Code ab.
 *  - Vollständig offline: kein Netzwerk, kein Supabase, keine Secrets nötig.
 *  - Idempotent: schreibt höchstens nach artifacts/ (gitignored) und – falls
 *    GITHUB_STEP_SUMMARY gesetzt ist – in die GitHub-Actions-Summary.
 *
 * Bewusst NICHT ausgeführt (nur Syntax-geprüft), weil sie Argumente, Netzwerk
 * oder Secrets benötigen: die Auto-Merge-Gates, die Pipeline-/Intake-/Snapshot-
 * Runner, der Live-Smoke und die Status-Mail-Writer.
 *
 * Nutzung (kanonisch, funktioniert auf Windows, macOS, Linux/CI):
 *   node scripts/run-all-checks.js        # alles
 *   node scripts/run-all-checks.js --syntax-only
 *   node scripts/run-all-checks.js --run-only
 *
 *   npm run validate / npm test           # bequemer Alias
 *
 * Windows-Hinweis: Einige Checks (Coverage-Report, Coverage-Gap-Validator,
 * Auto-Merge-Gate-Test) starten intern eigene Node-Unterprozesse. Über den
 * zusätzlichen `npm`-Prozess-Layer kann das unter Windows/libuv in sehr tiefen
 * Spawn-Ketten "EBADF" werfen. Auf Windows daher bevorzugt direkt
 * `node scripts/run-all-checks.js` aufrufen. CI (Linux) ist nicht betroffen.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const syntaxOnly = args.includes('--syntax-only');
const runOnly = args.includes('--run-only');

// ── Phase 1: Syntax-Checks (node --check) ────────────────────────────────────
// Superset der heutigen CI-Syntax-Checks plus alle Lauf-/Gate-Scripts.
const SYNTAX_FILES = [
  'src/app.js',
  'src/utils.js',
  'src/supabase.js',
  'src/release-utils.js',
  'scripts/run-all-checks.js',
  'scripts/validate-release-cache.js',
  'scripts/update-release-cache.js',
  'scripts/run-release-cache-pipeline.js',
  'scripts/smoke-test-static.js',
  'scripts/check-secrets.js',
  'scripts/security-audit-static.js',
  'scripts/test-stats.js',
  'scripts/test-data-integrity.js',
  'scripts/test-public-projection.js',
  'scripts/test-public-private-diff.js',
  'scripts/test-automerge-gate.js',
  'scripts/test-intake-automerge-gate.js',
  'scripts/test-release-volume-counts.js',
  'scripts/test-manga-passion-backfill.js',
  'scripts/live-smoke-pages.js',
  'scripts/write-release-cache-coverage-report.js',
  'scripts/write-release-cache-coverage-summary.js',
  'scripts/write-release-cache-status-mail.js',
  'scripts/write-release-volume-counts-status-mail.js',
  'scripts/validate-release-cache-coverage-gaps.js',
  'scripts/validate-release-watchlist.js',
  'scripts/validate-release-source-review-queue.js',
  'scripts/validate-release-cache-pipeline-report.js',
  'scripts/validate-release-cache-automerge-gate.js',
  'scripts/validate-release-intake-automerge-gate.js',
  'scripts/run-release-volume-counts.js',
  'scripts/validate-release-volume-counts.js',
  'scripts/validate-release-volume-counts-automerge-gate.js',
  'scripts/apply-release-intake-candidates.js',
  'scripts/report-catalog-lifecycle.js',
  'scripts/update-vault-frontmatter.js',
  'scripts/sync-release-coverage-gap-docs.js',
  'scripts/audit-release-cache-coverage.js',
  'scripts/test-audit-json-contract.js',
];

// ── Phase 2: Ausgeführte Checks (deckt CI ab + ergänzt fehlende Validatoren) ──
// { label, cmd, cmdArgs }
const RUN_CHECKS = [
  { label: 'Validate release cache',                cmd: 'node', cmdArgs: ['scripts/validate-release-cache.js'] },
  { label: 'Write release-cache coverage report',   cmd: 'node', cmdArgs: ['scripts/write-release-cache-coverage-report.js'] },
  { label: 'Write release-cache coverage summary',  cmd: 'node', cmdArgs: ['scripts/write-release-cache-coverage-summary.js'] },
  { label: 'Validate release-cache coverage gaps',  cmd: 'node', cmdArgs: ['scripts/validate-release-cache-coverage-gaps.js'] },
  { label: 'Validate release watchlist',            cmd: 'node', cmdArgs: ['scripts/validate-release-watchlist.js'] },
  { label: 'Validate release source review queue',  cmd: 'node', cmdArgs: ['scripts/validate-release-source-review-queue.js'] },
  { label: 'Validate release-cache pipeline report',cmd: 'node', cmdArgs: ['scripts/validate-release-cache-pipeline-report.js'] },
  { label: 'Validate release volume counts',        cmd: 'node', cmdArgs: ['scripts/validate-release-volume-counts.js'] },
  { label: 'Smoke test — statische Struktur',       cmd: 'node', cmdArgs: ['scripts/smoke-test-static.js'] },
  { label: 'Secret check',                          cmd: 'node', cmdArgs: ['scripts/check-secrets.js'] },
  { label: 'Stats tests',                           cmd: 'node', cmdArgs: ['scripts/test-stats.js'] },
  { label: 'Data integrity tests',                  cmd: 'node', cmdArgs: ['scripts/test-data-integrity.js'] },
  { label: 'Public projection tests',               cmd: 'node', cmdArgs: ['scripts/test-public-projection.js'] },
  { label: 'Public/Private diff tests',             cmd: 'node', cmdArgs: ['scripts/test-public-private-diff.js'] },
  { label: 'Release volume count tests',            cmd: 'node', cmdArgs: ['scripts/test-release-volume-counts.js'] },
  { label: 'Manga Passion backfill tests (Phase 48)', cmd: 'node', cmdArgs: ['scripts/test-manga-passion-backfill.js'] },
  { label: 'Audit JSON-Output contract (Phase 49)',   cmd: 'node', cmdArgs: ['scripts/test-audit-json-contract.js'] },
  { label: 'Auto-merge gate tests',                 cmd: 'node', cmdArgs: ['scripts/test-automerge-gate.js'] },
  { label: 'Intake auto-merge gate tests',          cmd: 'node', cmdArgs: ['scripts/test-intake-automerge-gate.js'] },
  { label: 'Security audit (static)',               cmd: 'node', cmdArgs: ['scripts/security-audit-static.js'] },
  { label: 'git diff --check (whitespace/conflict)',cmd: 'git',  cmdArgs: ['diff', '--check'] },
];

function fail(label, cmd, cmdArgs, status) {
  console.error('');
  console.error(`✖ FAILED: ${label}`);
  console.error(`  command: ${cmd} ${cmdArgs.join(' ')}`);
  process.exit(typeof status === 'number' && status ? status : 1);
}

// Kind-Ausgabe wird über echte Datei-Deskriptoren geleitet (nicht über Pipes
// und nicht 'inherit'). Grund: tief verschachtelte synchrone Spawns
// (npm → Runner → Writer → Audit) lassen unter Windows/libuv Pipe-Handles mit
// "EBADF: bad file descriptor, write" brechen. Datei-fds sind robust dagegen.
function step(label, cmd, cmdArgs) {
  process.stdout.write(`\n▶ ${label}\n`);
  const logPath = path.join(os.tmpdir(), `mt-check-${process.pid}-${stepCount}.log`);
  const fd = fs.openSync(logPath, 'w');
  let status = 0;
  try {
    execFileSync(cmd, cmdArgs, {
      cwd: repoRoot,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
  } catch (e) {
    status = (typeof e.status === 'number' && e.status) ? e.status : 1;
  } finally {
    fs.closeSync(fd);
  }
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(logPath); } catch (_) { /* ignore */ }
  if (out && out.trim()) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  if (status) fail(label, cmd, cmdArgs, status);
}

const startedAt = Date.now();
let stepCount = 0;

if (!runOnly) {
  console.log('────────────────────────────────────────────────────────');
  console.log(' Phase 1 — Syntax checks (node --check)');
  console.log('────────────────────────────────────────────────────────');
  for (const file of SYNTAX_FILES) {
    step(`syntax: ${file}`, 'node', ['--check', file]);
    stepCount += 1;
  }
}

if (!syntaxOnly) {
  console.log('\n────────────────────────────────────────────────────────');
  console.log(' Phase 2 — Validators & tests');
  console.log('────────────────────────────────────────────────────────');
  for (const check of RUN_CHECKS) {
    step(check.label, check.cmd, check.cmdArgs);
    stepCount += 1;
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log('\n────────────────────────────────────────────────────────');
console.log(`✓ ALL CHECKS PASSED — ${stepCount} steps in ${seconds}s`);
console.log('────────────────────────────────────────────────────────');
