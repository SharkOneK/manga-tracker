#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateAutoMergeGate, getChangedFiles } = require('./validate-release-cache-automerge-gate');

const allowedReportQueueFiles = [
  'data/release-cache-pipeline-report.json',
  'data/release-source-review-queue.json',
];

const sourcesDoc = {
  schemaVersion: 1,
  sources: [
    {
      id: 'manga-passion',
      name: 'Manga Passion',
      publisherAliases: [],
      baseUrl: 'https://www.manga-passion.de',
      allowedUrls: ['https://www.manga-passion.de'],
      enabled: true,
    },
    {
      id: 'egmont',
      name: 'Egmont Manga',
      publisherAliases: ['Egmont', 'Egmont Manga'],
      baseUrl: 'https://www.egmont-manga.de',
      allowedUrls: ['https://www.egmont-manga.de'],
      enabled: true,
    },
  ],
};

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'run-release-cache-pipeline.js',
    summary: {
      cachePatches: 0,
      reviewQueueWrites: 0,
      invalidExistingCache: 0,
      ...overrides.summary,
    },
    cachePatches: [],
    reviewQueueWrites: [],
    blockedCandidates: [],
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

function cacheItem(overrides = {}) {
  return {
    seriesTitle: 'Example Series',
    normalizedSeriesTitle: 'example series',
    publisher: 'Egmont Manga',
    normalizedPublisher: 'egmont manga',
    volumeNumber: 1,
    releaseDate: '2099-06-01',
    isbn13: null,
    coverUrl: null,
    sourceUrl: 'https://www.manga-passion.de/editions/1234',
    sourceName: 'Manga Passion',
    providerId: 'manga-passion',
    evidence: 'Manga Passion Edition, Verlag und Bandnummer wurden gegen die Bandliste abgeglichen.',
    confidence: 'high',
    notes: 'Automatisch per Release-Cache-Pipeline bestaetigt.',
    checkedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function cacheDoc(items = []) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-27T00:00:00.000Z',
    source: 'run-release-cache-pipeline.js',
    itemCount: items.length,
    items,
  };
}


function volumeCountsDoc(items = []) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-30T00:00:00.000Z',
    items,
  };
}

function volumeCountItemFromCache(item, overrides = {}) {
  return {
    seriesTitle: item.seriesTitle,
    publisher: item.publisher,
    publishedVolumesDE: item.volumeNumber,
    source: 'manga-passion',
    sourceUrl: item.sourceUrl,
    confidence: 'high',
    checkedAt: item.checkedAt,
    ...overrides,
  };
}

function volumeCountsReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-30T00:00:00.000Z',
    summary: { appliedHighConfidenceChanges: 1, blockedOrUnsafe: 0 },
    blockedCandidates: [],
    privacyGateRequired: true,
    ...overrides,
  };
}

function releaseCacheReportFor(item, overrides = {}) {
  return report({
    summary: { cachePatches: 1, reviewQueueWrites: 0, invalidExistingCache: 0 },
    autoMergeEligible: true,
    cachePatches: [
      {
        action: 'add',
        key: `${item.normalizedSeriesTitle}|${item.normalizedPublisher}|${item.volumeNumber}`,
        seriesTitle: item.seriesTitle,
        publisher: item.publisher,
        volumeNumber: item.volumeNumber,
        releaseDate: item.releaseDate,
        sourceName: item.sourceName,
        providerId: item.providerId,
        sourceUrl: item.sourceUrl,
        confidence: item.confidence,
        ...overrides.patch,
      },
    ],
    ...overrides.report,
  });
}

function evaluate(overrides = {}) {
  return evaluateAutoMergeGate({
    changedFiles: allowedReportQueueFiles,
    pipelineReport: report(),
    beforeQueue: [queueEntry()],
    afterQueue: [queueEntry()],
    beforeCache: cacheDoc([]),
    afterCache: cacheDoc([]),
    sources: sourcesDoc,
    ...overrides,
  });
}

