import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyChangedPaths,
  reviewedBaselineFor,
  watchEntry,
  worstClassification,
  runUpstreamWatch,
  computeWatchExitCode,
  DRIFT_CLASSIFICATIONS,
} from '../../scripts/maintenance/checks/upstream-watch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

// Every test drives an injected fake client: this suite must stay hermetic,
// and the failure paths below (rate limiting, not-found, malformed JSON)
// cannot be provoked reliably against a real upstream anyway.
function fakeClient({ release, tags, commit, compare } = {}) {
  return {
    getLatestGithubRelease: async () => release ?? { ok: false, reason: 'not-found' },
    getGithubTags: async () => tags ?? { ok: false, reason: 'not-found' },
    getGithubCommitForRef: async () => commit ?? { ok: false, reason: 'not-found' },
    getGithubCompare: async (owner, repo, base) => (typeof compare === 'function' ? compare(base) : (compare ?? { ok: false, reason: 'not-found' })),
  };
}

const TOOLS = {
  tools: [
    { id: 'reviewed-by-commit', source: 'https://github.com/o/r', reviewedCommit: 'abc123', trustTier: 'B' },
    { id: 'reviewed-by-version', source: 'https://github.com/o/r', reviewedVersion: '3.8.49', trustTier: 'B' },
    { id: 'never-reviewed', source: 'https://github.com/o/r', reviewedVersion: 'pending-first-review', trustTier: 'B' },
  ],
};

test('upstream-watch: only design Section 15.6\'s five classifications exist', () => {
  assert.deepEqual(DRIFT_CLASSIFICATIONS, [
    'NO_DRIFT', 'DRIFT_LOW_RISK', 'REVIEW_REQUIRED', 'SECURITY_REVIEW_REQUIRED', 'SOURCE_UNAVAILABLE',
  ]);
});

test('classifyChangedPaths: a documentation-only delta is the ONLY thing that qualifies as low risk', () => {
  assert.equal(classifyChangedPaths(['README.md', 'docs/guide.md', 'notes.txt']).classification, 'DRIFT_LOW_RISK');
  assert.equal(classifyChangedPaths(['README.md', 'src/index.js']).classification, 'REVIEW_REQUIRED');
});

test('classifyChangedPaths: each security-sensitive path class escalates, and names why', () => {
  const cases = [
    ['package.json', 'package-lifecycle'],
    ['pnpm-lock.yaml', 'package-lifecycle'],
    ['scripts/postinstall.js', 'install-scripts'],
    ['hooks/hooks.json', 'hooks'],
    ['.claude-plugin/plugin.json', 'plugin-manifests'],
    ['config/mcp-servers.json', 'mcp-inventory'],
    ['LICENSE', 'license'],
    ['bin/tool.exe', 'binaries'],
    ['.npmrc', 'credentials-or-network-config'],
  ];
  for (const [file, expectedSignal] of cases) {
    const result = classifyChangedPaths([file]);
    assert.equal(result.classification, 'SECURITY_REVIEW_REQUIRED', `${file} must escalate`);
    assert.ok(result.reasons.includes(expectedSignal), `${file} must report the ${expectedSignal} signal, got ${result.reasons.join(',')}`);
  }
});

// The refs genuinely differ by the time this is reached, so "no files" means
// the comparison did not tell us what changed (GitHub truncates very large
// diffs) -- calling that low risk would be exactly the silent downgrade this
// subsystem exists to prevent.
test('classifyChangedPaths: an empty or truncated file list is REVIEW_REQUIRED, never low risk', () => {
  assert.equal(classifyChangedPaths([]).classification, 'REVIEW_REQUIRED');
  assert.equal(classifyChangedPaths(null).classification, 'REVIEW_REQUIRED');
});

test('reviewedBaselineFor: reads the trusted catalog only, and refuses a pending-first-review entry as a baseline', () => {
  assert.deepEqual(reviewedBaselineFor(TOOLS, 'reviewed-by-commit').ref, 'abc123');
  assert.deepEqual(reviewedBaselineFor(TOOLS, 'reviewed-by-version').ref, '3.8.49');
  assert.equal(reviewedBaselineFor(TOOLS, 'never-reviewed').ok, false);
  assert.equal(reviewedBaselineFor(TOOLS, 'never-reviewed').reason, 'no-reviewed-ref');
  assert.equal(reviewedBaselineFor(TOOLS, 'not-in-catalog-at-all').reason, 'not-in-trusted-catalog');
});

