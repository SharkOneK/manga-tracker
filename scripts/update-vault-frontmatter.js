#!/usr/bin/env node
'use strict';

/**
 * update-vault-frontmatter.js — Phase 46f
 *
 * Halbautomatische Pflege des SharkMind-Projektnotiz-Frontmatters.
 *
 * Setzt nach einer abgeschlossenen Phase exakt zwei Frontmatter-Felder in der
 * Manga-Tracker-Projektnotiz:
 *   - letzter_commit  ← git rev-parse --short HEAD (aus diesem Repo)
 *   - zuletzt_geprueft ← aktuelles Datum (YYYY-MM-DD) oder --date <YYYY-MM-DD>
 *
 * Bewusst halbautomatisch: kein automatischer Vault-Schreibpfad, der Nutzer
 * löst das Script explizit aus. Es wird ausschließlich der YAML-Frontmatter-
 * Block (zwischen den ersten beiden `---`-Zeilen) angefasst; der restliche
 * Notizinhalt und alle übrigen Frontmatter-Felder bleiben unberührt.
 *
 * Nutzung:
 *   node scripts/update-vault-frontmatter.js                 # schreibt
 *   node scripts/update-vault-frontmatter.js --dry-run       # zeigt nur Diff
 *   node scripts/update-vault-frontmatter.js --check         # Exit 1 bei Drift
 *   node scripts/update-vault-frontmatter.js --note <pfad>   # andere Notiz
 *   node scripts/update-vault-frontmatter.js --date 2026-05-27
 *
 * Notiz-Pfad (Priorität):
 *   1. --note <pfad>
 *   2. Umgebungsvariable MANGA_TRACKER_VAULT_NOTE
 *   3. Default: C:\Users\KayKo\Documents\Obsidian\SharkMind\SharkMind\
 *               02 Projekte\Manga Tracker\Manga Tracker.md
 *
 * Exit-Codes:
 *   0 — erfolgreich aktualisiert / bereits aktuell / Dry-Run
 *   1 — Notiz fehlt, kein Frontmatter, Feld fehlt, oder (--check) Drift erkannt
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_NOTE = path.join(
  'C:', 'Users', 'KayKo', 'Documents', 'Obsidian', 'SharkMind', 'SharkMind',
  '02 Projekte', 'Manga Tracker', 'Manga Tracker.md',
);

// ── Felder, die dieses Script pflegt ─────────────────────────────────────────
const MANAGED_FIELDS = ['letzter_commit', 'zuletzt_geprueft'];

function parseArgs(argv) {
  const args = { dryRun: false, check: false, note: null, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unbekanntes Argument: ${arg}`);
  }
  return args;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function gitShortHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    throw new Error(`git rev-parse --short HEAD fehlgeschlagen: ${e.message}`);
  }
}

/**
 * Setzt ein bestehendes Top-Level-Frontmatter-Feld auf einen neuen Wert.
 * Erkennt nur einfache `key: value`-Zeilen am Zeilenanfang innerhalb des
 * Frontmatter-Blocks. Fehlt das Feld, wird ein Fehler gemeldet (kein blindes
 * Anlegen, damit das Script keine unerwarteten Felder erzeugt).
 */
function setFrontmatterField(frontmatter, key, value) {
  const lines = frontmatter.split('\n');
  const re = new RegExp(`^(${key})\\s*:\\s*(.*)$`);
  let found = false;
  let changed = false;
  let oldValue = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (m) {
      found = true;
      oldValue = m[2].trim();
      if (oldValue !== String(value)) {
        lines[i] = `${key}: ${value}`;
        changed = true;
      }
      break;
    }
  }
  return { found, changed, oldValue, text: lines.join('\n') };
}

function splitFrontmatter(content) {
  // Frontmatter muss in Zeile 1 mit '---' beginnen.
  if (!/^---\r?\n/.test(content)) return null;
  const rest = content.slice(content.indexOf('\n') + 1);
  const endIdx = rest.search(/\r?\n---\r?\n/);
  if (endIdx === -1) return null;
  const frontmatter = rest.slice(0, endIdx);
  const afterMatch = rest.slice(endIdx).match(/^\r?\n---\r?\n/);
  const body = rest.slice(endIdx + afterMatch[0].length);
  return { frontmatter, body, eol: content.includes('\r\n') ? '\r\n' : '\n' };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  if (args.help) {
    console.log('Pflegt letzter_commit und zuletzt_geprueft im Manga-Tracker-Projektnotiz-Frontmatter.');
    console.log('Optionen: --dry-run, --check, --note <pfad>, --date <YYYY-MM-DD>');
    process.exit(0);
  }

  const notePath = args.note || process.env.MANGA_TRACKER_VAULT_NOTE || DEFAULT_NOTE;
  const date = args.date || today();

  if (!isIsoDate(date)) {
    console.error(`✗ --date muss YYYY-MM-DD sein (erhalten: ${date})`);
    process.exit(1);
  }

  if (!fs.existsSync(notePath)) {
    console.error(`✗ Projektnotiz nicht gefunden: ${notePath}`);
    console.error('  Tipp: --note <pfad> oder MANGA_TRACKER_VAULT_NOTE setzen.');
    process.exit(1);
  }

  const commit = gitShortHead();

  const original = fs.readFileSync(notePath, 'utf8');
  const split = splitFrontmatter(original);
  if (!split) {
    console.error(`✗ Kein gültiger YAML-Frontmatter-Block (--- ... ---) in: ${notePath}`);
    process.exit(1);
  }

  const updates = { letzter_commit: commit, zuletzt_geprueft: date };

  let frontmatter = split.frontmatter;
  let anyChanged = false;
  const summary = [];
  for (const field of MANAGED_FIELDS) {
    const res = setFrontmatterField(frontmatter, field, updates[field]);
    if (!res.found) {
      console.error(`✗ Frontmatter-Feld fehlt und wird nicht blind angelegt: ${field}`);
      process.exit(1);
    }
    frontmatter = res.text;
    if (res.changed) {
      anyChanged = true;
      summary.push(`  ${field}: ${res.oldValue} → ${updates[field]}`);
    } else {
      summary.push(`  ${field}: ${updates[field]} (unverändert)`);
    }
  }

  const eol = split.eol;
  const rebuilt = `---${eol}${frontmatter}${eol}---${eol}${split.body}`;
  // Frontmatter-Manipulation arbeitete auf '\n'; bei CRLF-Dateien EOL angleichen.
  const finalContent = eol === '\r\n'
    ? rebuilt.replace(/\r?\n/g, '\r\n')
    : rebuilt;

  console.log(`Manga-Tracker-Frontmatter-Pflege (Phase 46f)`);
  console.log(`Notiz:  ${notePath}`);
  console.log(`Commit: ${commit}`);
  console.log(`Datum:  ${date}`);
  console.log(summary.join('\n'));

  if (args.check) {
    if (anyChanged) {
      console.error('\n✗ Drift: Frontmatter ist nicht aktuell (--check).');
      process.exit(1);
    }
    console.log('\n✓ Frontmatter ist aktuell.');
    process.exit(0);
  }

  if (!anyChanged) {
    console.log('\n✓ Bereits aktuell — keine Änderung nötig.');
    process.exit(0);
  }

  if (args.dryRun) {
    console.log('\n(dry-run) Keine Datei geschrieben.');
    process.exit(0);
  }

  fs.writeFileSync(notePath, finalContent, 'utf8');
  console.log('\n✓ Frontmatter aktualisiert.');
  process.exit(0);
}

main();
