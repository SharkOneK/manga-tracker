'use strict';

/**
 * security-audit-static.js — Phase 21c
 *
 * Statische Sicherheitsprüfungen für den Manga Tracker.
 * Prüft CSP, Supply-Chain, CI-Konfiguration und Code-Struktur.
 *
 * Aufruf: node scripts/security-audit-static.js
 * Exit 0 = alle Checks bestanden (Warns zählen nicht als Fail),
 * Exit 1 = mindestens ein Check fehlgeschlagen
 */

const fs   = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
let totalChecks = 0;
let totalFailed = 0;
let totalWarns  = 0;

function pass(msg) { console.log('  ✓ ' + msg); totalChecks++; }
function fail(msg) { console.error('  ✗ ' + msg); totalChecks++; totalFailed++; }
function warn(msg) { console.warn('  ⚠ WARN: ' + msg); totalChecks++; totalWarns++; }

function readFile(rel) {
  const fullPath = path.join(repoRoot, rel);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf-8');
}

function fileExists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

// ── Dateien laden ──────────────────────────────────────────────────────────

const html      = readFile('index.html');
const ciYml     = readFile('.github/workflows/ci.yml');
const appJs     = readFile('src/app.js');
const supabaseJs = readFile('src/supabase.js');
const checkSecretsJs = readFile('scripts/check-secrets.js');
const phase27bMigration = readFile('supabase/migrations/phase27b_public_projection_rls_hardening.sql');

console.log('\nSicherheits-Audit (statisch) — Phase 21c\n');

function getCspContent() {
  if (!html) return '';
  const cspMatch = html.match(/Content-Security-Policy[^>]*content="([^"]+)"/i);
  return cspMatch ? cspMatch[1] : '';
}

function getCspDirective(name) {
  const cspContent = getCspContent();
  const re = new RegExp('(?:^|;)\\s*' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s+([^;]+)', 'i');
  const match = cspContent.match(re);
  return match ? match[1].trim() : '';
}

function findInlineHandlers(content) {
  if (!content) return [];
  const matches = [];
  const handlerRe = /<[^>]*\s(on[a-z]+)\s*=/gi;
  let match;
  while ((match = handlerRe.exec(content)) !== null) {
    matches.push(match[1].toLowerCase());
  }
  return matches;
}

function findInlineStyleAttributes(content) {
  if (!content) return [];
  const matches = [];
  const styleRe = /<[^>]*\sstyle\s*=/gi;
  let match;
  while ((match = styleRe.exec(content)) !== null) {
    matches.push(match[0].slice(0, 120).replace(/\s+/g, ' '));
  }
  return matches;
}

// ── Check 1: index.html enthält CSP ───────────────────────────────────────
if (!html) {
  fail('Check 1: index.html nicht gefunden');
} else if (!html.includes('Content-Security-Policy')) {
  fail('Check 1: index.html enthält keine Content-Security-Policy');
} else {
  pass('Check 1: index.html enthält Content-Security-Policy');
}

// ── Check 2: CSP enthält object-src none ──────────────────────────────────
if (!html) {
  fail("Check 2: index.html nicht gefunden (object-src 'none' nicht prüfbar)");
} else if (!html.includes("object-src 'none'")) {
  fail("Check 2: CSP enthält kein object-src 'none'");
} else {
  pass("Check 2: CSP enthält object-src 'none'");
}

// ── Check 3: CSP enthält base-uri self ────────────────────────────────────
if (!html) {
  fail("Check 3: index.html nicht gefunden (base-uri 'self' nicht prüfbar)");
} else if (!html.includes("base-uri 'self'")) {
  fail("Check 3: CSP enthält kein base-uri 'self'");
} else {
  pass("Check 3: CSP enthält base-uri 'self'");
}

// ── Check 4: CSP enthält frame-ancestors none ─────────────────────────────
if (!html) {
  fail("Check 4: index.html nicht gefunden (frame-ancestors 'none' nicht prüfbar)");
} else if (!html.includes("frame-ancestors 'none'")) {
  fail("Check 4: CSP enthält kein frame-ancestors 'none'");
} else {
  pass("Check 4: CSP enthält frame-ancestors 'none'");
}

// ── Check 5: kein externes Script-Tag ohne SRI oder lokales Vendor ─────────
// Erlaubt: vendor/ (lokale Dateien), kein CDN-Script ohne integrity
if (!html) {
  fail('Check 5: index.html nicht gefunden (CDN-Script-Check nicht möglich)');
} else {
  // Suche nach script-Tags mit src
  const scriptTagRe = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  let cdnIssues = 0;
  while ((match = scriptTagRe.exec(html)) !== null) {
    const src = match[1];
    const tag = match[0];
    const isExternal = /^https?:\/\//i.test(src);
    if (isExternal) {
      const hasIntegrity = /integrity=["'][^"']+["']/.test(tag);
      if (!hasIntegrity) {
        fail('Check 5: Externes Script ohne SRI: ' + src);
        cdnIssues++;
      }
    }
  }
  if (cdnIssues === 0) {
    pass('Check 5: Kein externes Script ohne SRI (oder alle Scripte lokal)');
  }
}

// ── Check 6: vendor/jszip.min.js existiert ────────────────────────────────
if (!fileExists('vendor/jszip.min.js')) {
  fail('Check 6: vendor/jszip.min.js nicht gefunden');
} else {
  pass('Check 6: vendor/jszip.min.js vorhanden');
}

// ── Check 7: index.html lädt jszip aus vendor/, nicht CDN ────────────────
if (!html) {
  fail('Check 7: index.html nicht gefunden');
} else if (html.includes('cdn.jsdelivr.net') && html.includes('jszip')) {
  fail('Check 7: index.html lädt JSZip noch von CDN (cdn.jsdelivr.net)');
} else if (!html.includes('./vendor/jszip.min.js') && !html.includes('vendor/jszip.min.js')) {
  fail('Check 7: index.html enthält keinen vendor/jszip.min.js Script-Tag');
} else {
  pass('Check 7: index.html lädt JSZip aus vendor/ (lokal)');
}

// ── Check 8: ci.yml hat permissions: contents: read ──────────────────────
if (!ciYml) {
  fail('Check 8: .github/workflows/ci.yml nicht gefunden');
} else if (!ciYml.includes('permissions') || !ciYml.includes('contents: read')) {
  fail('Check 8: ci.yml hat kein "permissions: contents: read"');
} else {
  pass('Check 8: ci.yml enthält permissions: contents: read');
}

// ── Check 9: app.js hat getAppMode ────────────────────────────────────────
if (!appJs) {
  fail('Check 9: src/app.js nicht gefunden');
} else if (!appJs.includes('getAppMode')) {
  fail('Check 9: src/app.js enthält keine getAppMode-Funktion');
} else {
  pass('Check 9: src/app.js enthält getAppMode');
}

// ── Check 10: app.js hat canEditLocal ─────────────────────────────────────
if (!appJs) {
  fail('Check 10: src/app.js nicht gefunden');
} else if (!appJs.includes('canEditLocal')) {
  fail('Check 10: src/app.js enthält keine canEditLocal-Funktion');
} else {
  pass('Check 10: src/app.js enthält canEditLocal');
}

// ── Check 11: app.js hat isPublicReadOnly ────────────────────────────────
if (!appJs) {
  fail('Check 11: src/app.js nicht gefunden');
} else if (!appJs.includes('isPublicReadOnly')) {
  fail('Check 11: src/app.js enthält keine isPublicReadOnly-Funktion');
} else {
  pass('Check 11: src/app.js enthält isPublicReadOnly');
}

// ── Check 12: supabase.js oder app.js enthält Fragment-Adopt (hash.slice) ─
const hasFragmentAdopt =
  (supabaseJs && supabaseJs.includes('hash.slice')) ||
  (appJs && appJs.includes('hash.slice'));

if (!hasFragmentAdopt) {
  fail('Check 12: weder src/supabase.js noch src/app.js enthält Fragment-Adopt-Logik (hash.slice)');
} else {
  pass('Check 12: Fragment-Adopt-Logik (hash.slice) vorhanden');
}

// ── Check 13: keine Adopt-Query-Links in docs/* und data/* ───────────────
const ADOPT_QUERY_RE = /\?adopt=.*&token=/;
const docsDir  = path.join(repoRoot, 'docs');
const dataDir  = path.join(repoRoot, 'data');
let adoptIssues = 0;

function scanForAdoptQuery(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function(entry) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForAdoptQuery(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.html', '.txt', '.json'].includes(ext)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (ADOPT_QUERY_RE.test(content)) {
          fail('Check 13: Adopt-Query-Link (?adopt=...&token=) in ' + path.relative(repoRoot, fullPath));
          adoptIssues++;
        }
      }
    }
  });
}

