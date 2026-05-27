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

function hasInlineHandler(content, handlerName) {
  const re = new RegExp('<[^>]*\\s' + handlerName + '\\s*=', 'i');
  return re.test(content);
}

function getCspContent(content) {
  const cspMatch = content.match(/Content-Security-Policy[^>]*content="([^"]+)"/i);
  return cspMatch ? cspMatch[1] : '';
}

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
  if (!/Watchlist|Review-Queue|Pipeline/.test(appJsPhase19)) {
    fail('src/app.js: Diagnose-/Pipeline-Marker fehlt');
  } else {
    pass('src/app.js: Diagnose-/Pipeline-Marker vorhanden');
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

// ── Phase 21: Sicherheits-Härtung ──────────────────────────────────────────
console.log('\nPrüfe: Phase 21 — Sicherheits-Härtung\n');

// scripts/security-audit-static.js existiert
const securityAuditPath = path.join(repoRoot, 'scripts', 'security-audit-static.js');
if (!fs.existsSync(securityAuditPath)) {
  fail('scripts/security-audit-static.js nicht gefunden');
} else {
  pass('scripts/security-audit-static.js vorhanden');
}

// vendor/jszip.min.js existiert
const jszipPath = path.join(repoRoot, 'vendor', 'jszip.min.js');
if (!fs.existsSync(jszipPath)) {
  fail('vendor/jszip.min.js nicht gefunden');
} else {
  pass('vendor/jszip.min.js vorhanden');
}

// docs/security.md existiert
const securityMdPath = path.join(repoRoot, 'docs', 'security.md');
if (!fs.existsSync(securityMdPath)) {
  fail('docs/security.md nicht gefunden');
} else {
  pass('docs/security.md vorhanden');
}

// index.html enthält Content-Security-Policy
if (!html.includes('Content-Security-Policy')) {
  fail('index.html enthält keine Content-Security-Policy');
} else {
  pass('index.html: Content-Security-Policy vorhanden');
}

// ── Phase 21c: Event-Delegation und CSP ohne script unsafe-inline ──────────
console.log('\nPrüfe: Phase 21c — Event-Delegation und CSP\n');

['onclick', 'oninput', 'onchange'].forEach(function(handlerName) {
  if (hasInlineHandler(html, handlerName)) {
    fail('index.html enthält noch Inline-Handler: ' + handlerName + '=');
  } else {
    pass('index.html enthält kein ' + handlerName + '=');
  }
});

const cspContent = getCspContent(html);
if (!cspContent.includes("script-src 'self'")) {
  fail("CSP enthält nicht script-src 'self'");
} else {
  pass("CSP enthält script-src 'self'");
}

if (cspContent.includes("script-src 'self' 'unsafe-inline'")) {
  fail("CSP enthält weiterhin script-src 'self' 'unsafe-inline'");
} else {
  pass("CSP enthält kein script-src 'self' 'unsafe-inline'");
}

const requiredTabs = ['reading', 'completed', 'owned', 'wishlist', 'buy', 'kalender', 'dashboard'];
let tabErrors = 0;
requiredTabs.forEach(function(tabName) {
  if (!html.includes('data-tab="' + tabName + '"')) {
    fail('Tab data-tab fehlt: ' + tabName);
    tabErrors++;
  }
});
if (tabErrors === 0) pass('Alle Tabs haben weiterhin data-tab');

const importantActionMarkers = [
  'id="btn-add"',
  'data-action="open-add"',
  'id="btn-share-profile"',
  'data-action="share-profile"',
  'data-action="clear-search"',
  'data-view="series"',
  'data-view="volumes"',
  'data-action="close-modal"',
  'data-action="do-save"',
];
let actionMarkerErrors = 0;
importantActionMarkers.forEach(function(marker) {
  if (!html.includes(marker)) {
    fail('Wichtiger Button-/Event-Marker fehlt: ' + marker);
    actionMarkerErrors++;
  }
});
if (actionMarkerErrors === 0) pass('Wichtige Buttons besitzen id, data-action oder data-view');

// ── Phase 22: Sammlungsweite Release-Cache-Coverage ────────────────────────
console.log('\nPrüfe: Phase 22 — Sammlungsweite Release-Cache-Coverage\n');

if (fs.existsSync(appJsPath)) {
  const appJs22 = fs.readFileSync(appJsPath, 'utf-8');

  // Phase 44a-followup: Dashboard-Button "Cache-Coverage prüfen" sowie die
  // Helfer `buildReleaseCacheCoverageReport`, `copyReleaseCacheCoverageBatch`,
  // `renderReleaseCacheCoveragePreview` sind weg. Source-Gaps werden zentral
  // ueber Watchlist/Review-Queue und die GitHub-Action-Pipeline gepflegt.
  if (appJs22.includes('buildReleaseCacheCoverageReport')
      || appJs22.includes('copyReleaseCacheCoverageBatch')
      || appJs22.includes('renderReleaseCacheCoveragePreview')) {
    fail('src/app.js: lokale Cache-Coverage-Helfer dürfen nach Phase 44a-followup nicht mehr vorhanden sein');
  } else {
    pass('src/app.js: lokale Cache-Coverage-Helfer nach Phase 44a-followup entfernt');
  }

  if (appJs22.includes('data-action="check-release-coverage"')
      || appJs22.includes('data-action="copy-coverage-batch"')
      || appJs22.includes('data-action="run-dashboard-release-date-check"')
      || appJs22.includes('data-action="run-dashboard-series-status-check"')
      || appJs22.includes('data-action="apply-dashboard-release-dates"')) {
    fail('src/app.js: entfernte Dashboard-Aktionen dürfen nach Phase 44a-followup nicht mehr referenziert sein');
  } else {
    pass('src/app.js: entfernte Dashboard-Aktionen ("Alle Release-Daten prüfen", "Alle Serien-Status prüfen", "Cache-Coverage prüfen") aus UI entfernt');
  }

  if (appJs22.includes('id="release-coverage-preview"')
      || appJs22.includes("id='release-coverage-preview'")) {
    fail('src/app.js: release-coverage-preview id sollte nach Phase 44a-followup nicht mehr vorhanden sein');
  } else {
    pass('src/app.js: release-coverage-preview id nach Phase 44a-followup entfernt');
  }

  // CSP Phase 21c bleibt erhalten (bereits oben geprüft, nochmals bestätigen)
  const html22 = fs.readFileSync(htmlPath, 'utf-8');
  const csp22 = getCspContent(html22);
  if (!csp22.includes("script-src 'self'")) {
    fail("Phase 22 CSP-Prüfung: script-src 'self' fehlt");
  } else {
    pass("Phase 22 CSP-Prüfung: script-src 'self' weiterhin vorhanden");
  }
  if (csp22.includes("script-src 'self' 'unsafe-inline'") || csp22.match(/script-src[^;]*'unsafe-inline'/)) {
    fail("Phase 22 CSP-Prüfung: script-src enthält unsafe-inline");
  } else {
    pass("Phase 22 CSP-Prüfung: script-src enthält kein unsafe-inline");
  }
} else {
  fail('src/app.js nicht gefunden (Phase 22)');
}

// validate-release-watchlist.js enthält volumeNumbers-Support
const validatePath22 = path.join(repoRoot, 'scripts', 'validate-release-watchlist.js');
if (fs.existsSync(validatePath22)) {
  const validateContent = fs.readFileSync(validatePath22, 'utf-8');
  if (!validateContent.includes('volumeNumbers')) {
    fail('scripts/validate-release-watchlist.js: volumeNumbers-Unterstützung fehlt');
  } else {
    pass('scripts/validate-release-watchlist.js: volumeNumbers-Unterstützung vorhanden');
  }
} else {
  fail('scripts/validate-release-watchlist.js nicht gefunden (Phase 22)');
}

// update-release-cache.js enthält volumeNumbers-Expansion
const updateCachePath22 = path.join(repoRoot, 'scripts', 'update-release-cache.js');
if (fs.existsSync(updateCachePath22)) {
  const updateContent = fs.readFileSync(updateCachePath22, 'utf-8');
  if (!updateContent.includes('volumeNumbers')) {
    fail('scripts/update-release-cache.js: volumeNumbers-Expansion fehlt');
  } else {
    pass('scripts/update-release-cache.js: volumeNumbers-Expansion vorhanden');
  }
} else {
  fail('scripts/update-release-cache.js nicht gefunden (Phase 22)');
}

// audit-release-cache-coverage.js enthält volumeNumbers-Expansion
const auditPath22 = path.join(repoRoot, 'scripts', 'audit-release-cache-coverage.js');
if (fs.existsSync(auditPath22)) {
  const auditContent = fs.readFileSync(auditPath22, 'utf-8');
  if (!auditContent.includes('volumeNumbers')) {
    fail('scripts/audit-release-cache-coverage.js: volumeNumbers-Expansion fehlt');
  } else {
    pass('scripts/audit-release-cache-coverage.js: volumeNumbers-Expansion vorhanden');
  }
  if (!auditContent.includes('--json') || !auditContent.includes('missingBySeries') || !auditContent.includes('source-data-gap')) {
    fail('scripts/audit-release-cache-coverage.js: Phase-22c-JSON-Klassifizierung fehlt');
  } else {
    pass('scripts/audit-release-cache-coverage.js: Phase-22c-JSON-Klassifizierung vorhanden');
  }
} else {
  fail('scripts/audit-release-cache-coverage.js nicht gefunden (Phase 22)');
}

// Phase 22d: Coverage-Gap-Validator existiert
const gapsValidatorPath = path.join(repoRoot, 'scripts', 'validate-release-cache-coverage-gaps.js');
if (!fs.existsSync(gapsValidatorPath)) {
  fail('scripts/validate-release-cache-coverage-gaps.js nicht gefunden');
} else {
  const validatorContent = fs.readFileSync(gapsValidatorPath, 'utf-8');
  if (!validatorContent.includes('source-data-gap') || !validatorContent.includes('audit-release-cache-coverage.js')) {
    fail('scripts/validate-release-cache-coverage-gaps.js: Phase-22d-Pruefung unvollstaendig');
  } else {
    pass('scripts/validate-release-cache-coverage-gaps.js vorhanden');
  }
}

// docs/release-cache.md existiert
const releaseCacheMdPath = path.join(repoRoot, 'docs', 'release-cache.md');
if (!fs.existsSync(releaseCacheMdPath)) {
  fail('docs/release-cache.md nicht gefunden');
} else {
  pass('docs/release-cache.md vorhanden');
}

// docs/release-cache-coverage-gaps.md existiert und dokumentiert source-data-gap
const coverageGapsMdPath = path.join(repoRoot, 'docs', 'release-cache-coverage-gaps.md');
if (!fs.existsSync(coverageGapsMdPath)) {
  fail('docs/release-cache-coverage-gaps.md nicht gefunden');
} else {
  const coverageGapsMd = fs.readFileSync(coverageGapsMdPath, 'utf-8');
  if (!coverageGapsMd.includes('source-data-gap') || !coverageGapsMd.includes('Verbleibende Luecken')) {
    fail('docs/release-cache-coverage-gaps.md dokumentiert Phase-22d-Gaps nicht ausreichend');
  } else {
    pass('docs/release-cache-coverage-gaps.md vorhanden');
  }
}

// ── Ergebnis ───────────────────────────────────────────────────────────────
// ── Phase 26: Release-Provider und Dashboard-Aktionszentrale ───────────────
console.log('\nPruefe: Phase 26 - Release-Provider und Dashboard-Aktionszentrale\n');

[
  'scripts/release-providers/index.js',
  'scripts/release-providers/provider-utils.js',
  'scripts/release-providers/manga-passion-provider.js',
  'docs/release-provider-system.md',
].forEach(rel => {
  const target = path.join(repoRoot, rel);
  if (!fs.existsSync(target)) fail(rel + ' nicht gefunden');
  else pass(rel + ' vorhanden');
});

const appJs26 = fs.readFileSync(appJsPath, 'utf-8');
if (html.includes('id="btn-mp-sync"')) {
  fail('index.html: btn-mp-sync muss aus der Suchleiste entfernt sein');
} else {
  pass('index.html: btn-mp-sync aus Suchleiste entfernt');
}

if (!appJs26.includes('Aktionszentrale:') || !appJs26.includes('Alle Band-Cover laden')) {
  fail('src/app.js: Dashboard-Aktionszentrale oder Cover-Sync-Button fehlt');
} else {
  pass('src/app.js: Dashboard-Aktionszentrale mit Cover-Sync vorhanden');
}

console.log('\nPruefe: Phase 34 - Lokale Release-Coverage-Pending-Queue\n');

if (!appJs26.includes('mtReleaseCoveragePending') || !appJs26.includes('maybeRunLocalReleaseCoverageCheck')) {
  fail('src/app.js: Marker fuer lokale Pending-Queue-Funktion fehlen');
} else {
  pass('src/app.js: lokale Pending-Queue-Funktion vorhanden');
}

if (!appJs26.includes('Neue Release-Coverage-Kandidaten') || !appJs26.includes('local-release-coverage-pending')) {
  fail('src/app.js: Dashboard-Hinweis/Section fuer lokale Pending-Queue fehlt');
} else {
  pass('src/app.js: Dashboard-Hinweis/Section fuer lokale Pending-Queue vorhanden');
}

if (/fetch\([^)]*release-watchlist\.json[^)]*\)\s*\.(then\([^)]*\)\s*)?[^;]*(PUT|POST|PATCH|DELETE)/i.test(appJs26)) {
  fail('src/app.js: direkter Schreibzugriff auf data/release-watchlist.json aus Browser-App gefunden');
} else {
  pass('src/app.js: kein direkter Schreibzugriff auf data/release-watchlist.json');
}

