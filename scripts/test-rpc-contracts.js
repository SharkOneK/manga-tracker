#!/usr/bin/env node
'use strict';

/**
 * test-rpc-contracts.js — Phase 68
 *
 * Statischer Vertragstest: stellt sicher, dass jeder in src/supabase.js
 * aufgerufene Supabase-RPC samt aller uebergebenen Parameter in den
 * SQL-Migrationen unter supabase/migrations/ deklariert ist.
 *
 * Vollstaendig offline — kein Netzwerk, kein Supabase, keine Secrets.
 *
 * Prueft:
 *   A) Jeder in supabase.js genutzte RPC ist in mindestens einer Migration definiert.
 *   B) Jeder im body uebergebene Parameter-Key ist in der massgeblichen
 *      (= letzten) Migrations-Signatur des RPC deklariert.
 *   Self-Check: Mindestens 4 RPCs gefunden (verhindert stille Parser-Fehler).
 *
 * Alphabetische Sortierung der Migrations-Dateien entspricht der zeitlichen
 * Reihenfolge (phase36b < phase51e, phase39b < phase51e) — letzte Definition gewinnt.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const supabaseJsPath = path.join(repoRoot, 'src', 'supabase.js');

let _passed = 0;
let _failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    _passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    _failed++;
  }
}

// ── Migration-Parsing ─────────────────────────────────────────────────────────
// Liest alle *.sql Dateien alphabetisch sortiert.
// Extrahiert CREATE OR REPLACE FUNCTION Signaturen via Regex.
// Letzte Definition gewinnt (PostgreSQL-Semantik / alphabetische Reihenfolge).
//
// Regex-Begruendung: `returns` als rechte Grenze schliesst $function$-Bodies aus
// und erlaubt mehrzeilige Signaturen ([\s\S] matched auch Zeilenumbrueche).
function parseMigrations() {
  const sqlFiles = fs.readdirSync(migrationsDir)
    .filter(function (f) { return f.endsWith('.sql'); })
    .sort(); // alphabetisch = chronologisch fuer diesen Dateibestand

  // Map: rpc_name -> { params: Set<string>, file: string }
  const sollMap = Object.create(null);

  const funcRe = /create\s+or\s+replace\s+function\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*returns/gi;

  for (var i = 0; i < sqlFiles.length; i++) {
    var file = sqlFiles[i];
    var content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    var match;
    funcRe.lastIndex = 0;
    while ((match = funcRe.exec(content)) !== null) {
      var name = match[1].toLowerCase();
      var paramStr = match[2];
      var params = parseParamList(paramStr);
      sollMap[name] = { params: params, file: file };
    }
  }

  return sollMap;
}

// Splittet eine Parameterliste klammer-bewusst an Top-Level-Kommas.
// Verhindert faelschliches Splitten bei z.B. `default '{}'::jsonb` oder `numeric(5,2)`.
// Gibt ein Set der Parameternamen zurueck (erstes Token je Fragment = Name).
function parseParamList(paramStr) {
  var result = new Set();
  var trimmed = paramStr.trim();
  if (!trimmed) return result;

  // Klammer-bewusstes Splitten
  var fragments = [];
  var depth = 0;
  var current = '';
  for (var i = 0; i < trimmed.length; i++) {
    var ch = trimmed[i];
    if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      fragments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) fragments.push(current.trim());

  for (var j = 0; j < fragments.length; j++) {
    var frag = fragments[j].trim();
    if (!frag) continue;
    // Erstes Token ist der Parametername (vor Typ / default / Whitespace)
    var firstToken = frag.split(/\s+/)[0].toLowerCase();
    if (firstToken) result.add(firstToken);
  }

  return result;
}

// ── supabase.js-Parsing ───────────────────────────────────────────────────────
// Findet alle RPC-Aufrufe via SUPA_RPC + '/<name>' und extrahiert
// die Body-Parameter-Keys je Aufrufstelle.
//
// Strategie:
//   1. Alle SUPA_RPC-Vorkommen mit Index sammeln.
//   2. Fuer jede Aufrufstelle rueckwaerts den zugehoerigen `var body = {`-Block suchen
//      (fuer submit_*-RPCs) oder das inline JSON.stringify({...})-Literal.
//   3. Top-Level-Keys des gefundenen Blocks extrahieren.
function parseSupabaseJs() {
  var src = fs.readFileSync(supabaseJsPath, 'utf8');

  // Alle RPC-Aufrufstellen finden
  var rpcCallRe = /SUPA_RPC\s*\+\s*'\/(\w+)'/g;
  var calls = []; // [{ name, index }]
  var m;
  while ((m = rpcCallRe.exec(src)) !== null) {
    calls.push({ name: m[1].toLowerCase(), index: m.index });
  }

  // Ist-Map: rpc_name -> Set<string> (Parameter-Keys)
  var istMap = Object.create(null);

  for (var i = 0; i < calls.length; i++) {
    var call = calls[i];
    var rpcName = call.name;

    // Wenn bereits erfasst, nicht erneut verarbeiten (gleicher RPC, mehrere Vorkommen
    // wuerden mit demselben body uebereinstimmen)
    if (istMap[rpcName]) continue;

    // Suche rueckwaerts ab der Aufrufstelle nach `var body = {`
    var bodyKeys = findBodyKeys(src, call.index);
    istMap[rpcName] = bodyKeys;
  }

  return istMap;
}

// Sucht fuer einen RPC-Aufruf bei `rpcCallIndex` den zugehoerigen Body-Block
// und gibt die Top-Level-Keys als Set zurueck.
//
// Strategie:
//   1. Suche VORWAERTS ab dem RPC-Aufruf nach `body: JSON.stringify({` innerhalb
//      von ~400 Zeichen (deckt inline-Bodies im selben Optionsobjekt ab).
//   2. Suche RUECKWAERTS nach `var body = {` in den letzten ~2000 Zeichen
//      (deckt die submit_*-Faelle ab, bei denen der Body als Variable gebaut wird).
//   3. Wenn beide gefunden: nimm denjenigen mit geringerem Abstand zur Aufrufstelle.
function findBodyKeys(src, rpcCallIndex) {
  var FORWARD_WINDOW = 400;
  var BACKWARD_WINDOW = 2000;

  var forwardSlice = src.slice(rpcCallIndex, rpcCallIndex + FORWARD_WINDOW);
  var backwardStart = Math.max(0, rpcCallIndex - BACKWARD_WINDOW);
  var backwardSlice = src.slice(backwardStart, rpcCallIndex);

  // Forward: `body: JSON.stringify({`
  var fwdMarker = 'body: JSON.stringify({';
  var fwdRelIdx = forwardSlice.indexOf(fwdMarker);
  var fwdAbsIdx = fwdRelIdx !== -1 ? rpcCallIndex + fwdRelIdx + fwdMarker.length - 1 : -1;
  // fwdAbsIdx zeigt auf das `{` des Objekts

  // Backward: `var body = {`
  var bwdMarker = 'var body = {';
  var bwdRelIdx = backwardSlice.lastIndexOf(bwdMarker);
  var bwdAbsIdx = bwdRelIdx !== -1 ? backwardStart + bwdRelIdx + bwdMarker.length - 1 : -1;
  // bwdAbsIdx zeigt auf das `{` des Objekts

  if (fwdAbsIdx !== -1 && bwdAbsIdx !== -1) {
    // Nimm den naeheren: forward hat Distanz fwdRelIdx, backward hat Distanz (rpcCallIndex - bwdAbsIdx)
    var fwdDist = fwdRelIdx;
    var bwdDist = rpcCallIndex - bwdAbsIdx;
    if (fwdDist <= bwdDist) {
      return extractObjectKeys(src, fwdAbsIdx);
    } else {
      return extractObjectKeys(src, bwdAbsIdx);
    }
  }

  if (fwdAbsIdx !== -1) return extractObjectKeys(src, fwdAbsIdx);
  if (bwdAbsIdx !== -1) return extractObjectKeys(src, bwdAbsIdx);

  return new Set();
}

// Extrahiert die Top-Level-Keys aus einem Objekt-Literal beginnend bei `startIndex`.
// Erwartet, dass src[startIndex] === '{' ist.
// Gibt ein Set der Key-Namen zurueck.
function extractObjectKeys(src, startIndex) {
  var keys = new Set();
  if (src[startIndex] !== '{') return keys;

  // Finde das schliessende `}` auf Top-Level
  var depth = 0;
  var end = startIndex;
  for (var i = startIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  var objContent = src.slice(startIndex + 1, end);

  // Extrahiere Top-Level-Keys: Zeilen mit `  key:` Pattern
  // Wir parsen line-by-line und zaehlen nur Keys auf depth=0
  var keyRe = /^\s*(\w+)\s*:/mg;
  var km;
  // Wir muessen sicherstellen, dass wir nur Top-Level-Keys nehmen.
  // Da verschachtelte Objekte in weiteren `{}` stehen, splitten wir den Content
  // nur bis zur naechsten oeffnenden `{` und testen Keys davor.
  // Einfacherer Ansatz: Line-by-Line, nur wenn bis zur aktuellen Zeile kein
  // ungepaartes `{` offen ist.
  var innerDepth = 0;
  var lines = objContent.split('\n');
  for (var l = 0; l < lines.length; l++) {
    var line = lines[l];
    // Zaehle Klammern in der Zeile VOR dem Key-Check
    for (var c = 0; c < line.length; c++) {
      if (line[c] === '{') innerDepth++;
      else if (line[c] === '}') innerDepth--;
    }
    // Key nur auf Top-Level (innerDepth nach Klammerung dieser Zeile)
    // Wir pruefen: wenn innerDepth <= 0 nach der Zeile, war die Zeile "aussen"
    // Aber besser: pruefe ob die Zeile selbst einen Key enthaelt und innerDepth
    // am Anfang der Zeile 0 war.
    // Neustart: innerDepth vor der Zeile berechnen.
  }

  // Einfacherer, robuster Ansatz: scanne den Inhalt zeichenweise fuer Top-Level-Keys.
  innerDepth = 0;
  var pos = 0;
  while (pos < objContent.length) {
    var ch = objContent[pos];
    if (ch === '{' || ch === '[') {
      innerDepth++;
      pos++;
    } else if (ch === '}' || ch === ']') {
      innerDepth--;
      pos++;
    } else if (innerDepth === 0) {
      // Auf Top-Level: versuche Key zu matchen
      keyRe.lastIndex = pos;
      var keyMatch = keyRe.exec(objContent);
      if (keyMatch && keyMatch.index === pos) {
        keys.add(keyMatch[1]);
        pos = keyMatch.index + keyMatch[0].length;
      } else {
        pos++;
      }
    } else {
      pos++;
    }
  }

  return keys;
}

// ── Test-Suite ────────────────────────────────────────────────────────────────

console.log('\nPhase 68 - Supabase-RPC-Vertragstests\n');

(async function main() {
  var sollMap;
  var istMap;

  await runTest('Migrations parsen — mindestens 4 RPC-Definitionen gefunden', function () {
    sollMap = parseMigrations();
    var names = Object.keys(sollMap);
    assert.ok(
      names.length >= 4,
      'Migrations-Parser hat nur ' + names.length + ' RPCs gefunden (erwartet >= 4). Parser-Fehler?'
    );
  });

  await runTest('supabase.js parsen — mindestens 4 genutzte RPCs gefunden', function () {
    istMap = parseSupabaseJs();
    var names = Object.keys(istMap);
    assert.ok(
      names.length >= 4,
      'supabase.js-Parser hat nur ' + names.length + ' RPC-Aufrufe gefunden (erwartet >= 4). Parser-Fehler?'
    );
  });

  // Bekannte RPCs muessen erkannt worden sein (Self-Check fuer Parser-Korrektheit)
  var KNOWN_RPCS = [
    'get_my_collection_ids',
    'get_owner_collection_for_user',
    'submit_release_intake_candidate',
    'submit_manga_catalog_candidate',
  ];

  await runTest('Self-Check — alle 4 bekannten RPCs in supabase.js erkannt', function () {
    for (var i = 0; i < KNOWN_RPCS.length; i++) {
      assert.ok(
        istMap && istMap[KNOWN_RPCS[i]],
        'RPC `' + KNOWN_RPCS[i] + '` wurde in supabase.js nicht erkannt.'
      );
    }
  });

  await runTest('Self-Check — alle 4 bekannten RPCs in Migrationen definiert', function () {
    for (var i = 0; i < KNOWN_RPCS.length; i++) {
      assert.ok(
        sollMap && sollMap[KNOWN_RPCS[i]],
        'RPC `' + KNOWN_RPCS[i] + '` wurde in keiner Migration definiert.'
      );
    }
  });

  // submit_*-RPCs: phase51e muss die massgebliche Definition sein (nicht 36b/39b)
  await runTest('submit_release_intake_candidate — massgebliche Definition ist phase51e', function () {
    var entry = sollMap && sollMap['submit_release_intake_candidate'];
    assert.ok(entry, 'RPC nicht in Soll-Map');
    assert.ok(
      entry.file.includes('phase51e'),
      'Massgebliche Migrationsdatei ist ' + entry.file + ', erwartet phase51e_*'
    );
  });

  await runTest('submit_manga_catalog_candidate — massgebliche Definition ist phase51e', function () {
    var entry = sollMap && sollMap['submit_manga_catalog_candidate'];
    assert.ok(entry, 'RPC nicht in Soll-Map');
    assert.ok(
      entry.file.includes('phase51e'),
      'Massgebliche Migrationsdatei ist ' + entry.file + ', erwartet phase51e_*'
    );
  });

  // Test A — Existenz: jeder genutzte RPC muss in einer Migration definiert sein
  await runTest('Test A — Existenz: alle genutzten RPCs sind in Migrationen definiert', function () {
    if (!sollMap || !istMap) {
      assert.fail('Parse-Fehler in vorherigen Tests — ueberspringe Existenzpruefung');
    }
    var missing = [];
    var usedNames = Object.keys(istMap);
    for (var i = 0; i < usedNames.length; i++) {
      if (!sollMap[usedNames[i]]) {
        missing.push(usedNames[i]);
      }
    }
    assert.strictEqual(
      missing.length, 0,
      'Folgende RPCs werden in supabase.js genutzt, sind aber in keiner Migration definiert: ' +
      missing.map(function (n) { return '`' + n + '`'; }).join(', ')
    );
  });

  // Test B — Parameter: alle body-Keys muessen in der Soll-Signatur deklariert sein
  await runTest('Test B — Parameter: alle body-Keys stimmen mit Migrations-Signaturen ueberein', function () {
    if (!sollMap || !istMap) {
      assert.fail('Parse-Fehler in vorherigen Tests — ueberspringe Parameter-Pruefung');
    }
    var violations = [];
    var usedNames = Object.keys(istMap);
    for (var i = 0; i < usedNames.length; i++) {
      var rpcName = usedNames[i];
      var soll = sollMap[rpcName];
      if (!soll) continue; // bereits in Test A gemeldet
      var istKeys = Array.from(istMap[rpcName]);
      var unknown = istKeys.filter(function (k) { return !soll.params.has(k); });
      if (unknown.length > 0) {
        violations.push(
          'RPC `' + rpcName + '` (massgeblich: ' + soll.file + '): ' +
          'Body-Keys nicht in Migrations-Signatur: ' +
          unknown.map(function (k) { return '`' + k + '`'; }).join(', ')
        );
      }
    }
    assert.strictEqual(
      violations.length, 0,
      'Vertragsbrueche gefunden:\n  ' + violations.join('\n  ')
    );
  });

  console.log('');
  console.log((_passed + _failed) + ' Tests — ' + _passed + ' bestanden, ' + _failed + ' fehlgeschlagen');
  if (_failed > 0) process.exit(1);
})();
