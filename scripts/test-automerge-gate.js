#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { evaluateAutoMergeGate } = require('./validate-release-cache-automerge-gate');

const allowedFiles = [
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
];

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    summary: {
      cachePatches: 0,
      ...overrides.summary,
    },
    autoMergeEligible: false,
    ...overrides,
  };
}

function queueEntry(overrides = {}) {
  return {
    queueKey: 'Example|Publisher|1',
    seriesTitle: 'Example',
    publisher: 'Publisher',
    volumeNumber: 1,
    safeToPatch: false,
    reviewStatus: 'auto-low-confidence',
    sourceUrl: '',
    releaseDate: null,
    checkedAt: '2026-05-20T00:00:00.000Z',
    evidence: '',
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateAutoMergeGate({
    changedFiles: allowedFiles,
    pipelineReport: report(),
    beforeQueue: [queueEntry()],
    afterQueue: [queueEntry()],
    ...overrides,
  });
}

function assertAllowed(name, result) {
  assert.strictEqual(result.allowed, true, `${name}: expected allowed, got ${result.reason}`);
}

function assertBlocked(name, result, reasonIncludes) {
  assert.strictEqual(result.allowed, false, `${name}: expected blocked`);
  if (reasonIncludes) {
    assert.match(result.reason, reasonIncludes, `${name}: unexpected reason: ${result.reason}`);
  }
}

const tests = [
  [
    'report + queue only with cachePatches=0 and unchanged safeToPatch is allowed',
    () => assertAllowed('allowed report queue', evaluate()),
  ],
  [
    'safeToPatch increase blocks',
    () =>
      assertBlocked(
        'safeToPatch increase',
        evaluate({
          afterQueue: [queueEntry({ safeToPatch: true, reviewStatus: 'ready-to-patch', sourceUrl: 'https://example.com', releaseDate: '2026-06-01', evidence: 'source', checkedAt: '2026-05-20T00:00:00.000Z' })],
        }),
        /safeToPatch=true count increased/,
      ),
  ],
  [
    'release-cache change blocks',
    () =>
      assertBlocked(
        'release-cache changed',
        evaluate({ changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'] }),
        /data\/release-cache\.json changed/,
      ),
  ],
  [
    'watchlist change blocks',
    () => assertBlocked('watchlist changed', evaluate({ changedFiles: ['data/release-watchlist.json'] }), /release-watchlist/),
  ],
  [
    'sources change blocks',
    () => assertBlocked('sources changed', evaluate({ changedFiles: ['data/release-sources.json'] }), /release-sources/),
  ],
  [
    'scripts change blocks',
    () => assertBlocked('scripts changed', evaluate({ changedFiles: ['scripts/foo.js'] }), /scripts\//),
  ],
  [
    'src change blocks',
    () => assertBlocked('src changed', evaluate({ changedFiles: ['src/app.js'] }), /src\//),
  ],
  [
    'workflow change blocks',
    () => assertBlocked('workflow changed', evaluate({ changedFiles: ['.github/workflows/update-release-cache.yml'] }), /\.github\//),
  ],
  [
    'supabase change blocks',
    () => assertBlocked('supabase changed', evaluate({ changedFiles: ['supabase/migrations/foo.sql'] }), /supabase\//),
  ],
  [
    'missing pipeline report blocks',
    () => assertBlocked('missing report', evaluate({ pipelineReport: null }), /Pipeline report fehlt/),
  ],
  [
    'invalid pipeline report blocks',
    () => assertBlocked('invalid report', evaluate({ pipelineReport: '{' }), /could not evaluate safely/),
  ],
  [
    'cachePatches > 0 blocks',
    () => assertBlocked('cache patches', evaluate({ pipelineReport: report({ summary: { cachePatches: 1 } }) }), /cachePatches is 1/),
  ],
  [
    'new releaseDate without sourceUrl blocks',
    () =>
      assertBlocked(
        'releaseDate without sourceUrl',
        evaluate({ afterQueue: [queueEntry({ releaseDate: '2026-06-01', checkedAt: '2026-05-20T00:00:00.000Z', evidence: 'source evidence' })] }),
        /new releaseDate/,
      ),
  ],
  [
    'new releaseDate without evidence blocks',
    () =>
      assertBlocked(
        'releaseDate without evidence',
        evaluate({ afterQueue: [queueEntry({ releaseDate: '2026-06-01', sourceUrl: 'https://example.com', checkedAt: '2026-05-20T00:00:00.000Z' })] }),
        /new releaseDate/,
      ),
  ],
  [
    'unknown reviewStatus blocks',
    () =>
      assertBlocked(
        'unknown reviewStatus',
        evaluate({ afterQueue: [queueEntry({ reviewStatus: 'mystery-status' })] }),
        /unknown reviewStatus/,
      ),
  ],
  [
    'JSON output shape is parseable',
    () => {
      const parsed = JSON.parse(JSON.stringify(evaluate()));
      assert.strictEqual(typeof parsed.allowed, 'boolean');
      assert.ok(Array.isArray(parsed.changedFiles));
    },
  ],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

console.log(`\nAuto-merge gate tests passed: ${passed}/${tests.length}`);
