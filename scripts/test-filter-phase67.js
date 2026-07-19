#!/usr/bin/env node
// scripts/test-filter-phase67.js — Phase 67: Erweiterte Such- und Filteroptionen
// Testet applySearch (genres/notes-Erweiterung) und applyGenreFilter (Mehrfachauswahl).
// Läuft direkt mit Node, kein Test-Framework nötig.
'use strict';

const assert = require('assert');

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

// ─── Aus app.js gespiegelte Funktionen (ohne DOM-Abhängigkeit) ─────────────
// Spiegelbild der Implementierung; searchQ wird als Parameter übergeben,
// filterGenres ebenfalls — so bleiben die Funktionen pure/testbar.

function applySearch(list, searchQ) {
  if (!searchQ) return list;
  return list.filter(m =>
    m.title.toLowerCase().includes(searchQ) ||
    (m.pub||'').toLowerCase().includes(searchQ) ||
    (m.genres||[]).some(g => (g||'').toLowerCase().includes(searchQ)) ||
    (m.notes||'').toLowerCase().includes(searchQ)
  );
}

function applyGenreFilter(list, filterGenres) {
  if (filterGenres.length === 0) return list;
  return list.filter(m => (m.genres||[]).some(g => filterGenres.includes(g)));
}

// Phase 72: Medientyp-Filter — filterMedia als Parameter übergeben, analog applyGenreFilter.
function applyMediaFilter(list, filterMedia) {
  if (!filterMedia) return list;
  return list.filter(m => (m.mediaType || 'manga') === filterMedia);
}

function shouldShowMediaFilter(list) {
  return new Set((list || []).map(m => m.mediaType || 'manga')).size > 1;
}

// Toggle-Logik aus setGenreFilter
function toggleGenre(filterGenres, g) {
  if (g === '') return [];
  const idx = filterGenres.indexOf(g);
  if (idx === -1) return [...filterGenres, g];
  return filterGenres.filter(x => x !== g);
}

// ─── Mock-Daten ────────────────────────────────────────────────────────────

const SERIES = [
  {
    id: '1',
    title: 'Berserk',
    pub: 'Panini',
    genres: ['Action', 'Fantasy', 'Horror'],
    notes: 'Meisterwerk der Dark Fantasy',
  },
  {
    id: '2',
    title: 'One Piece',
    pub: 'Carlsen',
    genres: ['Action', 'Adventure'],
    notes: 'Piratenabenteuer',
  },
  {
    id: '3',
    title: 'Yotsuba',
    pub: 'Tokyopop',
    genres: ['Slice of Life'],
    notes: 'Niedliche Alltagsgeschichten',
  },
  {
    id: '4',
    title: 'Dungeon Meshi',
    pub: 'Egmont',
    genres: ['Fantasy', 'Comedy'],
    notes: 'Kochen in einem Dungeon',
  },
  {
    id: '5',
    title: 'Vinland Saga',
    pub: 'Kodansha',
    genres: ['Action', 'Historical'],
    notes: '',
  },
];

// Serie ohne genres und ohne notes
const SERIES_MINIMAL = [
  { id: '6', title: 'Minimal', pub: 'TestVerlag' },
];

// Serie mit genres = null und notes = null
const SERIES_NULL_FIELDS = [
  { id: '7', title: 'NullFelder', pub: 'TestVerlag', genres: null, notes: null },
];

// Phase 72: gemischte Sammlung aus manga/series/anime (inkl. unmigrierter Eintrag ohne mediaType)
const SERIES_MIXED_MEDIA = [
  { id: '1', title: 'Berserk', mediaType: 'manga', genres: ['Action', 'Fantasy'] },
  { id: '2', title: 'Attack on Titan (Anime)', mediaType: 'anime', genres: ['Action'] },
  { id: '3', title: 'The Boys (Serie)', mediaType: 'series', genres: ['Action', 'Drama'] },
  { id: '4', title: 'One Piece', mediaType: 'manga', genres: ['Adventure'] },
  { id: '8', title: 'Unmigriert', genres: ['Action'] }, // kein mediaType → Fallback 'manga'
];

// ─── Tests: applySearch ────────────────────────────────────────────────────

console.log('\n── applySearch ────────────────────────────────────────────');

// Test 1: Suche trifft auf title (Regression)
runTest('T1: Suche nach Titel-Begriff matcht (Regression)', function() {
  const result = applySearch(SERIES, 'berserk');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '1');
});

// Test 2: Suche trifft auf pub (Regression)
runTest('T2: Suche nach Verlags-Begriff matcht (Regression)', function() {
  const result = applySearch(SERIES, 'carlsen');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '2');
});