test('watchEntry: an exact ref match reports NO_DRIFT', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r', riskClass: 'medium' },
    toolsCatalog: TOOLS,
    client: fakeClient({ release: { ok: true, json: { tag_name: 'abc123' } } }),
  });
  assert.equal(res.classification, 'NO_DRIFT');
  assert.equal(res.observedRef, 'abc123');
});

// The single most important failure property: a watch that could not SEE
// upstream must never present itself as a clean bill of health.
test('watchEntry: every transport failure yields SOURCE_UNAVAILABLE, never NO_DRIFT', async () => {
  for (const reason of ['timeout', 'network-error', 'rate-limited', 'http-500', 'invalid-json']) {
    const res = await watchEntry({
      entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
      toolsCatalog: TOOLS,
      client: fakeClient({
        release: { ok: false, reason },
        tags: { ok: false, reason },
        commit: { ok: false, reason },
      }),
    });
    assert.equal(res.classification, 'SOURCE_UNAVAILABLE', `${reason} must not be reported as drift-free`);
    assert.notEqual(res.classification, 'NO_DRIFT');
  }
});

test('watchEntry: offline never contacts upstream and never guesses a verdict', async () => {
  let contacted = false;
  const client = fakeClient({ release: { ok: true, json: { tag_name: 'v9' } } });
  const spy = { ...client, getLatestGithubRelease: async () => { contacted = true; return { ok: true, json: { tag_name: 'v9' } }; } };
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: spy,
    offline: true,
  });
  assert.equal(contacted, false, 'offline mode must make no upstream call at all');
  assert.equal(res.classification, 'SOURCE_UNAVAILABLE');
});

test('watchEntry: a non-GitHub source is reported unobservable rather than silently skipped', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'detected-locally' },
    toolsCatalog: TOOLS,
    client: fakeClient(),
  });
  assert.equal(res.classification, 'SOURCE_UNAVAILABLE');
  assert.match(res.detail, /GitHub/);
});

test('watchEntry: real drift with a security-sensitive delta escalates and names the signals', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: { ok: true, json: { total_commits: 12, files: [{ filename: 'package.json' }, { filename: 'README.md' }] } },
    }),
  });
  assert.equal(res.classification, 'SECURITY_REVIEW_REQUIRED');
  assert.ok(res.reasons.includes('package-lifecycle'));
  assert.equal(res.changedFileCount, 2);
  assert.equal(res.commitCount, 12);
});

test('watchEntry: drift whose change list cannot be read stays REVIEW_REQUIRED, never low risk', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: { ok: false, reason: 'rate-limited' },
    }),
  });
  assert.equal(res.classification, 'REVIEW_REQUIRED');
  assert.match(res.detail, /could not be read/);
});

// Observed live against OmniRoute: tools.json records `3.8.49` while the
// repository tags it `v3.8.49`, so the recorded form 404s and every such
// entry would degrade to "unanalyzed" forever.
test('watchEntry: a bare-version baseline falls back to the v-prefixed tag of the SAME version, and discloses it', async () => {
  const attempted = [];
  const res = await watchEntry({
    entry: { id: 'reviewed-by-version', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v3.8.50' } },
      compare: (base) => {
        attempted.push(base);
        return base === 'v3.8.49'
          ? { ok: true, json: { total_commits: 1, files: [{ filename: 'README.md' }] } }
          : { ok: false, reason: 'not-found' };
      },
    }),
  });
  assert.deepEqual(attempted, ['3.8.49', 'v3.8.49'], 'the recorded form must be tried first, the v-prefixed form only as fallback');
  assert.equal(res.classification, 'DRIFT_LOW_RISK');
  assert.equal(res.comparedUsingRef, 'v3.8.49', 'the report must disclose that the recorded ref did not resolve as written');
});

test('watchEntry: the fallback never invents a DIFFERENT version, only the v-prefix spelling', async () => {
  const attempted = [];
  await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' }, // baseline is a commit sha, not a version
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: (base) => { attempted.push(base); return { ok: false, reason: 'not-found' }; },
    }),
  });
  assert.deepEqual(attempted, ['abc123'], 'a non-version ref must be tried exactly once, with no alternate spelling invented');
});