scanForAdoptQuery(docsDir);
scanForAdoptQuery(dataDir);
if (adoptIssues === 0) {
  pass('Check 13: Keine Adopt-Query-Links in docs/* und data/*');
}

// ── Check 14: release-utils.js existiert ─────────────────────────────────
if (!fileExists('src/release-utils.js')) {
  fail('Check 14: src/release-utils.js nicht gefunden');
} else {
  pass('Check 14: src/release-utils.js vorhanden');
}

// ── Check 15: check-secrets.js scannt .md-Dateien ────────────────────────
if (!checkSecretsJs) {
  fail('Check 15: scripts/check-secrets.js nicht gefunden');
} else if (!checkSecretsJs.includes("'.md'")) {
  fail("Check 15: check-secrets.js scannt keine .md-Dateien ('.md' nicht gefunden)");
} else {
  pass('Check 15: check-secrets.js scannt .md-Dateien');
}

// ── Check 16: connect-src enthält keine Wildcards ─────────────────────────
if (!html) {
  fail('Check 16: index.html nicht gefunden (connect-src Wildcard-Prüfung nicht möglich)');
} else {
  const connectSrcValue = getCspDirective('connect-src');
  if (connectSrcValue.includes('*')) {
    fail('Check 16: connect-src enthält Wildcard (*) — zu weit gefasst');
  } else {
    pass('Check 16: connect-src enthält keine Wildcards');
  }
}

// ── Check 17: index.html enthält no-referrer ──────────────────────────────
if (!html) {
  fail('Check 17: index.html nicht gefunden (Referrer-Policy nicht prüfbar)');
} else if (!html.includes('no-referrer')) {
  fail('Check 17: index.html enthält keine Referrer-Policy no-referrer');
} else {
  pass('Check 17: index.html enthält Referrer-Policy no-referrer');
}

// ── Check 18: supabase/migrations/phase21b_public_projection_rls.sql existiert
if (!fileExists('supabase/migrations/phase21b_public_projection_rls.sql')) {
  fail('Check 18: supabase/migrations/phase21b_public_projection_rls.sql nicht gefunden');
} else {
  pass('Check 18: supabase/migrations/phase21b_public_projection_rls.sql vorhanden');
}

// ── Check 19: src/app.js enthält buildPublicCollectionData ────────────────
if (!appJs) {
  fail('Check 19: src/app.js nicht gefunden');
} else if (!appJs.includes('buildPublicCollectionData')) {
  fail('Check 19: src/app.js enthält keine buildPublicCollectionData-Funktion');
} else {
  pass('Check 19: src/app.js enthält buildPublicCollectionData');
}

// ── Check 20: script-src darf kein unsafe-inline mehr enthalten ───────────
if (!html) {
  fail("Check 20: index.html nicht gefunden (script-src 'unsafe-inline' nicht prüfbar)");
} else {
  const scriptSrcValue = getCspDirective('script-src');
  if (!scriptSrcValue) {
    fail('Check 20: CSP enthält keine script-src Direktive');
  } else if (scriptSrcValue.includes("'unsafe-inline'")) {
    fail("Check 20: script-src enthält noch 'unsafe-inline' — Inline-Script-Handler sind für Phase 21c verboten");
  } else if (scriptSrcValue !== "'self'") {
    fail("Check 20: script-src ist nicht auf exakt 'self' gehärtet (gefunden: " + scriptSrcValue + ')');
  } else {
    pass("Check 20: script-src ist auf 'self' gehärtet und enthält kein 'unsafe-inline'");
  }
}

