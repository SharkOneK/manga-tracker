#!/usr/bin/env node
'use strict';

/**
 * Phase 57: public DE publication-status pipeline (laufend / abgeschlossen).
 *
 * Writes only public metadata:
 * - data/series-publication-status.json
 * - data/series-publication-status-report.json
 *
 * Input series + edition mapping is reused from data/release-volume-counts.json
 * (already-resolved manga-passion editions) so this pipeline does NOT re-run any
 * fuzzy matching. For each manga-passion edition it reads the edition `status`
 * field from the public API and maps it to the German publication status:
 *
 *   status === 1  ->  ongoing = 'true'   (laufend – weitere DE-Baende erwartet)
 *   status === 2  ->  ongoing = 'false'  (abgeschlossen – DE-Ausgabe komplett)
 *   anything else ->  blocked (no write; reported only)
 *
 * Non-manga-passion sources and unexpected status codes are reported, never
 * written, so an unknown upstream value can never silently corrupt the field.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const {
  normalizePublisher,
  normalizeTitle,
} = require('./release-confidence');
const { validateSeriesPublicationStatus } = require('./validate-series-publication-status');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const countsFile = path.join(dataDir, 'release-volume-counts.json');
const statusFile = path.join(dataDir, 'series-publication-status.json');
const reportFile = path.join(dataDir, 'series-publication-status-report.json');

const MP_API = 'https://api.manga-passion.de';
const DEFAULT_DELAY_MS = Number(process.env.PUBLICATION_STATUS_MIN_DELAY_MS || 250);
const DEFAULT_TIMEOUT_MS = Number(process.env.PUBLICATION_STATUS_TIMEOUT_MS || 12000);

// manga-passion edition.status -> ongoing value. Kept intentionally small and
// explicit: only values we have verified against the real collection are mapped.
const STATUS_MAP = { 1: 'true', 2: 'false' };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonStable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function editionIdFromUrl(url) {
  const match = /manga-passion\.de\/editions\/(\d+)/.exec(String(url || ''));
  return match ? Number(match[1]) : null;
}

function statusKey(title, publisher) {
  return `${normalizeTitle(title)}|${normalizePublisher(publisher)}`;
}

function sortItems(items) {
  return items.sort((a, b) =>
    normalizeTitle(a.seriesTitle).localeCompare(normalizeTitle(b.seriesTitle), 'de') ||
    normalizePublisher(a.publisher).localeCompare(normalizePublisher(b.publisher), 'de')
  );
}

function fetchEdition(editionId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${MP_API}/editions/${editionId}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'MangaTrackerPublicationStatusBot/1.0', Accept: 'application/json' },
    }, res => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`invalid-json: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function stripGeneratedAt(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.generatedAt;
  return copy;
}

function stableGeneratedAt(file, doc) {
  if (!fs.existsSync(file)) return doc.generatedAt;
  try {
    const existing = readJson(file);
    if (JSON.stringify(stripGeneratedAt(existing)) === JSON.stringify(stripGeneratedAt(doc))) {
      return existing.generatedAt;
    }
  } catch (_) { /* ignore and use new timestamp */ }
  return doc.generatedAt;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const networkEnabled = !args.has('--from-cache-only') && process.env.PUBLICATION_STATUS_SKIP_NETWORK !== '1';
  const startedAt = new Date().toISOString();

  const counts = fs.existsSync(countsFile) ? readJson(countsFile) : { items: [] };
  const existingStatus = fs.existsSync(statusFile) ? readJson(statusFile) : { schemaVersion: 1, generatedAt: startedAt, items: [] };
  const existingByKey = new Map((existingStatus.items || []).map(it => [statusKey(it.seriesTitle, it.publisher), it]));

  const byKey = new Map();
  const blocked = [];
  const checked = [];
  const applied = [];

  for (const entry of Array.isArray(counts.items) ? counts.items : []) {
    const title = String(entry && entry.seriesTitle || '').trim();
    const publisher = String(entry && entry.publisher || '').trim();
    const editionId = editionIdFromUrl(entry && entry.sourceUrl);
    const key = statusKey(title, publisher);

    if (!title || !publisher) continue;
    if (!editionId) {
      blocked.push({ seriesTitle: title, publisher, reasonCodes: ['no-manga-passion-edition'] });
      // keep any previously known value so non-mp sources are not dropped
      if (existingByKey.has(key)) byKey.set(key, existingByKey.get(key));
      continue;
    }

    if (!networkEnabled) {
      if (existingByKey.has(key)) byKey.set(key, existingByKey.get(key));
      continue;
    }

    let edition;
    try {
      edition = await fetchEdition(editionId);
    } catch (e) {
      blocked.push({ seriesTitle: title, publisher, editionId, reasonCodes: [`fetch-error:${e.message}`] });
      if (existingByKey.has(key)) byKey.set(key, existingByKey.get(key));
      await sleep(DEFAULT_DELAY_MS);
      continue;
    }

    const sourceStatus = Number(edition && edition.status);
    const ongoing = STATUS_MAP[sourceStatus];
    checked.push({ seriesTitle: title, publisher, editionId, sourceStatus });

    if (!ongoing) {
      blocked.push({ seriesTitle: title, publisher, editionId, reasonCodes: [`unmapped-status:${edition && edition.status}`] });
      if (existingByKey.has(key)) byKey.set(key, existingByKey.get(key));
      await sleep(DEFAULT_DELAY_MS);
      continue;
    }

    const prev = existingByKey.get(key);
    const item = {
      seriesTitle: title,
      publisher,
      ongoing,
      sourceStatus,
      editionId,
      source: 'manga-passion',
      sourceUrl: `https://www.manga-passion.de/editions/${editionId}`,
      confidence: 'high',
      checkedAt: startedAt,
    };
    byKey.set(key, item);
    if (!prev || prev.ongoing !== ongoing) {
      applied.push({ seriesTitle: title, publisher, oldOngoing: prev ? prev.ongoing : null, newOngoing: ongoing, editionId });
    }
    await sleep(DEFAULT_DELAY_MS);
  }

  const nextItems = sortItems([...byKey.values()]);
  const nextStatus = { schemaVersion: 1, generatedAt: startedAt, items: nextItems };
  nextStatus.generatedAt = stableGeneratedAt(statusFile, nextStatus);

  const validation = validateSeriesPublicationStatus(nextStatus);
  if (!validation.ok) {
    throw new Error(`series-publication-status validation failed: ${validation.errors.join('; ')}`);
  }

  if (JSON.stringify(existingStatus) !== JSON.stringify(nextStatus)) writeJsonStable(statusFile, nextStatus);

  const ongoingCount = nextItems.filter(i => i.ongoing === 'true').length;
  const finishedCount = nextItems.filter(i => i.ongoing === 'false').length;
  const report = {
    schemaVersion: 1,
    generatedAt: startedAt,
    source: 'run-series-publication-status.js',
    networkMode: networkEnabled ? 'enabled' : 'from-cache-only',
    summary: {
      seriesWithStatus: nextItems.length,
      ongoing: ongoingCount,
      finished: finishedCount,
      checkedEditions: checked.length,
      appliedChanges: applied.length,
      blockedOrUnmapped: blocked.length,
    },
    changes: applied,
    blocked,
    checked,
    changedFilesAllowlist: [
      'data/series-publication-status.json',
      'data/series-publication-status-report.json',
    ],
    privacyGateRequired: true,
  };
  report.generatedAt = stableGeneratedAt(reportFile, report);
  writeJsonStable(reportFile, report);

  console.log('Series-publication-status pipeline abgeschlossen.');
  console.log(`  Serien mit Status: ${nextItems.length} (laufend ${ongoingCount}, abgeschlossen ${finishedCount})`);
  console.log(`  Geaenderte Status: ${applied.length}`);
  console.log(`  Blockiert/unmapped: ${blocked.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('run-series-publication-status fehlgeschlagen:', error);
    process.exitCode = 1;
  });
}

module.exports = { editionIdFromUrl, statusKey, STATUS_MAP };
