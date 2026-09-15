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

test('classifyChangedPaths: an inert-prose-only delta is the ONLY thing that qualifies as low risk', () => {
  assert.equal(classifyChangedPaths(['README.md', 'docs/guide.md', 'notes.txt']).classification, 'DRIFT_LOW_RISK');
  assert.equal(classifyChangedPaths(['README.md', 'src/index.js']).classification, 'REVIEW_REQUIRED');
});

// In this ecosystem a Markdown file is frequently an INSTRUCTION AN AGENT
// EXECUTES, and the flagship watch entry (mattpocock/skills) is made almost
// entirely of them -- so treating .md as documentation meant its single most
// security-relevant change classified as "skip this". Reproduced by an
// independent Security Reviewer; every row here was a DRIFT_LOW_RISK before.
test('classifyChangedPaths: agent-executable Markdown escalates instead of passing as documentation', () => {
  for (const p of [
    'skills/my-skill/SKILL.md',
    '.claude/agents/builder.md',
    '.claude/commands/deploy.md',
    'agents/reviewer.md',
    'commands/run.mdx',
    'CLAUDE.md',
    'AGENTS.md',
  ]) {
    const res = classifyChangedPaths([p]);
    assert.equal(res.classification, 'SECURITY_REVIEW_REQUIRED', `${p} must escalate, not read as documentation`);
    assert.ok(res.reasons.includes('agent-instructions'), `${p} must name the agent-instructions signal`);
  }
  assert.equal(
    classifyChangedPaths(['README.md', 'skills/evil/SKILL.md']).classification,
    'SECURITY_REVIEW_REQUIRED',
    'one agent-instruction file among ordinary docs must still escalate the whole delta',
  );
});

// The old rule had a directory arm that matched ANY file under docs/ or
// examples/, regardless of extension -- executable code behind a
// documentation prefix, and in plugin repos examples/ routinely holds code
// users copy verbatim.
test('classifyChangedPaths: executable code under docs/ or examples/ is never low risk', () => {
  for (const p of ['docs/build.sh', 'doc/scripts/entrypoint.sh', 'docs/tools/run.py', 'examples/server.js', 'example/app.ts']) {
    assert.notEqual(classifyChangedPaths([p]).classification, 'DRIFT_LOW_RISK', `${p} must not be classified as documentation`);
  }
});

test('classifyChangedPaths: an implausibly long path escalates rather than being silently shortened into an inert match', () => {
  const res = classifyChangedPaths([`${'a'.repeat(600)}.md`]);
  assert.equal(res.classification, 'SECURITY_REVIEW_REQUIRED');
  assert.ok(res.reasons.includes('implausible-path-length'));
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

test('watchEntry: a non-GitHub TRUSTED source is reported unobservable rather than silently skipped', async () => {
  const res = await watchEntry({
    entry: { id: 'locally-detected', source: 'detected-locally' },
    toolsCatalog: { tools: [{ id: 'locally-detected', source: 'detected-locally', reviewedVersion: '1.0.0' }] },
    client: fakeClient(),
  });
  assert.equal(res.classification, 'SOURCE_UNAVAILABLE');
  assert.match(res.detail, /GitHub/);
});

// The trust boundary design Section 15.3 is built around. An independent
// Security Reviewer reproduced the inversion: the baseline ref came from the
// trusted catalog while the repository being observed came from the
// low-trust watch config, so a one-line edit there (a typo, a fork URL, a
// hostile PR to the "configuration-only" file) pointed the watch at a
// different repository whose matching tag then reported NO_DRIFT -- silencing
// that integration permanently with an affirmative healthy verdict.
test('watchEntry: a watch policy naming a DIFFERENT repository than the trusted catalog can never produce NO_DRIFT', async () => {
  const queried = [];
  const client = {
    ...fakeClient({ release: { ok: true, json: { tag_name: 'abc123' } } }),
    getLatestGithubRelease: async (owner, repo) => { queried.push(`${owner}/${repo}`); return { ok: true, json: { tag_name: 'abc123' } }; },
  };
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/attacker/r' },
    toolsCatalog: TOOLS, // trusted source is https://github.com/o/r
    client,
  });
  assert.equal(res.classification, 'SOURCE_UNAVAILABLE');
  assert.notEqual(res.classification, 'NO_DRIFT');
  assert.deepEqual(queried, [], 'the attacker-named repository must never even be contacted');
  assert.match(res.detail, /different repository/);
});

test('watchEntry: the repository actually observed is the TRUSTED catalog\'s, not the watch policy\'s', async () => {
  const queried = [];
  const client = {
    ...fakeClient(),
    getLatestGithubRelease: async (owner, repo) => { queried.push(`${owner}/${repo}`); return { ok: true, json: { tag_name: 'abc123' } }; },
  };
  await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client,
  });
  assert.deepEqual(queried, ['o/r']);
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