if (/api\.github\.com|repos\/[^/]+\/[^/]+\/contents|createOrUpdateFileContents/i.test(appJs26)) {
  fail('src/app.js: GitHub-API-Schreiblogik im Browser gefunden');
} else {
  pass('src/app.js: keine GitHub-API-Schreiblogik im Browser');
}

if (/mtReleaseCoveragePending[\s\S]{0,240}(pushCloud|persist|supabase\.(from|rpc)|PATCH|POST)/.test(appJs26)) {
  fail('src/app.js: moegliche Supabase-/Persist-Schreiblogik fuer Pending-Coverage gefunden');
} else {
  pass('src/app.js: keine Supabase-/Persist-Schreiblogik fuer Pending-Coverage');
}


console.log('\nPruefe: Phase 35 - Pending-Intake aus lokaler Queue\n');

[
  ['Dashboard-Text', 'Neue Release-Coverage-Kandidaten'],
  ['Sanitizer-Batch', 'buildSanitizedPendingWatchlistBatch'],
  ['Copy-Funktion', 'copySanitizedPendingWatchlistBatch'],
  ['Gruppierung', 'groupPendingCoverageCandidates'],
  ['lokaler/sanitisierter Export-Hinweis', 'Lokaler, sanitisierter Export'],
  ['keine automatische Veroeffentlichung', 'keine automatische Veröffentlichung'],
  ['Phase-37-Wishlist-Coverage-Marker', 'Phase 37: Wishlist-Serien sind jetzt gültige Coverage-Kandidaten'],
  ['Phase-44c-Cover-Preserve-Marker', 'Phase 44c: Der technische Serien-Cover-URL-Fallback ist kein Formularfeld mehr.'],
].forEach(([label, marker]) => {
  if (!appJs26.includes(marker)) fail('src/app.js: Phase-35-Marker fehlt: ' + label);
  else pass('src/app.js: Phase-35-Marker vorhanden: ' + label);
});

