#!/usr/bin/env node
'use strict';

/**
 * audit-release-cache-coverage.js — Phase 22 / 22c
 *
 * Prüft, ob aktivierte Watchlist-Einträge im Release-Cache vorhanden sind.
 *
 * Aufruf:
 *   node scripts/audit-release-cache-coverage.js [--strict] [--json]
 *
 * Standardpfade (relativ zum Repo-Root):
 *   data/release-watchlist.json
 *   data/release-cache.json
 *
 * Exit 0 = OK (Warnmodus) — auch bei fehlenden Einträgen
 * Exit 1 = Fehler nur wenn --strict gesetzt
 */

const fs   = require('fs');
const path = require('path');

const repoRoot      = path.resolve(__dirname, '..');
const watchlistFile = path.join(repoRoot, 'data', 'release-watchlist.json');
const cacheFile     = path.join(repoRoot, 'data', 'release-cache.json');
const strict        = process.argv.includes('--strict');
const jsonMode      = process.argv.includes('--json');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Datei nicht gefunden: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Ungültiges JSON in "${path.basename(filePath)}": ${e.message}`);
  }
}

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(watchlistNorm, cacheNorm) {
  if (!watchlistNorm || !cacheNorm) return false;
  if (watchlistNorm === cacheNorm) return true;
  if (watchlistNorm.length >= 3 && cacheNorm.includes(watchlistNorm)) return true;
  if (cacheNorm.length >= 3 && watchlistNorm.includes(cacheNorm)) return true;
  return false;
}

function expandWatchlistEntry(entry, entryIndex) {
  const hasVolumeNumber  = Object.prototype.hasOwnProperty.call(entry, 'volumeNumber');
  const hasVolumeNumbers = Object.prototype.hasOwnProperty.call(entry, 'volumeNumbers');

  if (hasVolumeNumber && !hasVolumeNumbers) {
    return [{ entryIndex, entry, volumeNumber: entry.volumeNumber }];
  }

  if (hasVolumeNumbers && !hasVolumeNumber && Array.isArray(entry.volumeNumbers)) {
    return entry.volumeNumbers.map(volumeNumber => ({ entryIndex, entry, volumeNumber }));
  }

  return [];
}

function cacheContainsVolume(cacheItems, seriesTitle, volumeNumber) {
  const normTitle = normalizeTitle(seriesTitle);
  return cacheItems.some(item => {
    if (!item || typeof item !== 'object') return false;
    const cacheNorm = item.normalizedSeriesTitle || normalizeTitle(item.seriesTitle || '');
    if (!titleMatches(normTitle, cacheNorm)) return false;
    return item.volumeNumber === volumeNumber;
  });
}

function groupMissingBySeries(missing) {
  const groups = new Map();
  missing.forEach(item => {
    const key = `${item.normalizedSeriesTitle}|${item.publisher || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        seriesTitle: item.seriesTitle,
        normalizedSeriesTitle: item.normalizedSeriesTitle,
        publisher: item.publisher || null,
        missingVolumes: [],
        missingCount: 0,
        classification: 'source-data-gap',
        recommendedAction: 'Manuell in verlässlicher Quelle prüfen; keine Fake-Release-Daten ergänzen.',
      });
    }
    const group = groups.get(key);
    group.missingVolumes.push(item.volumeNumber);
    group.missingCount++;
  });
  return Array.from(groups.values()).map(group => ({
    ...group,
    missingVolumes: group.missingVolumes.sort((a, b) => a - b),
  }));
}

function groupMissingByPublisher(missing) {
  const groups = new Map();
  missing.forEach(item => {
    const publisher = item.publisher || 'Unbekannter Verlag';
    if (!groups.has(publisher)) groups.set(publisher, { publisher, missingCount: 0, seriesCount: 0, series: new Set() });
    const group = groups.get(publisher);
    group.missingCount++;
    group.series.add(item.seriesTitle);
  });
  return Array.from(groups.values())
    .map(group => ({
      publisher: group.publisher,
      missingCount: group.missingCount,
      seriesCount: group.series.size,
      series: Array.from(group.series).sort((a, b) => a.localeCompare(b, 'de')),
    }))
    .sort((a, b) => b.missingCount - a.missingCount || a.publisher.localeCompare(b.publisher, 'de'));
}

