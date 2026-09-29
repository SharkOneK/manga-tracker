#!/usr/bin/env node
// scripts/test-owner-token-cleanup-phase84.js — Phase 84: Owner-Token-Reste
// entfernen und Import-Sync reparieren (Audit-Befund 22).
// Läuft direkt mit Node, kein Test-Framework nötig.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// ─── Testrahmen (identisch mit test-data-integrity.js) ────────────────────

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

console.log('\nPhase 84 — Owner-Token-Cleanup / Import-Sync-Tests\n');

// ─── Block 1: gespiegelte reine Funktion ───────────────────────────────────
// Spiegel von importSyncDecision(mode, collId) — src/app.js, neben canWriteCloud()
// platziert. Keine DOM-/localStorage-Zugriffe, daher hier 1:1 duplizierbar.

function importSyncDecision(mode, collId) {
  if (mode !== 'cloud-owner-edit') return 'skip';
  return collId ? 'sync' : 'no-collection';
}

console.log('── Block 1: importSyncDecision (gespiegelt) ────────────────');

runTest('cloud-owner-edit + collId → sync', function() {
  assert.strictEqual(importSyncDecision('cloud-owner-edit', 'col-1'), 'sync');
});
runTest('cloud-owner-edit + null (keine Collection) → no-collection', function() {
  assert.strictEqual(importSyncDecision('cloud-owner-edit', null), 'no-collection');
});
runTest('public-readonly + collId → skip', function() {
  assert.strictEqual(importSyncDecision('public-readonly', 'col-1'), 'skip');
});
runTest('locked + collId → skip', function() {
  assert.strictEqual(importSyncDecision('locked', 'col-1'), 'skip');
});
runTest('cloud-owner-edit + "" (leere collId) → no-collection', function() {
  assert.strictEqual(importSyncDecision('cloud-owner-edit', ''), 'no-collection');
});

// ─── Block 2: statische Quellcode-Guards ───────────────────────────────────
// Vor der Bereinigung (Phase 84) ist dieser Block rot: _ownerToken/supaHead/
// getOwnerState existierten in src/app.js, ownerToken/x-owner-token in
// src/supabase.js, mtOwnerToken wurde beim Logout in src/auth.js entfernt.

console.log('\n── Block 2: statische Quellcode-Guards ─────────────────────');

const appJsSrc = readFile('src/app.js');
const supabaseJsSrc = readFile('src/supabase.js');
const authJsSrc = readFile('src/auth.js');

runTest('src/app.js enthält kein "_ownerToken"', function() {
  assert.ok(!appJsSrc.includes('_ownerToken'), 'src/app.js enthält noch _ownerToken');
});
runTest('src/app.js enthält kein "supaHead"', function() {
  assert.ok(!appJsSrc.includes('supaHead'), 'src/app.js enthält noch supaHead');
});
runTest('src/app.js enthält kein "getOwnerState"', function() {
  assert.ok(!appJsSrc.includes('getOwnerState'), 'src/app.js enthält noch getOwnerState');
});

runTest('handleImportFile()-Block ruft importSyncDecision auf und enthält kein _ownerToken', function() {
  const start = appJsSrc.indexOf('async function handleImportFile');
  assert.ok(start >= 0, 'handleImportFile() nicht in src/app.js gefunden');
  const afterStart = start + 'async function handleImportFile'.length;
  const nextFnMatch = /\n(async )?function /.exec(appJsSrc.slice(afterStart));
  const end = nextFnMatch ? afterStart + nextFnMatch.index : appJsSrc.length;
  const block = appJsSrc.slice(start, end);
  assert.ok(block.includes('importSyncDecision'), 'handleImportFile()-Block ruft importSyncDecision nicht auf');
  assert.ok(!block.includes('_ownerToken'), 'handleImportFile()-Block enthält noch _ownerToken');
});