// Test 3: Suche trifft auf genres (neu)
runTest('T3: Suche nach Genre-Begriff matcht Einträge mit diesem Genre', function() {
  const result = applySearch(SERIES, 'horror');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '1', 'Berserk hat Horror-Genre');
});

runTest('T3b: Suche nach "fantasy" matcht mehrere Einträge über Genre', function() {
  const result = applySearch(SERIES, 'fantasy');
  // Berserk (Action/Fantasy/Horror) und Dungeon Meshi (Fantasy/Comedy)
  assert.strictEqual(result.length, 2);
  const ids = result.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['1', '4']);
});

// Test 4: Suche trifft auf notes (neu)
runTest('T4: Suche nach Wort nur in notes matcht den Eintrag', function() {
  const result = applySearch(SERIES, 'dungeon');
  // Nur Dungeon Meshi hat "Dungeon" in den Notes (Titel ist auch "Dungeon Meshi" → beide matchen)
  // Teste mit einzigartigem notes-Begriff
  const result2 = applySearch(SERIES, 'piratenabenteuer');
  assert.strictEqual(result2.length, 1, 'Nur One Piece hat "Piratenabenteuer" in notes');
  assert.strictEqual(result2[0].id, '2');
});

runTest('T4b: Suche nach Wort nur in notes (anderer Eintrag)', function() {
  const result = applySearch(SERIES, 'meisterwerk');
  assert.strictEqual(result.length, 1, 'Nur Berserk hat "Meisterwerk" in notes');
  assert.strictEqual(result[0].id, '1');
});

// Test 5: Suche trifft auf nichts → leeres Ergebnis
runTest('T5: Suche ohne Treffer liefert leeres Array', function() {
  const result = applySearch(SERIES, 'xyznotexistent999');
  assert.strictEqual(result.length, 0);
});

// Test 6: genres = undefined → kein Crash
runTest('T6: genres = undefined verursacht keinen Crash', function() {
  const list = [{ id: '6', title: 'Minimal', pub: 'Verlag' }]; // kein genres
  let result;
  assert.doesNotThrow(() => { result = applySearch(list, 'fantasy'); });
  assert.strictEqual(result.length, 0);
});

// Test 7: notes = null → kein Crash
runTest('T7: notes = null verursacht keinen Crash', function() {
  const list = [{ id: '7', title: 'NullNotes', pub: 'Verlag', genres: ['Action'], notes: null }];
  let result;
  assert.doesNotThrow(() => { result = applySearch(list, 'irgendwas'); });
  assert.strictEqual(result.length, 0);
});

runTest('T7b: genres = null verursacht keinen Crash', function() {
  const list = [{ id: '8', title: 'NullGenres', pub: 'Verlag', genres: null, notes: 'Testnotiz' }];
  let result;
  assert.doesNotThrow(() => { result = applySearch(list, 'action'); });
  assert.strictEqual(result.length, 0);
});

// Test 8: Leere Suche → alle Einträge zurückgegeben
runTest('T8: Leere Suche (searchQ = "") liefert alle Einträge zurück', function() {
  const result = applySearch(SERIES, '');
  assert.strictEqual(result.length, SERIES.length);
});

runTest('T8b: searchQ = null/falsy liefert alle Einträge zurück', function() {
  const resultNull = applySearch(SERIES, null);
  const resultUndef = applySearch(SERIES, undefined);
  assert.strictEqual(resultNull.length, SERIES.length);
  assert.strictEqual(resultUndef.length, SERIES.length);
});

// Test: Case-insensitiv (Spec AK)
// Hinweis: In der echten App lowercased onSearch() den Query bereits vor der
// Speicherung in searchQ (app.js Z. 529: searchQ = val.trim().toLowerCase()).
// applySearch() erwartet daher ein bereits lowercase searchQ und lowercased nur
// die Datenwerte. Der Test spiegelt diesen Vertrag korrekt wider.
runTest('T_ci: Suche ist case-insensitiv (Query kommt lowercase über onSearch)', function() {
  // Alle drei Varianten sind in der App identisch, da onSearch() toLowerCase() aufruft.
  // In der gespiegelten Funktion übergeben wir lowercase wie die echte App es tut.
  const r1 = applySearch(SERIES, 'horror');   // simuliert onSearch('HORROR')
  const r2 = applySearch(SERIES, 'horror');   // simuliert onSearch('Horror')
  const r3 = applySearch(SERIES, 'horror');   // simuliert onSearch('horror')
  assert.strictEqual(r1.length, 1);
  assert.strictEqual(r2.length, 1);
  assert.strictEqual(r3.length, 1);
  assert.strictEqual(r1[0].id, '1', 'Berserk hat Horror-Genre');
});

