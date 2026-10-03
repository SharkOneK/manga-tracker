#!/usr/bin/env node
// scripts/test-phase86-self-service-collection.js — Phase 86: Self-Service-
// Erstellung der eigenen Sammlung (Backlog 4.9).
// Läuft direkt mit Node, kein Test-Framework, vollständig offline (kein Supabase,
// kein Netzwerk, keine Secrets).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// ─── Testrahmen (identisch mit test-owner-token-cleanup-phase84.js) ────────

let _passed = 0;
let _failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    _failed++;
  }
}

function readFile(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

const MIGRATION_REL = 'supabase/migrations/20261002_phase86_create_my_collection.sql';

console.log('\nPhase 86 — Self-Service-Collection-Tests\n');

// ─── Block 1: gespiegelte reine Funktionen ─────────────────────────────────
// Spiegel von src/app.js (startOwnCollectionIntent / createCollectionFeedback,
// beide neben importSyncDecision() platziert). Keine DOM-/localStorage-Zugriffe,
// daher hier 1:1 duplizierbar.

function startOwnCollectionIntent(mode, collId) {
  if (mode === 'public-readonly')  return 'leave-public-view';
  if (mode === 'locked')           return 'need-login';
  if (mode === 'cloud-owner-edit') return collId ? 'already-has-collection' : 'create';
  return 'skip';
}

function createCollectionFeedback(result) {
  switch (result) {
    case 'created':
      return { ok: true,  toast: '✨ Deine Sammlung ist angelegt — Einträge sind über den Teilen-Link öffentlich lesbar.' };
    case 'exists':
      return { ok: true,  toast: 'ℹ️ Du hast schon eine Sammlung — sie wird geladen.' };
    case 'rate_limited':
      return { ok: false, toast: '⏳ Gerade wurden viele Sammlungen angelegt — bitte in einer Stunde noch mal versuchen.' };
    case 'capacity_reached':
      return { ok: false, toast: '🚧 Hier ist gerade kein Platz für neue Sammlungen.' };
    case 'not_allowed':
      return { ok: false, toast: '🔒 Bitte bestätige zuerst deine E-Mail-Adresse.' };
    case 'unauthenticated':
      return { ok: false, toast: '🔒 Bitte zuerst anmelden.' };
    case 'error':
      return { ok: false, toast: '⚠️ Verbindungsproblem — Sammlung konnte nicht angelegt werden.' };
    default:
      return { ok: false, toast: '⚠️ Sammlung konnte nicht angelegt werden — bitte später erneut versuchen.' };
  }
}

console.log('── Block 1: reine Funktionen (gespiegelt) ──────────────────');

runTest('public-readonly → leave-public-view (kein RPC-Aufruf)', function() {
  assert.strictEqual(startOwnCollectionIntent('public-readonly', null), 'leave-public-view');
});
runTest('public-readonly mit collId → leave-public-view (View hat Vorrang)', function() {
  assert.strictEqual(startOwnCollectionIntent('public-readonly', 'col-1'), 'leave-public-view');
});
runTest('locked → need-login', function() {
  assert.strictEqual(startOwnCollectionIntent('locked', null), 'need-login');
});
runTest('cloud-owner-edit + collId → already-has-collection', function() {
  assert.strictEqual(startOwnCollectionIntent('cloud-owner-edit', 'col-1'), 'already-has-collection');
});
runTest('cloud-owner-edit ohne collId → create', function() {
  assert.strictEqual(startOwnCollectionIntent('cloud-owner-edit', null), 'create');
});
runTest('cloud-owner-edit + "" (leere collId) → create', function() {
  assert.strictEqual(startOwnCollectionIntent('cloud-owner-edit', ''), 'create');
});
runTest('unbekannter Modus → skip', function() {
  assert.strictEqual(startOwnCollectionIntent('something-else', 'col-1'), 'skip');
});

runTest('Feedback: created → ok', function() {
  assert.strictEqual(createCollectionFeedback('created').ok, true);
  assert.ok(createCollectionFeedback('created').toast.length > 0);
});
runTest('Feedback: exists → ok (idempotent, ID nutzbar)', function() {
  assert.strictEqual(createCollectionFeedback('exists').ok, true);
});
runTest('Feedback: rate_limited → nicht ok', function() {
  assert.strictEqual(createCollectionFeedback('rate_limited').ok, false);
});
runTest('Feedback: capacity_reached → nicht ok', function() {
  assert.strictEqual(createCollectionFeedback('capacity_reached').ok, false);
});
runTest('Feedback: not_allowed → nicht ok', function() {
  assert.strictEqual(createCollectionFeedback('not_allowed').ok, false);
});
runTest('Feedback: unauthenticated → nicht ok', function() {
  assert.strictEqual(createCollectionFeedback('unauthenticated').ok, false);
});
runTest('Feedback: error → nicht ok', function() {
  assert.strictEqual(createCollectionFeedback('error').ok, false);
});
runTest('Feedback: unbekannter Code → Default-Zweig, nicht ok, generischer Text', function() {
  const fb = createCollectionFeedback('voellig_neuer_code');
  assert.strictEqual(fb.ok, false);
  assert.ok(fb.toast.length > 0, 'Default-Zweig liefert keinen Text');
});
runTest('Feedback: undefined/null → Default-Zweig, nicht ok', function() {
  assert.strictEqual(createCollectionFeedback(undefined).ok, false);
  assert.strictEqual(createCollectionFeedback(null).ok, false);
});
runTest('Feedback-Texte enthalten keinen RPC-Jargon', function() {
  const codes = ['created', 'exists', 'rate_limited', 'capacity_reached',
    'not_allowed', 'unauthenticated', 'error', 'unbekannt'];
  codes.forEach(function(code) {
    const t = createCollectionFeedback(code).toast;
    assert.ok(!/create_my_collection|auth\.uid|RPC|jsonb/i.test(t),
      'Toast für ' + code + ' enthält RPC-Jargon: ' + t);
  });
});

// ─── Block 2: SQL-Guards auf der Migration ─────────────────────────────────
// Alle inhaltlichen Checks — positiv wie verboten — laufen gegen den von
// `--`-Kommentaren befreiten Text: Verbote, weil die Migration im Kommentar
// bewusst begründet, was sie NICHT tut (kein INSERT-Policy, kein INSERT-Grant);
// Positivchecks, weil sie sonst durch einen Kommentar erfüllbar wären. Nur der
// „NOCH NICHT ANGEWENDET"-Check prüft naturgemäß den Rohtext.
// Ehrliche Einschränkung: die Kommentar-Entfernung ist zeilenweise und kennt
// keine String-Literale mit `--` (in dieser Datei gibt es keine).

console.log('\n── Block 2: SQL-Guards (Migration) ────────────────────────');

runTest('Migration ' + MIGRATION_REL + ' existiert', function() {
  assert.ok(fs.existsSync(path.join(repoRoot, MIGRATION_REL)),
    'Migrationsdatei fehlt (Namensschema YYYYMMDD_phaseNN_kurz.sql)');
});

const migrationSrc = fs.existsSync(path.join(repoRoot, MIGRATION_REL))
  ? readFile(MIGRATION_REL) : '';
const migrationSql = migrationSrc
  .split('\n')
  .map(function(line) {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

const SQL_REQUIRED = [
  'create or replace function public.create_my_collection()',
  'security definer',
  "set search_path = ''",
  'revoke execute on function public.create_my_collection() from public, anon;',
  'grant execute on function public.create_my_collection() to authenticated;',
  'collections_user_id_unique',
  'unique_violation',
  'email_confirmed_at',
  'create unique index if not exists collections_user_id_unique',
  'created_at',
];

// Bewusst gegen migrationSql (ohne Kommentare): sonst wäre jeder dieser Checks
// durch einen auskommentierten Textbaustein erfüllbar — ausgerechnet dort, wo die
// Phase-81-Falle (`from public, anon`), `security definer`, `search_path = ''` und
// der Unique-Index festgenagelt werden.
SQL_REQUIRED.forEach(function(needle) {
  runTest('Migration enthält "' + needle + '" (ohne Kommentare)', function() {
    assert.ok(migrationSql.includes(needle), 'Nicht gefunden in ' + MIGRATION_REL);
  });
});

runTest('Migration ist als angewendet markiert (keine veraltete „noch nicht angewendet"-Zeile)', function() {
  // Seit 2026-10-03 real angewendet (siehe .pipeline/review.md B8 und
  // docs/security.md) — der Dateikopf muss das jetzt ehrlich sagen, nicht
  // mehr den Vor-Review-Hinweis "NOCH NICHT ANGEWENDET" tragen.
  assert.ok(/^\s*--\s*APPLIED\s/m.test(migrationSrc),
    'Hinweis „APPLIED …" fehlt, obwohl die Migration angewendet wurde');
  assert.ok(!/NOCH NICHT ANGEWENDET/.test(migrationSrc),
    'Migration behauptet weiterhin „noch nicht angewendet", ist aber real angewendet');
});

runTest('RPC-Signatur: parameterlos, plpgsql, volatile, jsonb', function() {
  const sig = /create\s+or\s+replace\s+function\s+public\.create_my_collection\s*\(\s*\)\s*returns\s+jsonb([\s\S]{0,200})/i
    .exec(migrationSql);
  assert.ok(sig, 'Signatur `public.create_my_collection() returns jsonb` nicht gefunden');
  assert.ok(/language\s+plpgsql/i.test(sig[1]), 'language plpgsql fehlt in der Signatur');
  assert.ok(/volatile/i.test(sig[1]), 'volatile fehlt in der Signatur');
  assert.ok(/security\s+definer/i.test(sig[1]), 'security definer fehlt in der Signatur');
});

runTest('Rückgabe trägt die Keys result und collection_id', function() {
  assert.ok(/jsonb_build_object\(\s*'result'/.test(migrationSql),
    "jsonb_build_object('result', …) nicht gefunden");
  assert.ok(migrationSql.includes("'collection_id'"),
    "Key 'collection_id' fehlt in der Rückgabe");
});

runTest('Guard-Reihenfolge: auth.uid() → email_confirmed_at → 1-pro-User → Rate-Limit → Cap → INSERT', function() {
  const order = [
    'caller is null',
    'email_confirmed_at',
    "'exists'",
    'max_per_hour',
    'max_total',
    'insert into public.collections',
    'unique_violation',
  ];
  let cursor = -1;
  order.forEach(function(needle) {
    const idx = migrationSql.indexOf(needle, cursor + 1);
    assert.ok(idx > cursor, 'Guard "' + needle + '" fehlt oder steht in falscher Reihenfolge');
    cursor = idx;
  });
});

runTest('INSERT setzt ausschließlich id, user_id, data, public_data, visibility, updated_at, created_at', function() {
  const m = /insert\s+into\s+public\.collections\s*\(([\s\S]*?)\)/i.exec(migrationSql);
  assert.ok(m, 'INSERT auf public.collections nicht gefunden');
  const cols = m[1].split(',').map(function(c) { return c.trim(); }).filter(Boolean).sort();
  assert.deepStrictEqual(cols, [
    'created_at', 'data', 'id', 'public_data', 'updated_at', 'user_id', 'visibility',
  ]);
});

runTest('unique_violation-Handler meldet nie „exists" ohne ID', function() {
  const handler = /when\s+unique_violation\s+then([\s\S]*?)\bend\s*;/i.exec(migrationSql);
  assert.ok(handler, 'unique_violation-Handler nicht gefunden');
  assert.ok(/existing_id\s+is\s+null[\s\S]*?'error'/i.test(handler[1]),
    'Kein error-Zweig für „Re-Select findet keine Zeile" — der Client bekäme einen '
    + 'Erfolgs-Toast mit leerer collection_id');
});

runTest('Rate-Limit-Grenzen sind benannte Konstanten (5/Stunde, 50 gesamt)', function() {
  assert.ok(/max_per_hour\s+constant\s+int\s*:=\s*5\s*;/.test(migrationSql),
    'max_per_hour constant int := 5 fehlt');
  assert.ok(/max_total\s+constant\s+int\s*:=\s*50\s*;/.test(migrationSql),
    'max_total constant int := 50 fehlt');
});

const SQL_FORBIDDEN = [
  'grant insert',
  'for insert',
  'drop table',
  'delete from public.collections',
  'create policy',
];

SQL_FORBIDDEN.forEach(function(needle) {
  runTest('Migration enthält kein "' + needle + '" (ohne Kommentare)', function() {
    assert.ok(!migrationSql.toLowerCase().includes(needle),
      MIGRATION_REL + ' enthält "' + needle + '"');
  });
});

// Bewusst auf GRANT-Statements verengt statt auf die Zeichenkette `service_role`:
// verboten ist die Vergabe an eine Server-Rolle — ein `revoke execute … from
// service_role` wäre dagegen genau die richtige Reaktion, falls das Nachmessen
// zeigt, dass die Rolle das Recht über eine Altvergabe hält.
runTest('Migration vergibt keinen GRANT an service_role (ein revoke bleibt erlaubt)', function() {
  const offenders = migrationSql
    .split(';')
    .filter(function(stmt) {
      return /\bgrant\b/i.test(stmt) && /\bservice_role\b/i.test(stmt);
    })
    .map(function(stmt) { return stmt.trim().replace(/\s+/g, ' ').slice(0, 120); });
  assert.deepStrictEqual(offenders, [], 'GRANT an service_role: ' + offenders.join(' | '));
});

// ─── Block 3: Client-Guards ────────────────────────────────────────────────

console.log('\n── Block 3: Client-Guards ─────────────────────────────────');

const appJsSrc = readFile('src/app.js');
const supabaseJsSrc = readFile('src/supabase.js');
const htmlSrc = readFile('index.html');

runTest('src/supabase.js definiert createMyCollection() und ruft /create_my_collection auf', function() {
  assert.ok(supabaseJsSrc.includes('async function createMyCollection'),
    'createMyCollection() nicht definiert');
  assert.ok(supabaseJsSrc.includes("'/create_my_collection'"),
    "RPC-Pfad '/create_my_collection' nicht gefunden");
});

runTest('src/supabase.js exportiert createMyCollection', function() {
  const start = supabaseJsSrc.indexOf('window.MangaTrackerSupabase');
  assert.ok(start >= 0, 'Export-Objekt nicht gefunden');
  assert.ok(supabaseJsSrc.slice(start).includes('createMyCollection: createMyCollection'),
    'createMyCollection fehlt im Export-Objekt');
});

runTest('createMyCollection() nutzt ensureFreshAccessToken + sessionHeaders und wirft nie', function() {
  const start = supabaseJsSrc.indexOf('async function createMyCollection');
  const end = supabaseJsSrc.indexOf('window.MangaTrackerSupabase', start);
  const block = end > start ? supabaseJsSrc.slice(start, end) : supabaseJsSrc.slice(start);
  assert.ok(block.includes('ensureFreshAccessToken'), 'ensureFreshAccessToken() wird nicht aufgerufen');
  assert.ok(block.includes('sessionHeaders'), 'sessionHeaders() wird nicht genutzt');
  assert.ok(/try\s*\{/.test(block) && /catch\s*\(/.test(block), 'kein try/catch um den Request');
  assert.ok(!/\bthrow\b/.test(block), 'createMyCollection() wirft (soll nur Result-Codes liefern)');
});

runTest('src/app.js: startOwnCollection() ruft den echten Flow, kein Adopt-Hinweis mehr', function() {
  const start = appJsSrc.indexOf('async function startOwnCollection(');
  assert.ok(start >= 0, 'async function startOwnCollection() nicht gefunden');
  const afterStart = start + 'async function startOwnCollection('.length;
  const nextFnMatch = /\n(async )?function /.exec(appJsSrc.slice(afterStart));
  const end = nextFnMatch ? afterStart + nextFnMatch.index : appJsSrc.length;
  const block = appJsSrc.slice(start, end);
  assert.ok(block.includes('startOwnCollectionIntent'), 'startOwnCollectionIntent() wird nicht ausgewertet');
  assert.ok(block.includes('SupabaseAdapter.createMyCollection'), 'RPC wird nicht aufgerufen');
  assert.ok(block.includes('createCollectionFeedback'), 'createCollectionFeedback() wird nicht genutzt');
  assert.ok(block.includes('pushCloud') && block.includes('loadFromCloud'),
    'weder pushCloud() noch loadFromCloud() im Erfolgszweig');
  assert.ok(!/Adopt-Link/i.test(block), 'startOwnCollection() enthält noch einen Adopt-Link-Hinweis');
});

// Bewusst auf Nutzertexte begrenzt (toast(...)) statt auf die ganze Datei: der
// Begründungskommentar über startOwnCollection() darf den abgeschafften
// Adopt-Link weiterhin benennen, ein Toast nicht.
runTest('src/app.js: kein toast() verweist mehr auf Adopt-Link/Setup-Prozess', function() {
  const offenders = (appJsSrc.match(/toast\([^;]*\)/g) || [])
    .filter(function(call) { return /adopt|Setup-Prozess/i.test(call); });
  assert.deepStrictEqual(offenders, [], 'Adopt-Hinweis in Nutzertext: ' + offenders.join(' | '));
});

runTest('src/app.js enthält kein „Sammlung übernehmen" mehr (tote Statuszeile ersetzt)', function() {
  assert.ok(!appJsSrc.includes('Sammlung übernehmen'),
    'src/app.js enthält noch den toten Hinweis „Sammlung übernehmen"');
});

runTest('src/app.js: Doppelklick-Sperre _creatingCollection vorhanden', function() {
  assert.ok(appJsSrc.includes('let _creatingCollection = false;'), '_creatingCollection fehlt');
  assert.ok(/finally\s*\{\s*\n?\s*_creatingCollection = false;/.test(appJsSrc),
    '_creatingCollection wird nicht im finally-Block zurückgesetzt');
});

runTest('src/app.js: discoverAndLoadOwnCollection() blendet #no-collection-banner ein', function() {
  const start = appJsSrc.indexOf('async function discoverAndLoadOwnCollection');
  assert.ok(start >= 0, 'discoverAndLoadOwnCollection() nicht gefunden');
  const block = appJsSrc.slice(start);
  assert.ok(block.includes('no-collection-banner'), 'Banner wird nicht eingeblendet');
});

runTest('src/app.js: applyReadOnly() und applyLockedState() verstecken #no-collection-banner', function() {
  ['function applyReadOnly()', 'function applyLockedState()'].forEach(function(header) {
    const start = appJsSrc.indexOf(header);
    assert.ok(start >= 0, header + ' nicht gefunden');
    const afterStart = start + header.length;
    const nextFnMatch = /\n(async )?function /.exec(appJsSrc.slice(afterStart));
    const end = nextFnMatch ? afterStart + nextFnMatch.index : appJsSrc.length;
    const block = appJsSrc.slice(start, end);
    assert.ok(block.includes('no-collection-banner'),
      header + ' versteckt #no-collection-banner nicht');
  });
});

runTest('index.html: #no-collection-banner mit data-action="start-own-collection"', function() {
  const start = htmlSrc.indexOf('id="no-collection-banner"');
  assert.ok(start >= 0, '#no-collection-banner fehlt in index.html');
  const end = htmlSrc.indexOf('</div>', start);
  const block = htmlSrc.slice(start, end > start ? end : start + 400);
  assert.ok(block.includes('data-action="start-own-collection"'),
    'Banner enthält keinen Button mit data-action="start-own-collection"');
  assert.ok(block.includes('hidden') || htmlSrc.slice(Math.max(0, start - 120), start).includes('hidden'),
    'Banner startet nicht versteckt (class="… hidden")');
});

runTest('index.html: #no-collection-banner ohne Inline-Handler (CSP)', function() {
  const start = htmlSrc.indexOf('id="no-collection-banner"');
  assert.ok(start >= 0, '#no-collection-banner fehlt in index.html');
  const block = htmlSrc.slice(Math.max(0, start - 200), start + 500);
  assert.ok(!/\son[a-z]+\s*=/i.test(block), 'Inline-Event-Handler im Banner-Markup gefunden');
});

runTest('scripts/test-rpc-contracts.js kennt create_my_collection', function() {
  assert.ok(readFile('scripts/test-rpc-contracts.js').includes("'create_my_collection'"),
    'create_my_collection fehlt in KNOWN_RPCS');
});

// ─── Block 4: Public-Projection-Invariante ─────────────────────────────────
// Die Phase darf die öffentliche Ausgabe nicht verändern: neue Sammlungen tragen
// genau die kanonische leere Projektion, die View bleibt unangetastet und
// created_at bekommt keinen Grant.

console.log('\n── Block 4: Public-Projection-Invariante ──────────────────');

runTest('public_data ist genau die kanonische leere Projektion (schemaVersion + m)', function() {
  assert.ok(
    /jsonb_build_object\(\s*'schemaVersion'\s*,\s*3\s*,\s*'m'\s*,\s*jsonb_build_array\(\s*\)\s*\)/
      .test(migrationSql),
    "jsonb_build_object('schemaVersion', 3, 'm', jsonb_build_array()) nicht gefunden"
  );
  // data und public_data werden mit derselben Konstante gesetzt — kein zweiter,
  // abweichender Projektionsaufbau in der Migration.
  const buildCalls = migrationSql.match(/jsonb_build_object\(\s*'schemaVersion'/g) || [];
  assert.strictEqual(buildCalls.length, 1,
    'Mehr als eine schemaVersion-Projektion in der Migration (' + buildCalls.length + ')');
});

runTest('Die kanonische leere Sammlung trägt ausschließlich die Keys schemaVersion und m', function() {
  const m = /empty_collection\s+constant\s+jsonb\s*:=([\s\S]*?);/i.exec(migrationSql);
  assert.ok(m, 'Konstante empty_collection nicht gefunden');
  const keys = (m[1].match(/'([a-zA-Z_][\w]*)'/g) || []).map(function(s) { return s.slice(1, -1); }).sort();
  assert.deepStrictEqual(keys, ['m', 'schemaVersion']);
});

runTest('Migration ändert collection_public_projection nicht', function() {
  assert.ok(!/collection_public_projection/i.test(migrationSql),
    'Migration berührt die Public-Projection-View');
  assert.ok(!/create\s+or\s+replace\s+view/i.test(migrationSql),
    'Migration enthält ein create-or-replace-view');
});

runTest('Migration vergibt keine neuen Tabellen-Grants (insb. kein grant select auf created_at)', function() {
  assert.ok(!/grant\s+select/i.test(migrationSql), 'Migration enthält ein grant select');
  assert.ok(!/grant\s+update/i.test(migrationSql), 'Migration enthält ein grant update');
  assert.ok(!/on\s+table\s+public\.collections/i.test(migrationSql),
    'Migration vergibt/entzieht Rechte auf der Tabelle public.collections');
});

runTest('created_at wird additiv und idempotent angelegt', function() {
  assert.ok(/alter\s+table\s+public\.collections[\s\S]{0,120}add\s+column\s+if\s+not\s+exists\s+created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i
    .test(migrationSql), 'add column if not exists created_at … default now() fehlt');
});

runTest('src/app.js: buildPublicCollectionData() unverändert vorhanden (keine neuen Felder)', function() {
  assert.ok(appJsSrc.includes('function buildPublicCollectionData(db)'),
    'buildPublicCollectionData() nicht gefunden');
  assert.ok(appJsSrc.includes('const SCHEMA_VERSION = 3;'),
    'SCHEMA_VERSION ist nicht mehr 3 — die Migration legt schemaVersion 3 an');
});

// ─── Abschlussbericht ─────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
if (_failed > 0) {
  process.exit(1);
}