runTest('src/supabase.js enthält kein "x-owner-token"', function() {
  assert.ok(!supabaseJsSrc.includes('x-owner-token'), 'src/supabase.js enthält noch x-owner-token');
});
runTest('src/supabase.js enthält kein "ownerToken"', function() {
  assert.ok(!supabaseJsSrc.includes('ownerToken'), 'src/supabase.js enthält noch ownerToken');
});

runTest('src/auth.js enthält kein "mtOwnerToken"', function() {
  assert.ok(!authJsSrc.includes('mtOwnerToken'), 'src/auth.js enthält noch mtOwnerToken (Logout-Cleanup nicht entfernt)');
});

runTest('src/supabase.js: patchCollection() ruft weiterhin ensureFreshAccessToken auf (Session-Pfad unangetastet)', function() {
  const start = supabaseJsSrc.indexOf('async function patchCollection');
  assert.ok(start >= 0, 'patchCollection() nicht in src/supabase.js gefunden');
  const end = supabaseJsSrc.indexOf('window.MangaTrackerSupabase', start);
  const block = end > start ? supabaseJsSrc.slice(start, end) : supabaseJsSrc.slice(start);
  assert.ok(block.includes('ensureFreshAccessToken'), 'patchCollection() ruft ensureFreshAccessToken nicht mehr auf');
});

// ─── Block 3: Doku-Zeilenreferenz-Guard (docs/security.md) ────────────────
// Sammelt ALLE `pfad:zeile`- bzw. `pfad:start-ende`-Referenzen aus
// Backtick-Inhalten in docs/security.md — nicht nur `src/…`, sondern jeden
// repo-relativen Pfad mit Dateiendung (u. a. `sw.js`, `index.html`,
// `scripts/…`, `.github/workflows/…`, `supabase/migrations/…`). Für jede
// Referenz wird geprüft: (a) Datei existiert und die Zeile(n) liegen im
// gültigen Bereich, (b) der inhaltliche Bezug stimmt — dafür wird das
// nächstgelegene Backtick-Snippet in der Doku-Prosa (bevorzugt das
// unmittelbar VOR der Referenz stehende, sonst das danach folgende,
// begrenzt auf denselben Absatz/Listenpunkt) gegen den tatsächlichen
// Quelltext an der referenzierten Zeile geprüft.
//
// Ehrliche Einschränkung (nachgebessert nach Reviewer-Fund, Phase 84.1):
// Bei Bereichs-Referenzen (`:start-ende`) wird laut Spec nur die Startzeile
// geprüft — liegt der beschriebene Code ein paar Zeilen weiter hinten im
// Bereich (in diesem Repo bisher nur bei zwei `supabase/migrations/*.sql`-
// Referenzen der Fall), kann die inhaltliche Prüfung dort nicht automatisch
// greifen. Diese Fälle stehen explizit und begründet in
// SNIPPET_CHECK_EXCEPTIONS (gezählt und im Testlog sichtbar, nicht still
// übersprungen) — Datei-Existenz und Zeilen-Range werden für sie trotzdem
// geprüft. Für alle anderen Referenzen (insbesondere die in Phase 82/83
// tatsächlich gedrifteten `src/auth.js:127` und `sw.js:75`/`sw.js:89`) ist
// die inhaltliche Prüfung scharf: Eine Zeilen-Drift von auch nur wenigen
// Zeilen lässt den erwarteten Substring an der neuen Stelle mit hoher
// Wahrscheinlichkeit verschwinden und macht diesen Block rot.

console.log('\n── Block 3: Doku-Zeilenreferenz-Guard (docs/security.md) ──');

const securityMd = readFile('docs/security.md');