test('classifyChangedPaths: the extended escalation set covers the ecosystems this repository actually watches', () => {
  const cases = [
    ['Gemfile.lock', 'package-lifecycle'],
    ['composer.json', 'package-lifecycle'],
    ['go.sum', 'package-lifecycle'],
    ['poetry.lock', 'package-lifecycle'],
    ['krylo.gemspec', 'package-lifecycle'],
    ['.yarnrc.yml', 'credentials-or-network-config'],
    ['.pypirc', 'credentials-or-network-config'],
    ['Dockerfile.prod', 'credentials-or-network-config'],
    ['.github/workflows/release.yml', 'credentials-or-network-config'],
    ['.claude/settings.json', 'credentials-or-network-config'],
    ['dist/app.deb', 'binaries'],
    ['lib/libfoo.so.1', 'binaries'],
  ];
  for (const [file, expectedSignal] of cases) {
    const res = classifyChangedPaths([file]);
    assert.equal(res.classification, 'SECURITY_REVIEW_REQUIRED', `${file} must escalate`);
    assert.ok(res.reasons.includes(expectedSignal), `${file} must report ${expectedSignal}, got ${res.reasons.join(',')}`);
  }
});

// Found by an independent Security Reviewer as the one credible source of
// RECURRING noise: `3.8.49` vs `v3.8.49` is the same commit, but strict
// string inequality treated it as drift, the compare returned an identical
// (empty) result, and the empty-list rule then reported REVIEW_REQUIRED
// every week with a reason that was simply untrue.
test('watchEntry: refs that differ only in spelling are NO_DRIFT when upstream says they are the same commit', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-version', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v3.8.49' } },
      compare: (base) => (base === 'v3.8.49'
        ? { ok: true, json: { status: 'identical', total_commits: 0, ahead_by: 0, behind_by: 0, files: [] } }
        : { ok: false, reason: 'not-found' }),
    }),
  });
  assert.equal(res.classification, 'NO_DRIFT');
  assert.equal(res.comparedUsingRef, 'v3.8.49');
  assert.match(res.detail, /same commit/);
});

test('watchEntry: a genuinely empty file list on a NON-identical compare stays REVIEW_REQUIRED', async () => {
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: { ok: true, json: { status: 'ahead', total_commits: 40, files: [] } },
    }),
  });
  assert.equal(res.classification, 'REVIEW_REQUIRED');
});

test('watchEntry: the v-prefix fallback refuses a single-component ref, which is often a MOVING alias tag', async () => {
  const attempted = [];
  await watchEntry({
    entry: { id: 'major-only', source: 'https://github.com/o/r' },
    toolsCatalog: { tools: [{ id: 'major-only', source: 'https://github.com/o/r', reviewedVersion: '3' }] },
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v4' } },
      compare: (base) => { attempted.push(base); return { ok: false, reason: 'not-found' }; },
    }),
  });
  assert.deepEqual(attempted, ['3'], 'a bare major version must never be retried as the v-prefixed moving alias');
});

// Git permits LF in a path name and the API returns it verbatim, so a
// crafted filename could reproduce this report's own line format and inject
// a fabricated status line into the rendered report and the job summary.
test('watchEntry: control characters in upstream paths are neutralized, so a filename cannot forge a report line', async () => {
  const forged = 'docs/a\n            NO DRIFT   everything-is-fine.md';
  const res = await watchEntry({
    entry: { id: 'reviewed-by-commit', source: 'https://github.com/o/r' },
    toolsCatalog: TOOLS,
    client: fakeClient({
      release: { ok: true, json: { tag_name: 'v2.0.0' } },
      compare: { ok: true, json: { status: 'ahead', total_commits: 1, files: [{ filename: forged }, { filename: 'docs/b.md' }] } },
    }),
  });
  for (const sample of res.changedPathSample) {
    assert.doesNotMatch(sample, /[\u0000-\u001F\u007F]/, 'no control character may survive into the report');
    assert.doesNotMatch(sample, /\n/, 'a sampled path must never span lines');
  }
});

test('runUpstreamWatch: one entry whose client throws never blinds the whole watch', async () => {
  const throwing = {
    getLatestGithubRelease: async () => { throw new Error('boom'); },
    getGithubTags: async () => { throw new Error('boom'); },
    getGithubCommitForRef: async () => { throw new Error('boom'); },
    getGithubCompare: async () => { throw new Error('boom'); },
  };
  const report = await runUpstreamWatch({ repoRoot: REPO_ROOT, client: throwing });
  assert.ok(report.results.length > 0, 'every entry must still be reported');
  for (const r of report.results) {
    assert.equal(r.classification, 'SOURCE_UNAVAILABLE');
  }
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

// Complements the runtime refusal: the two shipped catalogs must actually
// agree today, so the refusal never has to fire in normal operation and a
// divergence shows up as a failing test rather than a silently skipped entry.
test('upstream-watch: every shipped watch entry names the same repository the trusted catalog does', () => {
  const watch = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'upstream-watch.json'), 'utf8'));
  const tools = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'tools.json'), 'utf8'));
  for (const entry of watch.entries) {
    const trusted = tools.tools.find((t) => t.id === entry.id);
    assert.ok(trusted, `watch entry ${entry.id} has no record in the trusted catalog`);
    assert.equal(entry.source, trusted.source, `watch entry ${entry.id} names a different source than tools.json does`);
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