if (/fetch\([^)]*release-watchlist\.json[^)]*\)[\s\S]{0,160}\b(PUT|POST|PATCH|DELETE)\b/i.test(appJs26)) {
  fail('src/app.js: direkter Browser-Schreibpfad auf data/release-watchlist.json gefunden');
} else {
  pass('src/app.js: kein direkter Browser-Schreibpfad auf data/release-watchlist.json');
}

if (/fetch\([^)]*release-cache\.json[^)]*\)[\s\S]{0,160}\b(PUT|POST|PATCH|DELETE)\b/i.test(appJs26)) {
  fail('src/app.js: direkter Browser-Schreibpfad auf data/release-cache.json gefunden');
} else {
  pass('src/app.js: kein direkter Browser-Schreibpfad auf data/release-cache.json');
}

console.log('\nPruefe: Phase 44c - Genre/Tags und Cover-Fallback geschuetzt\n');

if (html.includes('id="f-cover"') || html.includes('Cover-Bild URL')) {
  fail('index.html: manuelles Cover-URL-Fallback-Feld ist noch in der Bearbeiten-Maske vorhanden');
} else {
  pass('index.html: manuelles Cover-URL-Fallback-Feld entfernt');
}

if (!html.includes('id="f-cover-auto"')) {
  fail('index.html: Read-only-Cover-Anzeige f-cover-auto fehlt');
} else {
  pass('index.html: Read-only-Cover-Anzeige vorhanden');
}