// Jeder Backtick-Span mit Position — Grundlage, um Referenzen von
// benachbarten Code-/Symbol-Snippets zu unterscheiden.
const TICK_RE = /`([^`]*)`/g;
const ticks = [];
let tickMatch;
while ((tickMatch = TICK_RE.exec(securityMd))) {
  ticks.push({ start: tickMatch.index, end: tickMatch.index + tickMatch[0].length, text: tickMatch[1] });
}

// Referenz-Form: beliebiger repo-relativer Pfad mit Dateiendung, gefolgt von
// :Zeile oder :Start-Ende. Bewusst NICHT auf src/ beschränkt.
const REF_INNER_RE = /^((?:[\w.\-]+\/)*[\w.\-]+\.[\w]+):(\d+)(?:-(\d+))?$/;

const docRefs = [];
ticks.forEach(function(t, idx) {
  const m = REF_INNER_RE.exec(t.text);
  if (m) {
    docRefs.push({
      tickIndex: idx,
      relPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : Number(m[2]),
      raw: m[0],
    });
  }
});

runTest('docs/security.md: alle Datei:Zeile-Referenzen zeigen auf existierende Dateien/Zeilen', function() {
  assert.ok(docRefs.length > 0, 'docs/security.md enthält keine Datei:Zeile-Referenzen (Regex greift nicht mehr?)');
  const issues = [];
  docRefs.forEach(function(ref) {
    const targetPath = path.join(repoRoot, ref.relPath);
    if (!fs.existsSync(targetPath)) {
      issues.push(ref.relPath + ':' + ref.startLine + ' — Datei nicht gefunden');
      return;
    }
    const totalLines = fs.readFileSync(targetPath, 'utf-8').split('\n').length;
    if (ref.startLine < 1 || ref.startLine > totalLines) {
      issues.push(ref.relPath + ':' + ref.startLine + ' — Startzeile außerhalb der Datei (' + totalLines + ' Zeilen)');
    }
    if (ref.endLine < ref.startLine || ref.endLine > totalLines) {
      issues.push(ref.relPath + ':' + ref.startLine + '-' + ref.endLine + ' — Endzeile außerhalb der Datei (' + totalLines + ' Zeilen)');
    }
  });
  assert.strictEqual(issues.length, 0, issues.join('; '));
});

// Begründete, sichtbare Ausnahmen von der inhaltlichen Prüfung (siehe
// Block-Kommentar oben). Key: "relPath:startLine[-endLine]" exakt wie im
// Doku-Text referenziert.
const SNIPPET_CHECK_EXCEPTIONS = {
  'supabase/migrations/20260926_phase81_audit_hardening.sql:72-77':
    'Range-Startzeile 72 ist eine Kommentar-/Leerzeile vor dem referenzierten ' +
    '`(select auth.uid())`-Ausdruck (tatsächlich Zeile 74); Block 3 prüft laut Spec nur ' +
    'die Range-Startzeile. Datei-Existenz und Zeilen-Range werden oben weiterhin geprüft; ' +
    'SQL-Migrationen bleiben laut Spec unangetastete Historie.',
  'supabase/migrations/phase51d_cleanup_inert_token_artifacts.sql:11-13':
    'Range-Startzeile 11 paraphrasiert den referenzierten Sachverhalt anders als das ' +
    'dort benachbart zitierte Schlüsselwort `owner_token_hash` (das steht in Zeile 9, ' +
    'außerhalb der Range); Block 3 prüft laut Spec nur die Range-Startzeile. Datei-Existenz ' +
    'und Zeilen-Range werden oben weiterhin geprüft; SQL-Migrationen bleiben laut Spec ' +
    'unangetastete Historie.',
};

const MAX_SNIPPET_HOP = 4;
const MAX_SNIPPET_DISTANCE = 300;

// Sucht auf einer Seite (vor/nach der Referenz) das nächstgelegene Backtick-
// Snippet, das selbst keine Datei:Zeile-Referenz ist. Bricht ab, sobald eine
// Absatz-/Listenpunkt-Grenze (Leerzeile) überquert würde, damit kein Snippet
// aus einem unabhängigen Nachbar-Absatz "zufällig nah genug" gewählt wird.
function nearestOnSide(tickIndex, before) {
  const refTick = ticks[tickIndex];
  const found = [];
  for (let hop = 1; hop <= MAX_SNIPPET_HOP; hop++) {
    const candIndex = before ? tickIndex - hop : tickIndex + hop;
    if (candIndex < 0 || candIndex >= ticks.length) continue;
    const cand = ticks[candIndex];
    if (REF_INNER_RE.test(cand.text)) continue;
    const gapText = before
      ? securityMd.slice(cand.end, refTick.start)
      : securityMd.slice(refTick.end, cand.start);
    if (/\n\s*\n/.test(gapText)) break; // Absatzgrenze überquert — Suche auf dieser Seite beenden
    if (gapText.length > MAX_SNIPPET_DISTANCE) continue;
    found.push({ text: cand.text, distance: gapText.length });
  }
  found.sort(function(a, b) { return a.distance - b.distance; });
  return found.length ? found[0].text : null;
}

// Vorzugsrichtung: vorangehendes Snippet ("`snippet()` (`pfad:zeile`)" ist das
// in dieser Doku durchgängig verwendete Muster). Nur wenn davor nichts im
// selben Absatz steht, wird nach einem folgenden Snippet gesucht.
function findNearbySnippet(tickIndex) {
  return nearestOnSide(tickIndex, true) || nearestOnSide(tickIndex, false);
}

// Kanonisiert ein Snippet für den Substring-Vergleich: „identifikatorartige"
// Aufrufe wie `foo()` oder `foo(a, b)` werden auf den Bezeichner vor der
// ersten Klammer gekürzt (die Doku zitiert Parameter oft anders als der
// tatsächliche Call-Site-Code). Literale Ausdrücke, die selbst mit „(" beginnen
// (z. B. `(select auth.uid())`), bleiben unverändert — dort wäre Kürzen sinnlos
// (leerer String).
function canonicalSnippet(raw) {
  if (/^[\w.]+\(/.test(raw)) return raw.slice(0, raw.indexOf('('));
  return raw;
}

runTest('docs/security.md: jede Referenz hat ein passendes Code-/Symbol-Snippet in der Nähe (oder eine begründete, gezählte Ausnahme)', function() {
  const issues = [];
  let exceptionsUsed = 0;
  docRefs.forEach(function(ref) {
    const key = ref.relPath + ':' + ref.startLine + (ref.endLine !== ref.startLine ? '-' + ref.endLine : '');
    const exceptionReason = SNIPPET_CHECK_EXCEPTIONS[key];
    const targetPath = path.join(repoRoot, ref.relPath);
    if (!fs.existsSync(targetPath)) return; // vom vorigen Test bereits gemeldet

    if (exceptionReason) {
      exceptionsUsed++;
      console.log('    (Ausnahme: ' + key + ' — ' + exceptionReason + ')');
      return;
    }

    const snippetRaw = findNearbySnippet(ref.tickIndex);
    if (snippetRaw === null) {
      issues.push(key + ' — kein Snippet in der Nähe und keine deklarierte Ausnahme in SNIPPET_CHECK_EXCEPTIONS');
      return;
    }
    const snippet = canonicalSnippet(snippetRaw);
    if (!snippet) {
      issues.push(key + ' — Snippet „' + snippetRaw + '" kanonisiert zu leerem String (nicht prüfbar)');
      return;
    }
    const lines = fs.readFileSync(targetPath, 'utf-8').split('\n');
    const targetLine = lines[ref.startLine - 1] || '';
    if (!targetLine.includes(snippet)) {
      issues.push(
        key + ' — Zeile enthält nicht "' + snippet + '" (tatsächlich: "' + targetLine.trim() + '")'
      );
    }
  });
  assert.strictEqual(
    exceptionsUsed,
    Object.keys(SNIPPET_CHECK_EXCEPTIONS).length,
    'Anzahl genutzter Ausnahmen (' + exceptionsUsed + ') weicht von SNIPPET_CHECK_EXCEPTIONS (' +
      Object.keys(SNIPPET_CHECK_EXCEPTIONS).length + ') ab — tote oder fehlende Ausnahme-Einträge?'
  );
  assert.strictEqual(issues.length, 0, issues.join('; '));
});

// ─── Abschlussbericht ─────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
if (_failed > 0) {
  process.exit(1);
}
