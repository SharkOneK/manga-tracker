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

// Phase 85: shared fixture for the report-queue-with-volume-count-refresh combo
// class. Mirrors the real-world PR #320 shape (report/queue files alongside the
// --from-cache-only counts refresh, no data/release-cache.json patch) while
// staying on the "allowed" side by default so individual tests only need to
// override the one field that should trip a deny.
const comboCacheItem = cacheItem({ releaseDate: '2026-05-01' });

function comboScenario(overrides = {}) {
  return {
    changedFiles: [
      'data/release-cache-pipeline-report.json',
      'data/release-source-review-queue.json',
      'data/release-volume-counts.json',
      'data/release-volume-counts-report.json',
    ],
    pipelineReport: report(),
    beforeQueue: [queueEntry()],
    afterQueue: [queueEntry()],
    beforeCache: cacheDoc([comboCacheItem]),
    afterCache: cacheDoc([comboCacheItem]),
    countsDoc: volumeCountsDoc([volumeCountItemFromCache(comboCacheItem)]),
    beforeCountsDoc: volumeCountsDoc([]),
    reportDoc: volumeCountsReport({ providerMode: 'from-cache-only' }),
    sources: sourcesDoc,
    ...overrides,
  };
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
    'non-allowlisted docs change blocks',
    () => assertBlocked('docs changed', evaluate({ changedFiles: ['docs/some-other-doc.md'] }), /docs\//),
  ],
  [
    'generated coverage docs alongside report/queue are allowed',
    () => {
      const result = evaluate({
        changedFiles: [
          'data/release-cache-pipeline-report.json',
          'data/release-source-review-queue.json',
          'docs/release-cache-coverage-gaps.md',
          'docs/release-cache-source-gap-analysis.md',
        ],
      });
      assertAllowed('coverage docs with report/queue', result);
    },
  ],
  [
    'generated coverage docs alongside a safe release-cache add are allowed',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: [
          'data/release-cache.json',
          'data/release-cache-pipeline-report.json',
          'docs/release-cache-coverage-gaps.md',
          'docs/release-cache-source-gap-analysis.md',
        ],
        pipelineReport: releaseCacheReportFor(item),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('coverage docs with cache add', result);
      assert.strictEqual(result.class, 'release-cache-high-confidence-only');
    },
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
    // Phase 83: frueher 'release-cache report with reviewQueueWrites blocks'. Der Fall
    // blockt fachlich ueber autoMergeEligible, nicht mehr ueber die Queue-Writes.
    'release-cache report with autoMergeEligible=false blocks',
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
      assertBlocked('autoMergeEligible=false', result, /data gate failed/);
      assert.ok(result.errors.some(error => /autoMergeEligible/.test(error)));
    },
  ],
  [
    'release-cache report with blockedCandidates blocks',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item, {
          report: {
            summary: { cachePatches: 1, reviewQueueWrites: 0, invalidExistingCache: 0, blocked: 1 },
            blockedCandidates: [{ key: 'other', confidence: 'blocked' }],
          },
        }),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('blockedCandidates', result, /data gate failed/);
      assert.ok(result.errors.some(error => /blockedCandidates/.test(error)));
    },
  ],
  [
    // Phase 83: der reale Deadlock-Fall — die Pipeline schreibt in die Queue, aber
    // ausschliesslich in bereits bekannte Keys.
    'release-cache patch with only known queue keys is allowed',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item, {
          report: {
            summary: { cachePatches: 1, reviewQueueWrites: 1, invalidExistingCache: 0 },
            reviewQueueWrites: [{ key: 'Example|Publisher|1', confidence: 'low' }],
          },
        }),
        beforeQueue: [queueEntry()],
        afterQueue: [queueEntry({ reviewStatus: 'auto-medium-confidence' })],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('known queue keys with cache patch', result);
      assert.strictEqual(result.class, 'release-cache-high-confidence-only');
      assert.strictEqual(result.reviewQueueWrites, 1);
      assert.strictEqual(result.newQueueKeys, 0);
      assert.strictEqual(result.removedQueueKeys, 0);
    },
  ],
  [
    'a new review-queue key blocks the release-cache patch',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: [queueEntry()],
        afterQueue: [
          queueEntry(),
          queueEntry({ queueKey: 'Another Series|Publisher|2', seriesTitle: 'Another Series', volumeNumber: 2 }),
        ],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('new queue key', result, /data gate failed/);
      assert.ok(result.errors.some(error => /New review-queue key/.test(error)));
      assert.strictEqual(result.newQueueKeys, 1);
    },
  ],
  [
    // Nachbau des realen PR #305: der Lauf entfernt zwei Queue-Eintraege.
    'a removed review-queue key stays allowed',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: [
          queueEntry(),
          queueEntry({ queueKey: 'Gone Series|Publisher|3', seriesTitle: 'Gone Series', volumeNumber: 3 }),
        ],
        afterQueue: [queueEntry()],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('removed queue key', result);
      assert.strictEqual(result.removedQueueKeys, 1);
      assert.strictEqual(result.newQueueKeys, 0);
    },
  ],
  [
    // Regressionsschutz gegen den Index-Trap in entryKey(): updateReviewQueue()
    // sortiert die Queue bei jedem Lauf neu.
    'reordered review queue is not treated as new keys',
    () => {
      const item = cacheItem();
      const queue = [
        queueEntry(),
        queueEntry({ queueKey: 'Second Series|Publisher|2', seriesTitle: 'Second Series', volumeNumber: 2 }),
        queueEntry({ queueKey: 'Third Series|Publisher|3', seriesTitle: 'Third Series', volumeNumber: 3 }),
      ];
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: queue,
        afterQueue: [...queue].reverse(),
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('reordered queue', result);
      assert.strictEqual(result.newQueueKeys, 0);
      assert.strictEqual(result.removedQueueKeys, 0);
    },
  ],
  [
    'new safeToPatch entry without a matching cache patch blocks',
    () => {
      const item = cacheItem();
      const orphanSafeEntry = {
        queueKey: 'Unpatched Series|Egmont Manga|4',
        seriesTitle: 'Unpatched Series',
        publisher: 'Egmont Manga',
        volumeNumber: 4,
        reviewStatus: 'patched',
        releaseDate: null,
        sourceUrl: '',
        checkedAt: '2026-05-20T00:00:00.000Z',
        evidence: '',
      };
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: [queueEntry(orphanSafeEntry)],
        afterQueue: [queueEntry({ ...orphanSafeEntry, safeToPatch: true })],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('safeToPatch without cache patch', result, /data gate failed/);
      assert.ok(result.errors.some(error => /no matching cache patch/.test(error)));
    },
  ],
  [
    'new safeToPatch entry that matches the cache patch is allowed',
    () => {
      const item = cacheItem();
      const patchedEntry = {
        queueKey: 'Example Series|Egmont Manga|1',
        seriesTitle: item.seriesTitle,
        publisher: item.publisher,
        volumeNumber: item.volumeNumber,
        reviewStatus: 'patched',
        releaseDate: null,
        sourceUrl: '',
        checkedAt: '2026-05-20T00:00:00.000Z',
        evidence: '',
      };
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: [queueEntry(patchedEntry)],
        afterQueue: [queueEntry({ ...patchedEntry, safeToPatch: true })],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertAllowed('safeToPatch with matching cache patch', result);
    },
  ],
  [
    'queue entry without stable identity blocks',
    () => {
      const item = cacheItem();
      const result = evaluate({
        changedFiles: ['data/release-cache.json', 'data/release-cache-pipeline-report.json'],
        pipelineReport: releaseCacheReportFor(item),
        beforeQueue: [queueEntry()],
        afterQueue: [
          queueEntry(),
          queueEntry({ queueKey: '', seriesTitle: '', publisher: '', volumeNumber: '' }),
        ],
        beforeCache: cacheDoc([]),
        afterCache: cacheDoc([item]),
      });
      assertBlocked('queue entry without identity', result, /data gate failed/);
      assert.ok(result.errors.some(error => /stable identity/.test(error)));
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

  // ── Phase 85: report-queue-with-volume-count-refresh combo class ──────────
  // Real-world trigger: PR #320 (automated/release-cache-pipeline, opened
  // 2026-09-29) carried data/release-cache-pipeline-report.json and
  // data/release-volume-counts-report.json without any data/release-cache.json
  // patch and was wrongly denied as "not in the report/queue-only allowlist".
  [
    'report/queue files with a cache-covered volume-count increase is allowed as the combo class',
    () => {
      const result = evaluate(comboScenario());
      assertAllowed('combo allowed', result);
      assert.strictEqual(result.class, 'report-queue-with-volume-count-refresh');
      assert.strictEqual(result.volumeCountIncreases, 1);
    },
  ],
  [
    'combo with an unallowlisted path blocks at the Phase 45 allowlist',
    () =>
      assertBlocked(
        'combo unallowlisted path',
        evaluate(comboScenario({
          changedFiles: [
            ...comboScenario().changedFiles,
            'artifacts/release-cache-coverage-report.json',
          ],
        })),
        /is not in the Phase 45 allowlist/,
      ),
  ],
  [
    'combo with a non-allowlisted docs path blocks',
    () =>
      assertBlocked(
        'combo docs path',
        evaluate(comboScenario({
          changedFiles: [...comboScenario().changedFiles, 'docs/some-other-doc.md'],
        })),
        /docs\//,
      ),
  ],
  [
    'combo with cachePatches > 0 but no release-cache.json in the diff blocks',
    () =>
      assertBlocked(
        'combo cachePatches > 0',
        evaluate(comboScenario({ pipelineReport: report({ summary: { cachePatches: 1 } }) })),
        /cachePatches is 1/,
      ),
  ],
  [
    // Der Kerntest: eine Counts-Erhoehung, die der Cache nicht beweist, ist der
    // Tamper-Fall, gegen den die Kombi-Klasse ueberhaupt erst gebaut wurde.
    'combo with a volume-count increase not covered by the release cache blocks',
    () =>
      assertBlocked(
        'combo uncovered increase',
        evaluate(comboScenario({
          countsDoc: volumeCountsDoc([volumeCountItemFromCache(comboCacheItem, { publishedVolumesDE: 2 })]),
        })),
        /not covered by a high-confidence release-cache entry/,
      ),
  ],
  [
    // Das entfernte Item ist bewusst NICHT im Cache (kein stale/graceToday-
    // Baseline) — sonst wuerde bereits die Phase-43-Konsistenzpruefung greifen,
    // bevor die neue Monotonie-Pruefung ueberhaupt zum Zug kommt.
    'combo with a decreased or removed volume-count item blocks',
    () => {
      const unrelatedCountItem = {
        seriesTitle: 'Other Series',
        publisher: 'Egmont Manga',
        publishedVolumesDE: 5,
        source: 'manga-passion',
        sourceUrl: comboCacheItem.sourceUrl,
        confidence: 'high',
        checkedAt: comboCacheItem.checkedAt,
      };
      assertBlocked(
        'combo regressed counts',
        evaluate(comboScenario({
          beforeCountsDoc: volumeCountsDoc([volumeCountItemFromCache(comboCacheItem), unrelatedCountItem]),
          countsDoc: volumeCountsDoc([volumeCountItemFromCache(comboCacheItem)]),
        })),
        /decreased or dropped/,
      );
    },
  ],
  [
    'combo with providerMode other than from-cache-only blocks',
    () =>
      assertBlocked(
        'combo providerMode enabled',
        evaluate(comboScenario({ reportDoc: volumeCountsReport({ providerMode: 'enabled' }) })),
        /providerMode is not from-cache-only/,
      ),
  ],
  [
    'combo with a new safeToPatch queue entry blocks under the report/queue rules',
    () =>
      assertBlocked(
        'combo new safeToPatch',
        evaluate(comboScenario({
          afterQueue: [
            queueEntry({
              safeToPatch: true,
              reviewStatus: 'ready-to-patch',
              sourceUrl: 'https://example.com',
              releaseDate: '2026-06-01',
              evidence: 'source',
              checkedAt: '2026-05-20T00:00:00.000Z',
            }),
          ],
        })),
        /safeToPatch=true count increased/,
      ),
  ],
  [
    'combo with a missing base volume-counts document blocks fail-closed',
    () =>
      assertBlocked(
        'combo missing beforeCountsDoc',
        evaluate(comboScenario({ beforeCountsDoc: null })),
        /could not evaluate safely/,
      ),
  ],
  [
    'combo with a base volume-counts document lacking a usable items array blocks fail-closed',
    () =>
      // Phase 85 review finding: {} or {"items":null} is a plain object and used
      // to pass the old isPlainObject-only check, silently falling through to an
      // empty before-map in mapVolumeCountsByKey(). Distinct from the null case
      // above (which throws in parseJsonInput and hits the outer catch instead).
      assertBlocked(
        'combo beforeCountsDoc without items array',
        evaluate(comboScenario({ beforeCountsDoc: {} })),
        /could not be read/,
      ),
  ],
  [
    'regression: the three pre-existing classes are unaffected by the combo class',
    () => {
      const onlyCounts = evaluate({
        changedFiles: ['data/release-volume-counts.json', 'data/release-volume-counts-report.json'],
        beforeCache: cacheDoc([comboCacheItem]),
        afterCache: cacheDoc([comboCacheItem]),
        countsDoc: volumeCountsDoc([volumeCountItemFromCache(comboCacheItem)]),
        reportDoc: volumeCountsReport(),
      });
      assertAllowed('regression volume-count-refresh-only', onlyCounts);
      assert.strictEqual(onlyCounts.class, 'volume-count-refresh-only');

      const reportAndQueue = evaluate();
      assertAllowed('regression report-queue-only', reportAndQueue);
      assert.strictEqual(reportAndQueue.class, 'report-queue-only');

      const reportOnly = evaluate({ changedFiles: ['data/release-cache-pipeline-report.json'] });
      assertAllowed('regression report-only', reportOnly);
      assert.strictEqual(reportOnly.class, 'report-only');
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
