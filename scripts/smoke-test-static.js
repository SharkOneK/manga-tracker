'use strict';

/**
 * smoke-test-static.js — Phase 16
 *
 * Prueft die statische Grundstruktur des Projekts:
 *   - index.html vorhanden und lesbar
 *   - Keine Merge-Konflikt-Marker
 *   - Wichtige DOM-IDs vorhanden
 *   - Lokale Script-Referenzen vorhanden und Dateien existieren
 *   - data/release-cache.json vorhanden und parsebar
 *   - Keine Merge-Konflikt-Marker in JS-Quelldateien
 *
 * Aufruf: node scripts/smoke-test-static.js
 * Exit 0 = OK, Exit 1 = Fehler
 */

const fs   = require('fs');
const path = require('path');

const repoRoot    = path.resolve(__dirname, '..');
let   totalErrors = 0;

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.error('  ✗ ' + msg); totalErrors++; }

// ── index.html ─────────────────────────────────────────────────────────────
const htmlPath = path.join(repoRoot, 'index.html');
console.log('\nPrüfe: index.html\n');

if (!fs.existsSync(htmlPath)) {
  fail('index.html nicht gefunden');
  console.error('\n❌ Smoke-Test fehlgeschlagen (index.html fehlt)\n');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf-8');
pass('index.html vorhanden');

// ── Merge-Konflikt-Marker in index.html ───────────────────────────────────
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];
let   conflictHits     = 0;
CONFLICT_MARKERS.forEach(marker => {
  if (html.includes(marker)) {
    fail('Merge-Konflikt-Marker in index.html: "' + marker + '"');
    conflictHits++;
  }
});
if (conflictHits === 0) pass('Keine Merge-Konflikt-Marker in index.html');

// ── Pflicht-IDs ────────────────────────────────────────────────────────────
const REQUIRED_IDS = [
  'tabs',
  'content',
  'overlay',
  'toast',
  'sync-dot',
  'btn-add',
  'readonly-banner',
  'modal',
  'modal-title',
  'c-reading',
  'c-buy',
  'c-kalender',
];

let idErrors = 0;
REQUIRED_IDS.forEach(id => {
  if (!html.includes('id="' + id + '"')) {
    fail('Pflicht-ID fehlt in index.html: id="' + id + '"');
    idErrors++;
  }
});
if (idErrors === 0) pass('Alle ' + REQUIRED_IDS.length + ' Pflicht-IDs vorhanden');