function buildAuditReport(watchlist, cache) {
  const enabledItems = (Array.isArray(watchlist.items) ? watchlist.items : [])
    .filter(item => item && item.enabled === true);
  const cacheItems = Array.isArray(cache.items) ? cache.items : [];

  const expanded = enabledItems.flatMap((entry, entryIndex) => expandWatchlistEntry(entry, entryIndex));
  const checked = [];
  const found = [];
  const missing = [];

  expanded.forEach(({ entryIndex, entry, volumeNumber }) => {
    const present = cacheContainsVolume(cacheItems, entry.seriesTitle, volumeNumber);
    const row = {
      status: present ? 'found' : 'missing',
      seriesTitle: entry.seriesTitle,
      normalizedSeriesTitle: normalizeTitle(entry.seriesTitle),
      publisher: entry.publisher || null,
      volumeNumber,
      watchlistEntryIndex: entryIndex,
      classification: present ? 'cache-covered' : 'source-data-gap',
      evidence: present
        ? 'Passender Eintrag in data/release-cache.json gefunden.'
        : 'Kein passender Eintrag in data/release-cache.json nach normalisiertem Titel und Bandnummer gefunden.',
    };
    checked.push(row);
    if (present) found.push(row);
    else missing.push(row);
  });

  const missingBySeries = groupMissingBySeries(missing);
  const missingByPublisher = groupMissingByPublisher(missing);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: strict ? 'strict' : 'warn',
    files: {
      watchlist: path.relative(repoRoot, watchlistFile).replace(/\\/g, '/'),
      cache: path.relative(repoRoot, cacheFile).replace(/\\/g, '/'),
    },
    summary: {
      enabledWatchlistEntries: enabledItems.length,
      expandedWatchlistVolumeCandidates: expanded.length,
      cacheEntries: cacheItems.length,
      foundCacheEntries: found.length,
      missingCacheCoverage: missing.length,
      missingSeries: missingBySeries.length,
      missingPublishers: missingByPublisher.length,
      auditClass: missing.length === 0 ? 'covered' : 'warning-source-data-gaps',
      exitCode: strict && missing.length > 0 ? 1 : 0,
    },
    classificationLegend: {
      'cache-covered': 'Watchlist-Band ist im Release-Cache abgedeckt.',
      'source-data-gap': 'Watchlist-Band ist nach dem Cache-Update weiterhin nicht im Release-Cache; als Quellen-/Datenqualitätsfall behandeln, nicht als App-Fehler.',
    },
    missingBySeries,
    missingByPublisher,
    checked,
    found,
    missing,
  };
}

function printTextReport(report) {
  console.log('\nAudit: Release-Cache-Abdeckung (Watchlist vs. Cache)\n');
  console.log(`Watchlist: ${report.summary.enabledWatchlistEntries} aktivierte Einträge`);
  console.log(`Expandierte Watchlist-Bandkandidaten: ${report.summary.expandedWatchlistVolumeCandidates}`);
  console.log(`Cache: ${report.summary.cacheEntries} Einträge\n`);

  report.checked.forEach(item => {
    const marker = item.status === 'found' ? '✓' : '✗';
    const text = item.status === 'found' ? 'gefunden' : 'fehlt';
    console.log(`  ${marker} ${item.seriesTitle} Band ${item.volumeNumber} ${text}`);
  });

  console.log('');
  console.log(`Gefundene Cache-Einträge: ${report.summary.foundCacheEntries}`);
  console.log(`Fehlende Cache-Abdeckung: ${report.summary.missingCacheCoverage}`);

  if (report.summary.missingCacheCoverage === 0) {
    console.log('\n✅ Alle aktivierten Watchlist-Einträge sind im Cache abgedeckt\n');
  } else {
    console.log(`\n⚠ ${report.summary.missingCacheCoverage} Watchlist-Eintrag/Einträge noch nicht im Cache`);
    console.log(`Klassifizierung: ${report.summary.missingSeries} Serien / ${report.summary.missingPublishers} Verlage mit Quellen-/Datenqualitätslücken`);
    if (strict) {
      console.error('❌ Strict-Modus: Exit 1 wegen fehlender Cache-Abdeckung\n');
    } else {
      console.log('ℹ Warnmodus (kein --strict): Exit 0\n');
    }
  }
}

let watchlist, cache, report;
try {
  watchlist = readJson(watchlistFile);
  cache = readJson(cacheFile);
  report = buildAuditReport(watchlist, cache);
} catch (e) {
  if (jsonMode) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      error: e.message,
      summary: { exitCode: 1 },
    }, null, 2));
  } else {
    console.error(`  ✗ ${e.message}`);
    console.error('\n❌ Audit fehlgeschlagen\n');
  }
  process.exit(1);
}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTextReport(report);
}

process.exit(report.summary.exitCode);