// Upstream file paths are attacker-influenceable content.
test('watchEntry: upstream-supplied paths are bounded and redacted before reaching the report', async () => {
  const hostilePath = `${'A'.repeat(500)}/ghp_0123456789abcdefghijklmnopqrstuvwxyzAB/x.js`;
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: { ok: true, json: { total_commits: 1, files: Array.from({ length: 50 }, () => ({ filename: hostilePath })) } },
    }),
  });
  assert.ok(res.changedPathSample.length <= 10, 'the sample must be bounded, not the whole upstream list');
  for (const sample of res.changedPathSample) {
    assert.ok(sample.length <= 120, 'each sampled path must be length-bounded');
  }
  assert.doesNotMatch(JSON.stringify(res), /ghp_0123456789abcdefghijklmnopqrstuvwxyzAB/, 'a token-shaped fragment must be redacted out of the report');
});

test('worstClassification: SOURCE_UNAVAILABLE outranks NO_DRIFT so a blind run never looks healthy', () => {
  assert.equal(worstClassification(['NO_DRIFT', 'SOURCE_UNAVAILABLE']), 'SOURCE_UNAVAILABLE');
  assert.equal(worstClassification(['REVIEW_REQUIRED', 'SECURITY_REVIEW_REQUIRED']), 'SECURITY_REVIEW_REQUIRED');
  assert.equal(worstClassification(['NO_DRIFT', 'DRIFT_LOW_RISK']), 'DRIFT_LOW_RISK');
  assert.equal(worstClassification([]), 'NO_DRIFT');
});

test('runUpstreamWatch: an unreadable catalog is an internal failure (exit 2), not a silent clean report', async () => {
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-watch-empty-'));
  try {
    const report = await runUpstreamWatch({ repoRoot: emptyRepo, offline: true });
    assert.equal(report.error, 'catalog-unreadable');
    assert.equal(report.overall, 'SOURCE_UNAVAILABLE');
    assert.equal(computeWatchExitCode(report), 2);
  } finally {
    fs.rmSync(emptyRepo, { recursive: true, force: true });
  }
});

// Design Section 15.6 / 21: drift is evidence for a human review, never a
// build failure -- this workflow must never be able to block a PR or release.
test('runUpstreamWatch: finding drift still exits 0', () => {
  assert.equal(computeWatchExitCode({ overall: 'SECURITY_REVIEW_REQUIRED', results: [] }), 0);
});

test('runUpstreamWatch: runs the REAL repository catalogs offline without touching them', async () => {
  const toolsPath = path.join(PLUGIN_ROOT, 'catalog', 'tools.json');
  const watchPath = path.join(PLUGIN_ROOT, 'catalog', 'upstream-watch.json');
  const beforeTools = fs.readFileSync(toolsPath, 'utf8');
  const beforeWatch = fs.readFileSync(watchPath, 'utf8');

  const report = await runUpstreamWatch({ repoRoot: REPO_ROOT, offline: true });
  assert.ok(report.results.length > 0, 'the shipped watch policy must contain at least one entry');
  for (const r of report.results) {
    assert.ok(DRIFT_CLASSIFICATIONS.includes(r.classification));
  }

  assert.equal(fs.readFileSync(toolsPath, 'utf8'), beforeTools, 'the TRUSTED catalog must never be written by a watch run');
  assert.equal(fs.readFileSync(watchPath, 'utf8'), beforeWatch, 'the watch policy must never be rewritten by a watch run');
});

// Design Section 15.5 forbids executing anything from a candidate. Asserted
// structurally rather than behaviourally: a module that cannot spawn a
// process cannot run a candidate's install script, hook, or build system.
test('upstream-watch: the checker has no process-execution capability at all', () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'maintenance', 'checks', 'upstream-watch.mjs'), 'utf8');
  for (const forbidden of ['child_process', 'execSync', 'execFileSync', 'spawnSync', 'spawn(']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the watch checker must never reference ${forbidden}`);
  }
});

test('upstream-watch: the watch policy stores configuration only, never observed upstream state', () => {
  const watch = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'upstream-watch.json'), 'utf8'));
  for (const entry of watch.entries) {
    assert.equal(entry.reviewedRefSource, 'tools.json', 'every baseline must come from the trusted catalog at runtime');
    for (const forbidden of ['observedLatestRef', 'reviewedVersion', 'reviewedCommit', 'latest']) {
      assert.ok(!(forbidden in entry), `the watch policy must not carry ${forbidden}: that would make unreviewed upstream state persistent and trusted`);
    }
  }
});
