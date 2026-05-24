'use strict';

/**
 * validate-supabase-catalog-snapshot.js — Phase 39d
 *
 * Validiert data/release-cache-supabase-snapshot.json gegen das gleiche
 * Item-Schema wie release-cache.json (delegiert an validate-release-cache.js)
 * und prueft zusaetzlich die 39d-Huelle (source, supabaseProject, itemCount).
 *
 * Exit 0 = OK, Exit 1 = Fehler.
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(REPO_ROOT, 'data', 'release-cache-supabase-snapshot.json');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;

  if (!fs.existsSync(file)) {
    console.error('Snapshot-Datei nicht gefunden: ' + file);
    process.exit(1);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error('Ungueltiges JSON: ' + e.message);
    process.exit(1);
  }

  const errors = [];

  if (snapshot === null || typeof snapshot !== 'object') errors.push('Top-Level ist kein Objekt.');
  if (snapshot.schemaVersion !== 1) errors.push('schemaVersion muss 1 sein.');
  if (typeof snapshot.source !== 'string' || snapshot.source !== 'build-supabase-catalog-snapshot.js') {
    errors.push('source muss "build-supabase-catalog-snapshot.js" sein.');
  }
  if (typeof snapshot.supabaseProject !== 'string' || !/^[a-z0-9]+$/i.test(snapshot.supabaseProject)) {
    errors.push('supabaseProject muss alphanumerisch und nicht leer sein.');
  }
  if (typeof snapshot.generatedAt !== 'string' || !ISO_RE.test(snapshot.generatedAt) || isNaN(Date.parse(snapshot.generatedAt))) {
    errors.push('generatedAt muss ISO-Datum sein.');
  }
  if (!Array.isArray(snapshot.items)) {
    errors.push('items muss ein Array sein.');
  } else if (!Number.isInteger(snapshot.itemCount) || snapshot.itemCount !== snapshot.items.length) {
    errors.push('itemCount (' + snapshot.itemCount + ') stimmt nicht mit items.length (' + snapshot.items.length + ') ueberein.');
  }

  if (errors.length) {
    console.error('Phase 39d Snapshot-Huelle defekt:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }

  // Item-Schema delegieren an validate-release-cache.js
  const validator = path.join(REPO_ROOT, 'scripts', 'validate-release-cache.js');
  const res = spawnSync(process.execPath, [validator, file], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('Phase 39d: Item-Schema-Validierung fehlgeschlagen (siehe oben).');
    process.exit(res.status || 1);
  }

  console.log('Phase 39d Snapshot OK: ' + file + ' (' + snapshot.itemCount + ' items, project=' + snapshot.supabaseProject + ')');
}

main();