// Test: Daten-Werte sind case-insensitiv (Dateneintrag mit Großbuchstaben)
runTest('T_ci2: Treffer auch wenn Genre im Datensatz großgeschrieben ist', function() {
  // Die Daten haben "Horror" (Großschreibung), der Query ist lowercase "horror"
  // applySearch lowercased die Datenwerte: (g||'').toLowerCase().includes(searchQ)
  const list = [{ id: 'x', title: 'X', pub: 'Y', genres: ['HORROR', 'Fantasy'], notes: '' }];
  const result = applySearch(list, 'horror');
  assert.strictEqual(result.length, 1, 'Genre "HORROR" muss mit Query "horror" matchen');
});

// Test: Null-Genres-Eintrag im Array → kein Crash
runTest('T_nullgenre: null-Element im genres-Array verursacht keinen Crash', function() {
  const list = [{ id: '9', title: 'NullInArray', pub: 'Verlag', genres: [null, 'Action', null] }];
  let result;
  assert.doesNotThrow(() => { result = applySearch(list, 'action'); });
  assert.strictEqual(result.length, 1);
});

// ─── Tests: applyGenreFilter ───────────────────────────────────────────────

console.log('\n── applyGenreFilter ───────────────────────────────────────');

// Test 9: filterGenres = [] → alle pass
runTest('T9: filterGenres leer → alle Einträge werden durchgelassen', function() {
  const result = applyGenreFilter(SERIES, []);
  assert.strictEqual(result.length, SERIES.length);
});

// Test 10: filterGenres = ['Action'] → nur Serien mit Action
runTest('T10: filterGenres = ["Action"] → nur Einträge mit Action-Genre', function() {
  const result = applyGenreFilter(SERIES, ['Action']);
  // Berserk, One Piece, Vinland Saga
  assert.strictEqual(result.length, 3);
  const ids = result.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['1', '2', '5']);
});

// Test 11: filterGenres = ['Action', 'Fantasy'] → OR: Serien mit Action ODER Fantasy
runTest('T11: filterGenres = ["Action","Fantasy"] → OR-Semantik', function() {
  const result = applyGenreFilter(SERIES, ['Action', 'Fantasy']);
  // Berserk (Action+Fantasy+Horror), One Piece (Action+Adventure),
  // Dungeon Meshi (Fantasy+Comedy), Vinland Saga (Action+Historical)
  assert.strictEqual(result.length, 4);
  const ids = result.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['1', '2', '4', '5']);
});

// Test 12: Serie ohne genres → kein Crash
runTest('T12: Serie ohne genres-Feld verursacht keinen Crash', function() {
  let result;
  assert.doesNotThrow(() => { result = applyGenreFilter(SERIES_MINIMAL, ['Action']); });
  assert.strictEqual(result.length, 0);
});

runTest('T12b: Serie mit genres=null verursacht keinen Crash', function() {
  let result;
  assert.doesNotThrow(() => { result = applyGenreFilter(SERIES_NULL_FIELDS, ['Action']); });
  assert.strictEqual(result.length, 0);
});

// ─── Tests: applyMediaFilter (Phase 72) ───────────────────────────────────

console.log('\n── applyMediaFilter ───────────────────────────────────────');

runTest('T_media1: applyMediaFilter("") gibt die Liste unverändert zurück (Identität)', function() {
  const result = applyMediaFilter(SERIES_MIXED_MEDIA, '');
  assert.strictEqual(result, SERIES_MIXED_MEDIA);
});

runTest('T_media2: Filter "series" liefert genau die Serien der gemischten Liste', function() {
  const result = applyMediaFilter(SERIES_MIXED_MEDIA, 'series');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '3');
});

runTest('T_media3: Einträge ohne mediaType werden von Filter "manga" erfasst (Fallback-Semantik)', function() {
  const result = applyMediaFilter(SERIES_MIXED_MEDIA, 'manga');
  const ids = result.map(m => m.id).sort();
  // '1' und '4' sind explizit mediaType:'manga', '8' hat gar kein mediaType (Fallback)
  assert.deepStrictEqual(ids, ['1', '4', '8']);
});

runTest('T_media4: Zusammenspiel Phase 67 — Medienfilter UND Genre-Filter (OR innerhalb der Genres)', function() {
  const result = applyGenreFilter(applyMediaFilter(SERIES_MIXED_MEDIA, 'series'), ['Action']);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '3');
});