// -- Check 21: style-src must not contain unsafe-inline
if (!html) {
  fail("Check 21: index.html nicht gefunden (style-src 'unsafe-inline' nicht prüfbar)");
} else {
  const styleSrcValue = getCspDirective('style-src');
  if (!styleSrcValue) {
    fail('Check 21: CSP has no style-src directive');
  } else if (styleSrcValue.includes("'unsafe-inline'")) {
    fail("Check 21: style-src still contains 'unsafe-inline' - inline styles are forbidden in Phase 30");
  } else if (styleSrcValue !== "'self'") {
    fail("Check 21: style-src is not exactly 'self' (found: " + styleSrcValue + ')');
  } else {
    pass("Check 21: style-src is hardened to 'self' and has no 'unsafe-inline'");
  }
}

// ── Check 22: index.html enthält keine Inline-Script-Handler ───────────────
if (!html) {
  fail('Check 22: index.html nicht gefunden (Inline-Handler nicht prüfbar)');
} else {
  const handlers = findInlineHandlers(html);
  if (handlers.length) {
    fail('Check 22: index.html enthält Inline-Script-Handler: ' + [...new Set(handlers)].join(', '));
  } else {
    pass('Check 22: index.html enthält keine Inline-Script-Handler');
  }
}

// ── Check 23: src/app.js generiert keine Inline-Script-Handler ─────────────
if (!appJs) {
  fail('Check 23: src/app.js nicht gefunden (generierte Inline-Handler nicht prüfbar)');
} else {
  const handlers = findInlineHandlers(appJs);
  if (handlers.length) {
    fail('Check 23: src/app.js enthält generierte Inline-Script-Handler: ' + [...new Set(handlers)].join(', '));
  } else {
    pass('Check 23: src/app.js generiert keine Inline-Script-Handler');
  }
}

// -- Check 24a: no inline style attributes in HTML/templates
if (!html || !appJs) {
  fail('Check 24a: inline style attributes not checkable (index.html or src/app.js missing)');
} else {
  const inlineStyles = [
    ...findInlineStyleAttributes(html).map(match => 'index.html: ' + match),
    ...findInlineStyleAttributes(appJs).map(match => 'src/app.js: ' + match),
  ];
  if (inlineStyles.length) {
    fail('Check 24a: inline style attributes found: ' + inlineStyles.slice(0, 5).join(' | '));
  } else {
    pass('Check 24a: index.html and src/app.js contain no inline style attributes');
  }
}

// ── Check 24: Phase-27b-Migration existiert und nutzt public_data ─────────
if (!phase27bMigration) {
  fail('Check 24: supabase/migrations/phase27b_public_projection_rls_hardening.sql nicht gefunden');
} else if (!phase27bMigration.includes('public_data') || !phase27bMigration.includes('collection_public_projection')) {
  fail('Check 24: Phase-27b-Migration enthält keine Public Projection mit public_data');
} else {
  pass('Check 24: Phase-27b-Migration mit public_data/Public Projection vorhanden');
}

// ── Check 25: Phase-27b-Migration granted keinen anonymen SELECT auf data ──
if (!phase27bMigration) {
  fail('Check 25: Phase-27b-Migration nicht prüfbar');
} else {
  const unsafeDataGrant = /grant\s+select\s*\([^;)]*(?:^|[,\s])data(?:[,\s]|\))/i.test(phase27bMigration)
    || /grant\s+select\s+on\s+(?:table\s+)?public\.collections\s+to\s+(?:anon|authenticated)/i.test(phase27bMigration);
  if (unsafeDataGrant) {
    fail('Check 25: Phase-27b-Migration granted anonymen SELECT auf private data/collections');
  } else {
    pass('Check 25: Kein anonymer SELECT-Grant auf private data in Phase-27b-Migration');
  }
}

// ── Check 26: Phase-27b-Migration exponiert keine Owner-/View-Token-Spalten ─
if (!phase27bMigration) {
  fail('Check 26: Phase-27b-Migration nicht prüfbar');
} else {
  const unsafeTokenGrant = /grant\s+select\s*\([^;)]*(owner_token|owner_token_hash|view_token_hash)/i.test(phase27bMigration);
  const unsafeTokenProjection = /select\s+[^;]*(owner_token|owner_token_hash|view_token_hash)[^;]*from\s+public\.collections/i.test(phase27bMigration.replace(/create\s+or\s+replace\s+function[\s\S]*?\$\$/ig, ''));
  if (unsafeTokenGrant || unsafeTokenProjection) {
    fail('Check 26: Phase-27b-Migration exponiert Owner-/View-Token-Spalten');
  } else {
    pass('Check 26: Owner-/View-Token-Spalten werden nicht öffentlich exponiert');
  }
}

// ── Check 27: Public View nutzt keinen Legacy-data-Fallback ────────────────
if (!supabaseJs) {
  fail('Check 27: src/supabase.js nicht gefunden (Public-View-Pfad nicht prüfbar)');
} else {
  const start = supabaseJs.indexOf('async function fetchPublicCollection');
  const end = supabaseJs.indexOf('async function submitReleaseIntakeCandidate', start);
  const publicFn = start >= 0 && end > start ? supabaseJs.slice(start, end) : '';
  if (!(publicFn.includes('collection_public_projection') || publicFn.includes('SUPA_PUBLIC_REST')) || !publicFn.includes('select=public_data')) {
    fail('Check 27: fetchPublicCollection nutzt nicht die Public Projection/public_data');
  } else if (/select=data/.test(publicFn)) {
    fail('Check 27: fetchPublicCollection enthält noch Legacy-Fallback auf private data');
  } else {
    pass('Check 27: fetchPublicCollection nutzt nur Public Projection/public_data');
  }
}