if (html.includes('id="genre-picker"') || appJs26.includes('data-action="toggle-genre"') || appJs26.includes('function toggleGenre(')) {
  fail('Genre/Tags sind noch als manuelle Picker-Aktion verdrahtet');
} else {
  pass('Genre/Tags-Picker ist aus der Bearbeiten-Maske entfernt');
}

if (!html.includes('id="genre-readout"')) {
  fail('index.html: Read-only-Genre-Anzeige genre-readout fehlt');
} else {
  pass('index.html: Read-only-Genre-Anzeige vorhanden');
}

if (!appJs26.includes('resolveProtectedGenres(existing)') || !appJs26.includes('resolveProtectedCover(existing)')) {
  fail('src/app.js: Phase-44c Preserve-Logik fuer Genres/Cover fehlt');
} else {
  pass('src/app.js: Phase-44c Preserve-Logik fuer Genres/Cover vorhanden');
}

console.log('\nPruefe: Phase 36a - Automatisierter Release-Datum-Intake fuer neue Manga\n');

[
  ['resolveEmptyPublisherPendingCandidates-Funktion', 'function resolveEmptyPublisherPendingCandidates('],
  ['maybeRunLocalReleaseCoverageCheck ruft resolveEmptyPublisher auf', 'resolveEmptyPublisherPendingCandidates(candidate.seriesTitle'],
  ['markBought ruft Coverage-Check auf', 'maybeRunLocalReleaseCoverageCheck(m)'],
  ['Dashboard-Bereit-Hinweis vorhanden', 'release-coverage-ready-notice'],
  ['Dashboard prueft exportierbare Kandidaten', 'exportableCandidates > 0'],
].forEach(([label, marker]) => {
  if (!appJs26.includes(marker)) fail('src/app.js: Phase-36a-Marker fehlt: ' + label);
  else pass('src/app.js: Phase-36a-Marker vorhanden: ' + label);
});