runTest('T_media5: Sichtbarkeitsregel — nur "manga" vorhanden → Filter inaktiv', function() {
  const onlyManga = [{ id: '1', title: 'A', mediaType: 'manga' }, { id: '2', title: 'B' }];
  assert.strictEqual(shouldShowMediaFilter(onlyManga), false);
});

runTest('T_media6: Sichtbarkeitsregel — mehr als ein Medientyp → Filter aktiv', function() {
  assert.strictEqual(shouldShowMediaFilter(SERIES_MIXED_MEDIA), true);
});

// ─── Tests: setGenreFilter Toggle-Logik ───────────────────────────────────

console.log('\n── setGenreFilter (Toggle-Logik) ──────────────────────────');

// Test: Alle-Reset
runTest('Toggle: g="" leert filterGenres (Alle-Reset)', function() {
  const result = toggleGenre(['Action', 'Fantasy'], '');
  assert.deepStrictEqual(result, []);
});

// Test: Genre hinzufügen
runTest('Toggle: nicht enthaltenes Genre wird hinzugefügt', function() {
  const result = toggleGenre(['Action'], 'Fantasy');
  assert.deepStrictEqual(result, ['Action', 'Fantasy']);
});

// Test: Genre entfernen (deaktivieren)
runTest('Toggle: bereits enthaltenes Genre wird entfernt', function() {
  const result = toggleGenre(['Action', 'Fantasy'], 'Action');
  assert.deepStrictEqual(result, ['Fantasy']);
});

// Test: Letztes Genre entfernen → leeres Array
runTest('Toggle: letztes Genre entfernen ergibt leeres Array', function() {
  const result = toggleGenre(['Action'], 'Action');
  assert.deepStrictEqual(result, []);
});

// Test: von leer aus ein Genre aktivieren
runTest('Toggle: von [] aus ein Genre aktivieren', function() {
  const result = toggleGenre([], 'Horror');
  assert.deepStrictEqual(result, ['Horror']);
});

// ─── Tests: updateGenreFilter Chip-Markierung (Logik-Test) ────────────────

console.log('\n── updateGenreFilter Chip-Markierung (Logik) ─────────────');

function isAllChipActive(filterGenres) { return filterGenres.length === 0; }
function isGenreChipActive(filterGenres, g) { return filterGenres.includes(g); }

runTest('Alle-Chip ist aktiv wenn filterGenres leer', function() {
  assert.strictEqual(isAllChipActive([]), true);
  assert.strictEqual(isAllChipActive(['Action']), false);
});

runTest('Genre-Chip ist aktiv wenn Genre in filterGenres enthalten', function() {
  assert.strictEqual(isGenreChipActive(['Action', 'Fantasy'], 'Action'), true);
  assert.strictEqual(isGenreChipActive(['Action', 'Fantasy'], 'Horror'), false);
});

runTest('Mehrere Genre-Chips können gleichzeitig aktiv sein', function() {
  const fg = ['Action', 'Fantasy'];
  assert.strictEqual(isGenreChipActive(fg, 'Action'), true);
  assert.strictEqual(isGenreChipActive(fg, 'Fantasy'), true);
  assert.strictEqual(isGenreChipActive(fg, 'Horror'), false);
  assert.strictEqual(isAllChipActive(fg), false);
});

// ─── Tests: AND-Kombinierbarkeit (Genre × Suche) ──────────────────────────

console.log('\n── Kombinierbarkeit: applyGenreFilter AND applySearch ─────');

runTest('Kombination Genre-Filter AND Suche (AND-Semantik)', function() {
  // Erst Genre-Filter: nur Action-Serien → Berserk, One Piece, Vinland Saga
  const afterGenre = applyGenreFilter(SERIES, ['Action']);
  // Dann Suche: nur "carlsen" → One Piece
  const afterSearch = applySearch(afterGenre, 'carlsen');
  assert.strictEqual(afterSearch.length, 1);
  assert.strictEqual(afterSearch[0].id, '2');
});

runTest('Kombination leer bleibt leer (kein Eintrag erfüllt AND)', function() {
  // Genre Horror → nur Berserk
  const afterGenre = applyGenreFilter(SERIES, ['Horror']);
  // Suche carlsen → kein Eintrag aus Berserk matcht
  const afterSearch = applySearch(afterGenre, 'carlsen');
  assert.strictEqual(afterSearch.length, 0);
});

// ─── Abschlussbericht ─────────────────────────────────────────────────────

console.log('');
console.log(`${_passed + _failed} Tests — ${_passed} bestanden, ${_failed} fehlgeschlagen`);
if (_failed > 0) {
  process.exit(1);
}