// ── Check 28: buildPublicCollectionData schliesst private Felder aus ───────
if (!appJs) {
  fail('Check 28: src/app.js nicht gefunden (Public Projection Helper nicht prüfbar)');
} else {
  const projectionMatch = appJs.match(/function buildPublicCollectionData[\s\S]*?\n}/);
  const projectionFn = projectionMatch ? projectionMatch[0] : '';
  const forbiddenPublicFields = ['notes', 'startedAt', 'finishedAt', 'boughtAt', 'readAt', 'isbn13', 'mpEditionId', 'mpVerifiedAt', 'owner_token', 'owner_token_hash', 'view_token_hash'];
  const leakedFields = forbiddenPublicFields.filter(field => new RegExp('\\b' + field + '\\b').test(projectionFn));
  if (!projectionFn) {
    fail('Check 28: buildPublicCollectionData-Funktion nicht gefunden');
  } else if (leakedFields.length) {
    fail('Check 28: buildPublicCollectionData referenziert private Felder: ' + leakedFields.join(', '));
  } else {
    pass('Check 28: buildPublicCollectionData referenziert keine verbotenen privaten Felder');
  }
}

// ── Check 29: Keine anonymen Schreibrechte in Phase-27b-Migration ─────────
if (!phase27bMigration) {
  fail('Check 29: Phase-27b-Migration nicht prüfbar');
} else if (/grant\s+(insert|delete|all)\b[\s\S]*\bto\s+(anon|authenticated)\b/i.test(phase27bMigration)) {
  fail('Check 29: Phase-27b-Migration granted anonyme INSERT/DELETE/ALL-Rechte');
} else {
  pass('Check 29: Keine anonymen INSERT/DELETE/ALL-Grants in Phase-27b-Migration');
}
// ── Ergebnis ───────────────────────────────────────────────────────────────
// ─── Check 30: Phase-34-Pending-Queue/Export bleiben sanitisiert ──────────
if (!appJs) {
  fail('Check 30: src/app.js nicht gefunden (Phase-34-Pending nicht prüfbar)');
} else {
  const pendingStart = appJs.indexOf('LOCAL_RELEASE_COVERAGE_PENDING_KEY');
  const pendingEnd = appJs.indexOf('async function loadJsonReadOnly', pendingStart);
  const pendingCode = pendingStart >= 0 && pendingEnd > pendingStart ? appJs.slice(pendingStart, pendingEnd) : '';
  const privatePendingFields = ['owned', 'reading', 'completed', 'collectionStatus', 'boughtAt', 'readAt', 'startedAt', 'finishedAt', 'seriesId', 'owner_token', 'view_token', 'supabase'];
  const leaked = privatePendingFields.filter(field => pendingCode.includes(field));
  if (!pendingCode || !pendingCode.includes('LOCAL_RELEASE_COVERAGE_ALLOWED_FIELDS')) {
    fail('Check 30: Phase-34-Allowlist/Pending-Code fehlt');
  } else if (leaked.length) {
    fail('Check 30: Phase-34-Pending-Code referenziert private Felder: ' + leaked.join(', '));
  } else {
    pass('Check 30: Phase-34-Pending-Queue nutzt Allowlist ohne private Felder');
  }
}