// Phase 36a: resolveEmptyPublisher darf keinen externen Schreibpfad enthalten
const appJs36aStart = appJs26.indexOf('function resolveEmptyPublisherPendingCandidates(');
const appJs36aEnd = appJs26.indexOf('\nfunction ', appJs36aStart + 1);
const appJs36aCode = appJs36aStart >= 0 && appJs36aEnd > appJs36aStart ? appJs26.slice(appJs36aStart, appJs36aEnd) : '';
if (appJs36aCode && /api\.github\.com|release-watchlist\.json|release-cache\.json|pushCloud\s*\(|persist\s*\(/.test(appJs36aCode)) {
  fail('src/app.js: resolveEmptyPublisherPendingCandidates enthält externen Schreibpfad');
} else if (!appJs36aCode) {
  fail('src/app.js: resolveEmptyPublisherPendingCandidates nicht gefunden');
} else {
  pass('src/app.js: resolveEmptyPublisherPendingCandidates enthält keinen externen Schreibpfad');
}

// CSS-Klasse fuer Bereit-Hinweis vorhanden
if (typeof stylesCs !== 'undefined' && stylesCs) {
  if (stylesCs.includes('release-coverage-ready-notice')) pass('src/styles.css: release-coverage-ready-notice CSS-Klasse vorhanden');
  else fail('src/styles.css: release-coverage-ready-notice CSS-Klasse fehlt');
} else {
  // stylesCs könnte nicht gelesen worden sein, Fallback-Check über fs
  const _stylesPath = require('path').join(__dirname, '..', 'src', 'styles.css');
  const _styles = require('fs').existsSync(_stylesPath) ? require('fs').readFileSync(_stylesPath, 'utf8') : '';
  if (_styles.includes('release-coverage-ready-notice')) pass('src/styles.css: release-coverage-ready-notice CSS-Klasse vorhanden');
  else fail('src/styles.css: release-coverage-ready-notice CSS-Klasse fehlt');
}

console.log('');
if (totalErrors > 0) {
  console.error('❌ Smoke-Test fehlgeschlagen — ' + totalErrors + ' Fehler\n');
  process.exit(1);
} else {
  console.log('✅ Smoke-Test bestanden\n');
  process.exit(0);
}
