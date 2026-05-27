#!/usr/bin/env node
'use strict';

/**
 * Phase 46c — GitHub-Pages Live-Smoke.
 *
 * Read-only network smoke for the published static site. This script is
 * intentionally not part of the offline validation runner's executed checks;
 * CI only syntax-checks it. The scheduled workflow runs it against GitHub Pages.
 *
 * Usage:
 *   node scripts/live-smoke-pages.js
 *   node scripts/live-smoke-pages.js --base-url https://example.github.io/manga-tracker/
 *
 * Environment:
 *   LIVE_SMOKE_BASE_URL  Optional base URL. Defaults to the production Pages URL.
 */

const DEFAULT_BASE_URL = 'https://sharkonek.github.io/manga-tracker/';
const TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.LIVE_SMOKE_BASE_URL || DEFAULT_BASE_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') {
      args.baseUrl = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/live-smoke-pages.js [--base-url <url>]',
        '',
        `Default base URL: ${DEFAULT_BASE_URL}`,
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.baseUrl || !/^https?:\/\//i.test(args.baseUrl)) {
    throw new Error(`Invalid base URL: ${args.baseUrl || '(empty)'}`);
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, '/') ;
  return args;
}

function urlFor(baseUrl, relativePath) {
  return new URL(relativePath.replace(/^\/+/, ''), baseUrl).toString();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'manga-tracker-live-smoke/1.0',
        'Accept': '*/*',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkText(baseUrl, relativePath, markers) {
  const url = urlFor(baseUrl, relativePath);
  const response = await fetchWithTimeout(url);
  assert(response.status === 200, `${relativePath}: expected HTTP 200, got ${response.status}`);

  const text = await response.text();
  for (const marker of markers) {
    assert(text.includes(marker), `${relativePath}: missing marker ${JSON.stringify(marker)}`);
  }

  return {
    path: relativePath,
    status: response.status,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

async function checkJson(baseUrl, relativePath, validate) {
  const url = urlFor(baseUrl, relativePath);
  const response = await fetchWithTimeout(url);
  assert(response.status === 200, `${relativePath}: expected HTTP 200, got ${response.status}`);

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${relativePath}: invalid JSON (${error.message})`);
  }

  validate(parsed);

  return {
    path: relativePath,
    status: response.status,
    bytes: Buffer.byteLength(text, 'utf8'),
    items: Array.isArray(parsed.items) ? parsed.items.length : undefined,
  };
}

function validateReleaseCache(json) {
  assert(json && typeof json === 'object', 'release-cache: root must be an object');
  assert(json.schemaVersion === 1, 'release-cache: schemaVersion must be 1');
  assert(Array.isArray(json.items), 'release-cache: items must be an array');
  assert(json.items.length > 0, 'release-cache: items must not be empty');
  assert(
    typeof json.itemCount === 'number' && json.itemCount === json.items.length,
    'release-cache: itemCount must match items.length',
  );
}

function validateReleaseVolumeCounts(json) {
  assert(json && typeof json === 'object', 'release-volume-counts: root must be an object');
  assert(json.schemaVersion === 1, 'release-volume-counts: schemaVersion must be 1');
  assert(Array.isArray(json.items), 'release-volume-counts: items must be an array');
  assert(json.items.length > 0, 'release-volume-counts: items must not be empty');
}

async function main() {
  const { baseUrl } = parseArgs(process.argv.slice(2));
  const checks = [
    () => checkText(baseUrl, 'index.html', [
      'Content-Security-Policy',
      "script-src 'self'",
      './src/styles.css',
      './src/app.js',
    ]),
    () => checkText(baseUrl, 'src/app.js', [
      'function renderDashboard',
      'release-cache.json',
    ]),
    () => checkText(baseUrl, 'src/styles.css', [
      ':root',
      'body',
    ]),
    () => checkJson(baseUrl, 'data/release-cache.json', validateReleaseCache),
    () => checkJson(baseUrl, 'data/release-volume-counts.json', validateReleaseVolumeCounts),
  ];

  console.log(`Live-Smoke base URL: ${baseUrl}`);
  const results = [];
  for (const check of checks) {
    const result = await check();
    results.push(result);
    const extra = typeof result.items === 'number' ? `, items=${result.items}` : '';
    console.log(`✓ ${result.path}: HTTP ${result.status}, ${result.bytes} bytes${extra}`);
  }

  console.log(`\n✅ Live-Smoke passed — ${results.length}/${checks.length} checks green`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n✖ Live-Smoke failed: ${error.message}`);
    // Do not call process.exit() directly: on Windows, undici/fetch cleanup can
    // still have libuv handles in flight after a failed request. Setting
    // exitCode preserves the non-zero result without aborting cleanup.
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  validateReleaseCache,
  validateReleaseVolumeCounts,
};