// ─── Check 31: Pending-Coverage triggert keine Cloud-/Repo-Writes ─────────
if (!appJs) {
  fail('Check 31: src/app.js nicht gefunden (Phase-34-Write-Guards nicht prüfbar)');
} else {
  const pendingStart = appJs.indexOf('LOCAL_RELEASE_COVERAGE_PENDING_KEY');
  const pendingEnd = appJs.indexOf('async function loadJsonReadOnly', pendingStart);
  const pendingCode = pendingStart >= 0 && pendingEnd > pendingStart ? appJs.slice(pendingStart, pendingEnd) : '';
  if (/pushCloud\s*\(|persist\s*\(|patchCollectionPayload|api\.github\.com|repos\/[^/]+\/[^/]+\/contents/i.test(pendingCode)) {
    fail('Check 31: Phase-34-Pending-Code enthält Cloud-/Repo-Write-Pfad');
  } else {
    pass('Check 31: Phase-34-Pending-Code enthält keine Cloud-/Repo-Write-Pfade');
  }
}

// ── Ergebnis ───────────────────────────────────────────────────────────────

// ─── Check 32: Phase-35-Pending-Intake bleibt sanitisiert und read-only nach außen ───
if (!appJs) {
  fail('Check 32: src/app.js nicht gefunden (Phase-35-Pending-Intake nicht prüfbar)');
} else {
  const phase35Start = appJs.indexOf('function groupPendingCoverageCandidates');
  const phase35End = appJs.indexOf('async function loadJsonReadOnly', phase35Start);
  const phase35Code = phase35Start >= 0 && phase35End > phase35Start ? appJs.slice(phase35Start, phase35End) : '';
  const appJsNorm = appJs.replace(/\r\n/g, '\n');
  const batchMatch = appJsNorm.match(/function buildSanitizedPendingWatchlistBatch[\s\S]*?\n}\n\nfunction buildLocalReleaseCoverageWatchlistBatch/);
  const batchCode = batchMatch ? batchMatch[0] : '';
  const forbiddenExportFields = ['owned', 'readAt', 'boughtAt', 'collectionStatus', 'readStatus', 'seriesId', 'owner_token', 'view_token', 'supabaseId', 'supabase_id', 'privateDebug'];
  const leakedExport = forbiddenExportFields.filter(field => new RegExp('\\b' + field + '\\b').test(batchCode));
  if (!phase35Code || !batchCode || !phase35Code.includes('blocked-missing-publisher') || !phase35Code.includes('replaced-empty-publisher')) {
    fail('Check 32: Phase-35-Intake-/Dedupe-Guardrails fehlen');
  } else if (leakedExport.length) {
    fail('Check 32: Phase-35-Sanitizer referenziert private Exportfelder: ' + leakedExport.join(', '));
  } else if (/pushCloud\s*\(|persist\s*\(|patchCollection|api\.github\.com|repos\/[^/]+\/[^/]+\/contents|release-watchlist\.json[\s\S]{0,120}\b(PUT|POST|PATCH|DELETE)\b|release-cache\.json[\s\S]{0,120}\b(PUT|POST|PATCH|DELETE)\b/i.test(phase35Code)) {
    fail('Check 32: Phase-35-Pending-Intake enthält externen Schreibpfad');
  } else {
    pass('Check 32: Phase-35-Pending-Intake nutzt Allowlist, blockiert unsichere Daten und schreibt nicht extern');
  }
}

// ─── Check 33: Phase-35-UI-Aktionen mutieren nur mtReleaseCoveragePending ───
if (!appJs) {
  fail('Check 33: src/app.js nicht gefunden (Phase-35-Aktionen nicht prüfbar)');
} else {
  const actionStart = appJs.indexOf('function copySanitizedPendingWatchlistBatch');
  const actionEnd = appJs.indexOf('function clearResolvedLocalReleaseCoveragePending', actionStart);
  const actionCode = actionStart >= 0 && actionEnd > actionStart ? appJs.slice(actionStart, actionEnd) : '';
  if (!actionCode.includes('navigator.clipboard.writeText') || !actionCode.includes('markReviewedLocalReleaseCoveragePending') || !actionCode.includes('deleteLocalReleaseCoveragePending')) {
    fail('Check 33: Phase-35-Copy/Delete/Mark-reviewed-Aktionen fehlen');
  } else if (/\bdb\.m\b|pushCloud\s*\(|persist\s*\(|patchCollection|supabase\.(from|rpc)|api\.github\.com/i.test(actionCode)) {
    fail('Check 33: Phase-35-Aktionen mutieren mehr als Pending-localStorage oder schreiben extern');
  } else {
    pass('Check 33: Phase-35-Copy mutiert nichts, Delete/Mark-reviewed bleiben lokal auf Pending begrenzt');
  }
}
// ─── Check 34: Phase-36a-Intake-Funktionen enthalten keine externen Schreibpfade ───
if (!appJs) {
  fail('Check 34: src/app.js nicht gefunden (Phase-36a nicht prüfbar)');
} else {
  const resolveStart = appJs.indexOf('function resolveEmptyPublisherPendingCandidates(');
  const resolveEnd = appJs.indexOf('\nfunction ', resolveStart + 1);
  const resolveCode = resolveStart >= 0 && resolveEnd > resolveStart ? appJs.slice(resolveStart, resolveEnd) : '';
  const forbiddenPrivate = ['owned', 'readAt', 'boughtAt', 'collectionStatus', 'readStatus', 'seriesId', 'owner_token', 'view_token'];
  const leaked = forbiddenPrivate.filter(f => new RegExp('\\b' + f + '\\b').test(resolveCode));
  if (!resolveCode) {
    fail('Check 34: resolveEmptyPublisherPendingCandidates fehlt in app.js');
  } else if (leaked.length) {
    fail('Check 34: resolveEmptyPublisherPendingCandidates referenziert private Felder: ' + leaked.join(', '));
  } else if (/pushCloud\s*\(|persist\s*\(|patchCollection|api\.github\.com|release-watchlist\.json[\s\S]{0,80}\b(PUT|POST|PATCH)\b|release-cache\.json[\s\S]{0,80}\b(PUT|POST|PATCH)\b/i.test(resolveCode)) {
    fail('Check 34: resolveEmptyPublisherPendingCandidates enthält externen Schreibpfad');
  } else {
    pass('Check 34: Phase-36a-resolveEmptyPublisher ist privat-frei und enthält keinen externen Schreibpfad');
  }
}

// ── Check 35: Phase-36b — submitReleaseIntakeCandidate in supabase.js ─────────
if (!supabaseJs) {
  fail('Check 35: src/supabase.js nicht gefunden (Phase-36b Submit nicht prüfbar)');
} else {
  const submitStart = supabaseJs.indexOf('async function submitReleaseIntakeCandidate(');
  const submitEnd   = supabaseJs.indexOf('\n  async function ', submitStart + 1);
  const submitCode  = submitStart >= 0 && submitEnd > submitStart
    ? supabaseJs.slice(submitStart, submitEnd)
    : (submitStart >= 0 ? supabaseJs.slice(submitStart) : '');
  const privateForbidden = ['data', 'bands', 'owned', 'readAt', 'boughtAt', 'collectionStatus', 'readStatus', 'seriesId'];
  const leaked = privateForbidden.filter(f => new RegExp('\\b' + f + '\\b').test(submitCode));
  if (!submitCode) {
    fail('Check 35: submitReleaseIntakeCandidate fehlt in src/supabase.js');
  } else if (leaked.length) {
    fail('Check 35: submitReleaseIntakeCandidate referenziert private Felder: ' + leaked.join(', '));
  } else if (!submitCode.includes('INTAKE_ALLOWED_FIELDS') && !submitCode.includes('p_series_title')) {
    fail('Check 35: submitReleaseIntakeCandidate enthält keine erkennbare Allowlist/RPC-Logik');
  } else if (!supabaseJs.includes('submitReleaseIntakeCandidate: submitReleaseIntakeCandidate')) {
    fail('Check 35: submitReleaseIntakeCandidate nicht in window.MangaTrackerSupabase exportiert');
  } else {
    pass('Check 35: submitReleaseIntakeCandidate in supabase.js — privat-frei, Allowlist, exportiert');
  }
}

// ── Check 36: Phase-36b — Auto-Intake Guards in app.js ────────────────────────
if (!appJs) {
  fail('Check 36: src/app.js nicht gefunden (Phase-36b Guards nicht prüfbar)');
} else {
  const intakeStart = appJs.indexOf('function isReleaseIntakeSendAllowed(');
  const intakeEnd   = appJs.indexOf('\nfunction ', intakeStart + 1);
  const intakeCode  = intakeStart >= 0 && intakeEnd > intakeStart ? appJs.slice(intakeStart, intakeEnd) : '';
  const buildStart  = appJs.indexOf('function buildIntakeSubmitCandidate(');
  const buildEnd    = appJs.indexOf('\nfunction ', buildStart + 1);
  const buildCode   = buildStart >= 0 && buildEnd > buildStart ? appJs.slice(buildStart, buildEnd) : '';
  const privateGuards = ['owned', 'readAt', 'boughtAt', 'collectionStatus', 'readStatus', 'seriesId'];
  const leakedIntake = privateGuards.filter(f => new RegExp('\\b' + f + '\\b').test(intakeCode));
  const leakedBuild  = privateGuards.filter(f => new RegExp('\\b' + f + '\\b').test(buildCode));
  if (!intakeCode) {
    fail('Check 36a: isReleaseIntakeSendAllowed fehlt in app.js');
  } else if (leakedIntake.length) {
    fail('Check 36a: isReleaseIntakeSendAllowed referenziert private Felder: ' + leakedIntake.join(', '));
  } else if (!intakeCode.includes('isPublicReadOnly') || !intakeCode.includes('canWriteCloud')) {
    fail('Check 36a: isReleaseIntakeSendAllowed enthält nicht beide Mode-Guards (isPublicReadOnly, canWriteCloud)');
  } else {
    pass('Check 36a: isReleaseIntakeSendAllowed — privat-frei, Mode-Guards vorhanden');
  }
  if (!buildCode) {
    fail('Check 36b: buildIntakeSubmitCandidate fehlt in app.js');
  } else if (leakedBuild.length) {
    fail('Check 36b: buildIntakeSubmitCandidate referenziert private Felder: ' + leakedBuild.join(', '));
  } else if (!buildCode.includes('RELEASE_INTAKE_SUBMIT_ALLOWED_FIELDS') && !buildCode.includes('seriesTitle') && !buildCode.includes('publisher')) {
    fail('Check 36b: buildIntakeSubmitCandidate enthält keine erkennbare Allowlist-Logik');
  } else {
    pass('Check 36b: buildIntakeSubmitCandidate — privat-frei, Allowlist-Konstruktion');
  }
  // Auto-intake default must be OFF
  if (!appJs.includes('MT_AUTO_RELEASE_INTAKE_KEY') || !appJs.includes("'mtAutoReleaseIntake'")) {
    fail('Check 36c: MT_AUTO_RELEASE_INTAKE_KEY oder localStorage-Key mtAutoReleaseIntake fehlt in app.js');
  } else if (!appJs.includes("localStorage.getItem(MT_AUTO_RELEASE_INTAKE_KEY) === 'true'")) {
    fail("Check 36c: getAutoReleaseIntakeSetting prüft nicht === 'true' (default OFF sichergestellt)");
  } else {
    pass("Check 36c: Auto-Intake-Setting liest nur 'true' als aktiviert (default OFF)");
  }
  // maybeSubmitReleaseIntakeCandidate must not block save/purchase
  const maybeSubmitStart = appJs.indexOf('function maybeSubmitReleaseIntakeCandidate(');
  const maybeSubmitEnd   = appJs.indexOf('\nfunction ', maybeSubmitStart + 1);
  const maybeSubmitCode  = maybeSubmitStart >= 0 && maybeSubmitEnd > maybeSubmitStart
    ? appJs.slice(maybeSubmitStart, maybeSubmitEnd) : '';
  if (!maybeSubmitCode || !maybeSubmitCode.includes('Promise.resolve')) {
    fail('Check 36d: maybeSubmitReleaseIntakeCandidate fehlt oder ist nicht async/fire-and-forget');
  } else {
    pass('Check 36d: maybeSubmitReleaseIntakeCandidate ist fire-and-forget (Promise.resolve)');
  }
  // release-intake.yml exists
  if (!fileExists('.github/workflows/release-intake.yml')) {
    fail('Check 36e: .github/workflows/release-intake.yml nicht gefunden');
  } else {
    const intakeYml = readFile('.github/workflows/release-intake.yml');
    if (!intakeYml || !intakeYml.includes('workflow_dispatch')) {
      fail('Check 36e: release-intake.yml enthält kein workflow_dispatch');
    } else if (!intakeYml.includes("cron: '5 4 * * *'")) {
      fail("Check 36e: release-intake.yml enthält nicht Schedule '5 4 * * *' (04:05 UTC)");
    } else if (intakeYml.includes('push:\n') || /^  push:/m.test(intakeYml)) {
      fail('Check 36e: release-intake.yml hat push-Trigger — kein direkter Push auf main erlaubt');
    } else {
      pass('Check 36e: release-intake.yml — workflow_dispatch, 04:05 UTC Schedule, kein push-Trigger');
    }
  }
}

// ── Check 37: Phase 37 — Cover-Preserve und Wishlist-Coverage ─────────────────
if (!appJs) {
  fail('Check 37: src/app.js nicht gefunden (Phase-37 Checks nicht prüfbar)');
} else {
  // 37a/44c: Cover-Preserve-Logik vorhanden (kein manuelles URL-Feld überschreibt bestehende Cover)
  if (!appJs.includes('const cover = resolveProtectedCover(existing);')) {
    fail('Check 37a: Cover-Preserve-Logik (resolveProtectedCover(existing)) fehlt in app.js');
  } else {
    pass('Check 37a: Cover-Preserve-Logik vorhanden — geschütztes Cover-Feld löscht/überschreibt Cover nicht');
  }

  // 37b: Wishlist-Ausschluss entfernt (buildLocalReleaseCoverageCandidate schließt wishlist nicht mehr aus)
  const buildCandStart = appJs.indexOf('function buildLocalReleaseCoverageCandidate(');
  const buildCandEnd   = appJs.indexOf('\nfunction ', buildCandStart + 1);
  const buildCandCode  = buildCandStart >= 0 && buildCandEnd > buildCandStart
    ? appJs.slice(buildCandStart, buildCandEnd) : '';
  if (!buildCandCode) {
    fail('Check 37b: buildLocalReleaseCoverageCandidate nicht gefunden in app.js');
  } else if (/manga\.status\s*===\s*'wishlist'|mSeriesStatus\(manga\)\s*===\s*'wishlist'/.test(buildCandCode)) {
    fail('Check 37b: buildLocalReleaseCoverageCandidate enthält noch den Wishlist-Ausschluss (Phase-34-Guard)');
  } else {
    pass('Check 37b: Wishlist-Ausschluss in buildLocalReleaseCoverageCandidate entfernt');
  }

  // 37c: Export-Kandidat enthält keine privaten Wishlist-/Sammlungsfelder
  const buildSubmitStart = appJs.indexOf('function buildIntakeSubmitCandidate(');
  const buildSubmitEnd   = appJs.indexOf('\nfunction ', buildSubmitStart + 1);
  const buildSubmitCode  = buildSubmitStart >= 0 && buildSubmitEnd > buildSubmitStart
    ? appJs.slice(buildSubmitStart, buildSubmitEnd) : '';
  const wishlistPrivateFields = ['status', 'wishlist', 'owned', 'collectionStatus', 'readAt', 'boughtAt', 'seriesId'];
  const leakedSubmit = wishlistPrivateFields.filter(f =>
    new RegExp('(?:return|\\{|,)\\s*["\']?' + f + '["\']?\\s*[,:\\}]').test(buildSubmitCode)
  );
  if (!buildSubmitCode) {
    fail('Check 37c: buildIntakeSubmitCandidate nicht gefunden in app.js');
  } else if (leakedSubmit.length) {
    fail('Check 37c: buildIntakeSubmitCandidate gibt private Felder zurück: ' + leakedSubmit.join(', '));
  } else {
    pass('Check 37c: buildIntakeSubmitCandidate enthält keine privaten Wishlist-/Sammlungsfelder');
  }

  // 37d: Dashboard-Info-Text für Wishlist-Coverage-Aktivierung vorhanden
  if (!appJs.includes('Phase-37: Wishlist-Serien mit Titel und Publisher')) {
    fail('Check 37d: Dashboard-Info-Text für Phase-37-Wishlist-Coverage fehlt in app.js');
  } else {
    pass('Check 37d: Dashboard zeigt Phase-37-Wishlist-Coverage-Info-Text');
  }
}

// ── Check 38: Phase-28-Status-Mail-Script existiert und enthält keinen Env-Dump ───
const statusMailJs = readFile('scripts/write-release-cache-status-mail.js');
if (!statusMailJs) {
  fail('Check 38a: scripts/write-release-cache-status-mail.js nicht gefunden');
} else {
  pass('Check 38a: scripts/write-release-cache-status-mail.js vorhanden');
}

if (!statusMailJs) {
  fail('Check 38b: scripts/write-release-cache-status-mail.js nicht prüfbar');
} else if (
  /JSON\.stringify\s*\(\s*process\.env\b/.test(statusMailJs) ||
  /Object\.entries\s*\(\s*process\.env\b/.test(statusMailJs) ||
  /Object\.keys\s*\(\s*process\.env\b/.test(statusMailJs) ||
  /for\s*\([^)]*\bin\s+process\.env\b/.test(statusMailJs)
) {
  fail('Check 38b: write-release-cache-status-mail.js enthält process.env-Dump-Pattern');
} else {
  pass('Check 38b: write-release-cache-status-mail.js enthält keinen process.env-Dump');
}


// ── Check 39: Phase 43 public release-volume-counts are public-only and read-only in app ──
const releaseVolumeValidator = readFile('scripts/validate-release-volume-counts.js');
const releaseVolumeRunner = readFile('scripts/run-release-volume-counts.js');
const releaseVolumeMail = readFile('scripts/write-release-volume-counts-status-mail.js');
const releaseVolumeWorkflow = readFile('.github/workflows/update-release-volume-counts.yml');
if (!fileExists('data/release-volume-counts.json') || !releaseVolumeValidator || !releaseVolumeRunner) {
  fail('Check 39a: Phase-43 release-volume-counts data/runner/validator missing');
} else {
  pass('Check 39a: Phase-43 release-volume-counts data/runner/validator vorhanden');
}

if (!appJs) {
  fail('Check 39b: src/app.js nicht gefunden (Phase-43 Read-only-Block nicht prüfbar)');
} else {
  const phase43Start = appJs.indexOf('async function loadReleaseVolumeCounts');
  const phase43End = appJs.indexOf('async function loadReleaseCoverageKnownData', phase43Start);
  const phase43Code = phase43Start >= 0 && phase43End > phase43Start ? appJs.slice(phase43Start, phase43End) : '';
  if (!phase43Code || !phase43Code.includes('release-volume-counts.json')) {
    fail('Check 39b: Phase-43 App-Read-only-Integration fehlt');
  } else if (/pushCloud\s*\(|persist\s*\(|patchCollectionPayload|localStorage\.setItem|supabase\.(from|rpc)|api\.github\.com/i.test(phase43Code)) {
    fail('Check 39b: Phase-43 App-Block enthält mutierenden Schreibpfad');
  } else {
    pass('Check 39b: Phase-43 App-Integration lädt release-volume-counts read-only');
  }
}

if (!releaseVolumeValidator) {
  fail('Check 39c: Phase-43 Validator nicht prüfbar');
} else if (!releaseVolumeValidator.includes('ALLOWED_ITEM_KEYS') || !releaseVolumeValidator.includes('FORBIDDEN_KEYS')) {
  fail('Check 39c: Phase-43 Validator enthält keine Allowlist/Forbidden-Key-Prüfung');
} else {
  pass('Check 39c: Phase-43 Validator nutzt öffentliche Feld-Allowlist und private Forbidden-Keys');
}

if (!releaseVolumeWorkflow) {
  fail('Check 39d: update-release-volume-counts.yml nicht gefunden');
} else if (!releaseVolumeWorkflow.includes('node scripts/test-public-private-diff.js') || !releaseVolumeWorkflow.includes('node scripts/validate-release-volume-counts-automerge-gate.js')) {
  fail('Check 39d: Phase-43 Workflow enthält Privacy-Gate oder Auto-Merge-Gate nicht');
} else {
  pass('Check 39d: Phase-43 Workflow enthält Privacy-Gate und Auto-Merge-Gate');
}

if (!releaseVolumeMail) {
  fail('Check 39e: Phase-43 Status-Mail-Writer fehlt');
} else if (/JSON\.stringify\s*\(\s*process\.env\b|Object\.(entries|keys)\s*\(\s*process\.env\b|for\s*\([^)]*\bin\s+process\.env\b/.test(releaseVolumeMail)) {
  fail('Check 39e: Phase-43 Status-Mail-Writer enthält process.env-Dump-Pattern');
} else {
  pass('Check 39e: Phase-43 Status-Mail-Writer enthält keinen Env-Dump');
}

// ── Check 57: Phase 57 publication-status is public-only and read-only in app ──
const pubStatusValidator = readFile('scripts/validate-series-publication-status.js');
const pubStatusRunner = readFile('scripts/run-series-publication-status.js');
const pubStatusWorkflow = readFile('.github/workflows/update-series-publication-status.yml');
if (!fileExists('data/series-publication-status.json') || !pubStatusValidator || !pubStatusRunner) {
  fail('Check 57a: Phase-57 publication-status data/runner/validator missing');
} else {
  pass('Check 57a: Phase-57 publication-status data/runner/validator vorhanden');
}

if (!appJs) {
  fail('Check 57b: src/app.js nicht gefunden (Phase-57 Read-only-Block nicht prüfbar)');
} else {
  const p57Start = appJs.indexOf('async function loadSeriesPublicationStatus');
  const p57End = appJs.indexOf('function findPublicationStatusForSeries', p57Start);
  const p57Code = p57Start >= 0 && p57End > p57Start ? appJs.slice(p57Start, p57End) : '';
  if (!p57Code || !p57Code.includes('series-publication-status.json')) {
    fail('Check 57b: Phase-57 App-Read-only-Integration fehlt');
  } else if (/pushCloud\s*\(|persist\s*\(|patchCollectionPayload|localStorage\.setItem|supabase\.(from|rpc)|api\.github\.com/i.test(p57Code)) {
    fail('Check 57b: Phase-57 App-Block enthält mutierenden Schreibpfad');
  } else {
    pass('Check 57b: Phase-57 App-Integration lädt series-publication-status read-only');
  }
}

if (!pubStatusValidator) {
  fail('Check 57c: Phase-57 Validator nicht prüfbar');
} else if (!pubStatusValidator.includes('ALLOWED_ONGOING') || !pubStatusValidator.includes('ALLOWED_SOURCE_STATUS')) {
  fail('Check 57c: Phase-57 Validator enthält keine Wert-Allowlist');
} else {
  pass('Check 57c: Phase-57 Validator nutzt strikte Wert-Allowlist (ongoing/sourceStatus)');
}

if (!pubStatusWorkflow) {
  fail('Check 57d: update-series-publication-status.yml nicht gefunden');
} else if (!pubStatusWorkflow.includes('node scripts/test-public-private-diff.js')) {
  fail('Check 57d: Phase-57 Workflow enthält Privacy-Gate nicht');
} else {
  pass('Check 57d: Phase-57 Workflow enthält Privacy-Gate');
}

// ── Check 57e: Phase 58 curated overrides are validated and applied in pipeline ──
if (!fileExists('data/series-status-overrides.json')) {
  pass('Check 57e: Phase-58 Override-Datei nicht vorhanden (optional) — übersprungen');
} else if (!pubStatusValidator || !pubStatusValidator.includes('validateSeriesStatusOverrides')) {
  fail('Check 57e: Phase-58 Override-Validator (validateSeriesStatusOverrides) fehlt');
} else if (!pubStatusRunner || !pubStatusRunner.includes('series-status-overrides.json') || !pubStatusRunner.includes('validateSeriesStatusOverrides')) {
  fail('Check 57e: Phase-58 Pipeline wendet Overrides nicht validiert an');
} else {
  pass('Check 57e: Phase-58 Overrides werden validiert und in der Pipeline angewandt');
}

// ── Check 40: Phase-64 — vendor/jszip.min.js Script-Tag enthält SRI-Hash ───
if (!html) {
  fail('Check 40: index.html nicht gefunden (SRI-Check nicht möglich)');
} else {
  const jszipTagMatch = html.match(/<script[^>]+vendor\/jszip\.min\.js[^>]*>/i);
  if (!jszipTagMatch) {
    fail('Check 40: Kein vendor/jszip.min.js Script-Tag in index.html gefunden');
  } else {
    const tag = jszipTagMatch[0];
    const hasIntegrity  = /integrity=["']sha384-[A-Za-z0-9+/]+=*["']/.test(tag);
    const hasCrossorigin = /crossorigin=["']anonymous["']/.test(tag);
    if (!hasIntegrity) {
      fail('Check 40: vendor/jszip.min.js Script-Tag enthält kein integrity="sha384-..." Attribut');
    } else if (!hasCrossorigin) {
      fail('Check 40: vendor/jszip.min.js Script-Tag enthält kein crossorigin="anonymous" Attribut');
    } else {
      pass('Check 40: vendor/jszip.min.js Script-Tag enthält SRI-Hash (sha384) und crossorigin');
    }
  }
}

const passed = totalChecks - totalFailed - totalWarns;
console.log('');
if (totalWarns > 0) {
  console.warn('  ⚠ ' + totalWarns + ' Warnung(en) — dokumentierte Restschuld, kein Fehler');
}
if (totalFailed > 0) {
  console.error('❌ Sicherheits-Audit fehlgeschlagen — ' + totalFailed + '/' + totalChecks + ' Checks nicht bestanden\n');
  process.exit(1);
} else {
  console.log('✅ Sicherheits-Audit bestanden — ' + (totalChecks - totalFailed) + '/' + totalChecks + ' Checks (inkl. ' + totalWarns + ' Warn)\n');
  process.exit(0);
}