function assertAllowed(name, result) {
  assert.strictEqual(result.allowed, true, `${name}: expected allowed, got ${result.reason}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
}

function assertBlocked(name, result, reasonIncludes) {
  assert.strictEqual(result.allowed, false, `${name}: expected blocked`);
  if (reasonIncludes) {
    assert.match(result.reason, reasonIncludes, `${name}: unexpected reason: ${result.reason}`);
  }
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function withTempGitRepo(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-tracker-automerge-gate-'));
  try {
    runGit(tempDir, ['init', '-b', 'main']);
    runGit(tempDir, ['config', 'user.email', 'tests@example.invalid']);
    runGit(tempDir, ['config', 'user.name', 'Automerge Gate Tests']);

    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'artifacts/\n.tmp.driveupload/\nnode_modules/\n');
    fs.writeFileSync(path.join(tempDir, 'data/release-cache-pipeline-report.json'), `${JSON.stringify(report(), null, 2)}\n`);
    runGit(tempDir, ['add', '.']);
    runGit(tempDir, ['commit', '-m', 'initial release cache files']);

    runGit(tempDir, ['switch', '-c', 'bot-release-cache']);
    fs.writeFileSync(path.join(tempDir, 'data/release-cache-pipeline-report.json'), `${JSON.stringify(report({ generatedAt: '2026-05-25T00:00:00.000Z' }), null, 2)}\n`);
    runGit(tempDir, ['add', 'data/release-cache-pipeline-report.json']);
    runGit(tempDir, ['commit', '-m', 'update report']);

    fs.mkdirSync(path.join(tempDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'artifacts/release-cache-coverage-report.json'), '{}\n');

    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const tests = [
  [
    'report + queue only with cachePatches=0 and unchanged safeToPatch is allowed',
    () => assertAllowed('allowed report queue', evaluate()),
  ],
  [
    'report-only with cachePatches=0 is allowed and classified separately',
    () => {
      const result = evaluate({ changedFiles: ['data/release-cache-pipeline-report.json'] });
      assertAllowed('report-only', result);
      assert.strictEqual(result.class, 'report-only');
    },
  ],
  [
    'safe high-confidence release-cache add is allowed by Phase 45 data gate',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('safe release-cache add', result);
      assert.strictEqual(result.class, 'release-cache-high-confidence-only');
    },
  ],
  [
    'safe high-confidence release-cache update is allowed by Phase 45 data gate',
    () => {
      const before = cacheItem({ releaseDate: '2026-05-01', checkedAt: '2026-05-20T00:00:00.000Z' });
      // Zukunftsdatum (noch nicht erschienen) statt eines fixen Datums, das mit
      // fortschreitender Zeit zur Vergangenheit wird und dann faelschlich den
      // Cache/Volume-Count-Konsistenz-Guard ausloest (isPastOrToday).
      const after = cacheItem({ releaseDate: '2099-06-01', checkedAt: '2026-05-27T00:00:00.000Z' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(after),
        beforeCache: cacheDoc([before]),
        afterCache: cacheDoc([after]),
      });
      assertAllowed('safe release-cache update', result);
    },
  ],

  [
    'past high-confidence release-cache add without volume-count refresh blocks as inconsistent',
    () => {
      const item = cacheItem({ releaseDate: '2026-05-01' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
        countsDoc: volumeCountsDoc([]),
        reportDoc: volumeCountsReport(),
      });
      assertBlocked('stale downstream volume counts', result, /inconsistent/);
      assert.ok(result.errors.some(error => /release-volume-counts is stale/.test(error)));
    },
  ],
  [
    'past high-confidence release-cache add with volume-count refresh is allowed',
    () => {
      const item = cacheItem({ releaseDate: '2026-05-01' });
      const result = evaluate({
        changedFiles: [
          'data/release-cache.json',
          'data/release-cache-pipeline-report.json',
          'data/release-volume-counts.json',
          'data/release-volume-counts-report.json',
        ],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
        countsDoc: volumeCountsDoc([volumeCountItemFromCache(item)]),
        reportDoc: volumeCountsReport(),
      });
      assertAllowed('cache add with downstream volume refresh', result);
      assert.strictEqual(result.class, 'release-cache-with-volume-count-refresh');
    },
  ],
  [
    'standard changed-file discovery ignores untracked artifacts',
    () =>
      withTempGitRepo((repo) => {
        assert.deepStrictEqual(getChangedFiles('main', { cwd: repo }), ['data/release-cache-pipeline-report.json']);
      }),
  ],
  [
    '--include-worktree changed-file discovery includes ignored artifacts for diagnosis',
    () =>
      withTempGitRepo((repo) => {
        const changedFiles = getChangedFiles('main', { cwd: repo, includeWorktree: true });
        assert.ok(changedFiles.includes('data/release-cache-pipeline-report.json'));
        assert.ok(changedFiles.includes('artifacts/release-cache-coverage-report.json'));
      }),
  ],
  [
    'committed artifact path blocks',
    () =>
      assertBlocked(
        'committed artifact path',
        evaluate({ changedFiles: ['data/release-cache-pipeline-report.json', 'artifacts/release-cache-coverage-report.json'] }),
        /artifacts\/release-cache-coverage-report\.json is not in the Phase 45 allowlist/,
      ),
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
    'docs change blocks',
    () => assertBlocked('docs changed', evaluate({ changedFiles: ['docs/release-cache-coverage-gaps.md'] }), /docs\//),
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
    'cachePatches > 0 blocks report/queue-only class',
    () => assertBlocked('cache patches', evaluate({ pipelineReport: report({ summary: { cachePatches: 1 } }) }), /cachePatches is 1/),
  ],
  [
    'release-cache change without report blocks',
    () => assertBlocked('cache without report', evaluate({ changedFiles: ['data/release-cache.json'] }), /require data\/release-cache-pipeline-report\.json/),
  ],
  [
    'release-cache delete blocks',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([item]),
        afterCache: cacheDoc([]),
      });
      assertBlocked('cache delete', result, /data gate failed/);
      assert.ok(result.errors.some(error => /deletions/.test(error)));
    },
  ],
  [
    'release-cache low confidence blocks',
    () => {
      const item = cacheItem({ confidence: 'medium' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item, { patch: { confidence: 'medium' } }),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('low confidence cache item', result, /data gate failed/);
      assert.ok(result.errors.some(error => /confidence/.test(error)));
    },
  ],
  [
    'release-cache item without providerId blocks',
    () => {
      const item = cacheItem({ providerId: null });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item, { patch: { providerId: null } }),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('missing providerId', result, /data gate failed/);
      assert.ok(result.errors.some(error => /providerId/.test(error)));
    },
  ],
  [
    'release-cache item with private field blocks',
    () => {
      const item = cacheItem({ ownerId: 'private-user' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('private field', result, /data gate failed/);
      assert.ok(result.errors.some(error => /private field/.test(error)));
    },
  ],
  [
    'release-cache item with empty publisher blocks',
    () => {
      const item = cacheItem({ publisher: '', normalizedPublisher: '' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('empty publisher', result, /data gate failed/);
      assert.ok(result.errors.some(error => /publisher/.test(error)));
    },
  ],
  [
    'release-cache item with disallowed source URL blocks',
    () => {
      const item = cacheItem({ sourceUrl: 'https://example.invalid/editions/1' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('disallowed source', result, /data gate failed/);
      assert.ok(result.errors.some(error => /sourceUrl/.test(error)));
    },
  ],
  [
    'release-cache item for special edition blocks',
    () => {
      const item = cacheItem({ seriesTitle: 'Example Master Edition', normalizedSeriesTitle: 'example master edition' });
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('special edition', result, /data gate failed/);
      assert.ok(result.errors.some(error => /special edition/.test(error)));
    },
  ],
  [
    'release-cache report with reviewQueueWrites blocks',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item, {
          report: {
            autoMergeEligible: false,
            summary: { cachePatches: 1, reviewQueueWrites: 1, invalidExistingCache: 0 },
            reviewQueueWrites: [{ key: 'other', confidence: 'low' }],
          },
        }),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('reviewQueueWrites', result, /data gate failed/);
      assert.ok(result.errors.some(error => /reviewQueueWrites|autoMergeEligible/.test(error)));
    },
  ],
  [
    'new releaseDate in queue without sourceUrl blocks',
    () =>
      assertBlocked(
        'releaseDate without sourceUrl',
        evaluate({ afterQueue: [queueEntry({ releaseDate: '2026-06-01', checkedAt: '2026-05-20T00:00:00.000Z', evidence: 'source evidence' })] }),
        /new releaseDate/,
      ),
  ],
  [
    'new releaseDate in queue without evidence blocks',
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