// ── Favicon ────────────────────────────────────────────────────────────────
const faviconLinkRe = /<link[^>]+rel=["']icon["'][^>]*>/i;
if (!faviconLinkRe.test(html)) {
  fail('Kein <link rel="icon"> in index.html gefunden');
} else {
  const faviconHrefMatch = html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']icon["']/i);
  if (faviconHrefMatch) {
    const ref = faviconHrefMatch[1];
    const filePath = path.join(repoRoot, ref.replace(/^\.\//, ''));
    if (!fs.existsSync(filePath)) {
      fail('Favicon-Datei nicht gefunden: ' + ref);
    } else {
      pass('Favicon verlinkt und Datei vorhanden: ' + ref);
    }
  } else {
    pass('Favicon <link rel="icon"> vorhanden');
  }
}

// ── Lokale Script-Referenzen ───────────────────────────────────────────────
const LOCAL_SCRIPTS = [
  './src/utils.js',
  './src/supabase.js',
  './src/app.js',
];

let scriptErrors = 0;
LOCAL_SCRIPTS.forEach(ref => {
  if (!html.includes('src="' + ref + '"')) {
    fail('Script-Tag fehlt in index.html: src="' + ref + '"');
    scriptErrors++;
  }
  const filePath = path.join(repoRoot, ref.replace(/^\.\//, ''));
  if (!fs.existsSync(filePath)) {
    fail('Script-Datei nicht gefunden: ' + ref);
    scriptErrors++;
  }
});
if (scriptErrors === 0) pass('Alle ' + LOCAL_SCRIPTS.length + ' lokalen Script-Referenzen vorhanden und Dateien existieren');

// ── Merge-Konflikt-Marker in JS-Quelldateien ───────────────────────────────
const JS_SOURCES = [
  'src/app.js',
  'src/utils.js',
  'src/supabase.js',
];

console.log('\nPrüfe: JS-Quelldateien\n');
JS_SOURCES.forEach(rel => {
  const filePath = path.join(repoRoot, rel);
  if (!fs.existsSync(filePath)) {
    fail(rel + ': Datei nicht gefunden');
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  let hits = 0;
  CONFLICT_MARKERS.forEach(marker => {
    if (content.includes(marker)) {
      fail('Merge-Konflikt-Marker in ' + rel + ': "' + marker + '"');
      hits++;
    }
  });
  if (hits === 0) pass(rel + ': keine Konflikt-Marker');
});

// ── data/release-cache.json ────────────────────────────────────────────────
const cachePath = path.join(repoRoot, 'data', 'release-cache.json');
console.log('\nPrüfe: data/release-cache.json\n');

if (!fs.existsSync(cachePath)) {
  fail('data/release-cache.json nicht gefunden');
} else {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    pass('data/release-cache.json vorhanden und parsebar');
  } catch (e) {
    fail('data/release-cache.json ist kein gültiges JSON: ' + e.message);
    cache = null;
  }
  if (cache !== null) {
    if (cache.schemaVersion !== 1) {
      fail('release-cache.json schemaVersion erwartet 1, erhalten: ' + JSON.stringify(cache.schemaVersion));
    } else {
      pass('schemaVersion: 1');
    }
    if (!Array.isArray(cache.items)) {
      fail('release-cache.json "items" ist kein Array');
    } else {
      pass('items: Array mit ' + cache.items.length + ' Einträgen');
    }
  }
}

// ── Phase 18f: Dashboard-Kaufvorschau und Kaufen-Sortierung ───────────────────
const appJsPath = path.join(repoRoot, 'src', 'app.js');
console.log('\nPrüfe: Phase 18f — Dashboard-Kaufvorschau und Sortierung\n');

if (fs.existsSync(appJsPath)) {
  const appJs = fs.readFileSync(appJsPath, 'utf-8');

  // Keine Merge-Konflikt-Marker
  let appConflicts = 0;
  CONFLICT_MARKERS.forEach(marker => {
    if (appJs.includes(marker)) {
      fail('Merge-Konflikt-Marker in src/app.js: "' + marker + '"');
      appConflicts++;
    }
  });
  if (appConflicts === 0) pass('src/app.js: keine Merge-Konflikt-Marker');

  // BUY_PREVIEW_MAX vorhanden
  if (!appJs.includes('BUY_PREVIEW_MAX')) {
    fail('src/app.js: BUY_PREVIEW_MAX fehlt');
  } else {
    pass('src/app.js: BUY_PREVIEW_MAX vorhanden');
  }

  // compareBuyEntries-Funktion vorhanden
  if (!appJs.includes('compareBuyEntries')) {
    fail('src/app.js: compareBuyEntries-Funktion fehlt');
  } else {
    pass('src/app.js: compareBuyEntries-Funktion vorhanden');
  }

  // Alle Käufe anzeigen-Button vorhanden
  if (!appJs.includes('Alle Käufe anzeigen')) {
    fail('src/app.js: „Alle Käufe anzeigen"-Button fehlt');
  } else {
    pass('src/app.js: „Alle Käufe anzeigen"-Button vorhanden');
  }

  // Zusammenfassung-Marker vorhanden
  if (!appJs.includes('stats-buy-summary')) {
    fail('src/app.js: stats-buy-summary-Element fehlt');
  } else {
    pass('src/app.js: stats-buy-summary-Element vorhanden');
  }

  // Strukturierte Vorschau-Sektionen vorhanden
  if (!appJs.includes('stats-buy-section-head')) {
    fail('src/app.js: stats-buy-section-head fehlt');
  } else {
    pass('src/app.js: stats-buy-section-head vorhanden');
  }

  // Keine neuen externen Script-Tags durch Phase 18f
  const scriptTagRe = /<script[^>]+src=["'][^"']*["']/g;
  const matches = appJs.match(scriptTagRe) || [];
  if (matches.length === 0) {
    pass('src/app.js: keine externen Script-Tags eingefügt');
  }
} else {
  fail('src/app.js nicht gefunden');
}

// ── Phase 19: Release-Cache-Abdeckung und Missing-Report ──────────────────
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'update-release-cache.yml');
console.log('\nPrüfe: Phase 19 — Release-Watchlist und Cache-Coverage\n');

// data/release-watchlist.json
const watchlistPath = path.join(repoRoot, 'data', 'release-watchlist.json');
if (!fs.existsSync(watchlistPath)) {
  fail('data/release-watchlist.json nicht gefunden');
} else {
  pass('data/release-watchlist.json vorhanden');
}

// scripts/validate-release-watchlist.js
const validateWatchlistPath = path.join(repoRoot, 'scripts', 'validate-release-watchlist.js');
if (!fs.existsSync(validateWatchlistPath)) {
  fail('scripts/validate-release-watchlist.js nicht gefunden');
} else {
  pass('scripts/validate-release-watchlist.js vorhanden');
}

// scripts/audit-release-cache-coverage.js
const auditCoveragePath = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');
if (!fs.existsSync(auditCoveragePath)) {
  fail('scripts/audit-release-cache-coverage.js nicht gefunden');
} else {
  pass('scripts/audit-release-cache-coverage.js vorhanden');
}

// Workflow-Datei enthält validate-release-watchlist
if (!fs.existsSync(workflowPath)) {
  fail('update-release-cache.yml nicht gefunden');
} else {
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  if (!workflowContent.includes('validate-release-watchlist')) {
    fail('update-release-cache.yml enthält keinen validate-release-watchlist Step');
  } else {
    pass('update-release-cache.yml: validate-release-watchlist Step vorhanden');
  }
  if (!workflowContent.includes('audit-release-cache-coverage')) {
    fail('update-release-cache.yml enthält keinen audit-release-cache-coverage Step');
  } else {
    pass('update-release-cache.yml: audit-release-cache-coverage Step vorhanden');
  }
}

// src/app.js enthält Cache-Miss-Report-Marker
if (fs.existsSync(appJsPath)) {
  const appJsPhase19 = fs.readFileSync(appJsPath, 'utf-8');
  if (!appJsPhase19.includes('cache-miss-report') && !appJsPhase19.includes('cacheMissReport')) {
    fail('src/app.js: Cache-Miss-Report-Marker fehlt (cache-miss-report oder cacheMissReport)');
  } else {
    pass('src/app.js: Cache-Miss-Report-Marker vorhanden');
  }
  if (!appJsPhase19.includes('watchlist')) {
    fail('src/app.js: Watchlist-Marker fehlt');
  } else {
    pass('src/app.js: Watchlist-Marker vorhanden');
  }
} else {
  fail('src/app.js nicht gefunden (bereits oben gemeldet)');
}

// ── Phase 20: App-Modus, Datenintegrität und Release-Utils ─────────────────
console.log('\nPrüfe: Phase 20 — App-Modus und Datenintegrität\n');

// src/release-utils.js existiert
const releaseUtilsPath = path.join(repoRoot, 'src', 'release-utils.js');
if (!fs.existsSync(releaseUtilsPath)) {
  fail('src/release-utils.js nicht gefunden');
} else {
  pass('src/release-utils.js vorhanden');
}

// index.html enthält release-utils.js
if (!html.includes('release-utils.js')) {
  fail('index.html enthält keinen Script-Tag für release-utils.js');
} else {
  pass('index.html: release-utils.js Script-Tag vorhanden');
}

// app.js enthält die neuen App-Modus-Funktionen und Guards
if (fs.existsSync(appJsPath)) {
  const appJsPhase20 = fs.readFileSync(appJsPath, 'utf-8');

  const checks = [
    ['getAppMode',           'getAppMode'],
    ['canEditLocal',         'canEditLocal'],
    ['canWriteCloud',        'canWriteCloud'],
    ['mergePreservedFields', 'mergePreservedFields'],
    ['safeHttpsUrl',         'safeHttpsUrl'],
    ['isUuid',               'isUuid'],
  ];

  checks.forEach(function(pair) {
    const label = pair[0];
    const token = pair[1];
    if (!appJsPhase20.includes(token)) {
      fail('src/app.js: ' + label + ' fehlt');
    } else {
      pass('src/app.js: ' + label + ' vorhanden');
    }
  });
} else {
  fail('src/app.js nicht gefunden (bereits oben gemeldet)');
}

// scripts/test-data-integrity.js existiert
const integrityTestPath = path.join(repoRoot, 'scripts', 'test-data-integrity.js');
if (!fs.existsSync(integrityTestPath)) {
  fail('scripts/test-data-integrity.js nicht gefunden');
} else {
  pass('scripts/test-data-integrity.js vorhanden');
}

// ── Ergebnis ───────────────────────────────────────────────────────────────
console.log('');
if (totalErrors > 0) {
  console.error('❌ Smoke-Test fehlgeschlagen — ' + totalErrors + ' Fehler\n');
  process.exit(1);
} else {
  console.log('✅ Smoke-Test bestanden\n');
  process.exit(0);
}
