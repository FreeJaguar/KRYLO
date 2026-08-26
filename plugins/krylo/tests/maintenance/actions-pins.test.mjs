// TDD category E (task Section 19.E): GitHub Actions pin checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runActionsPinsChecks } from '../../scripts/maintenance/checks/actions-pins.mjs';

const FULL_SHA = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';

function makeFixtureRepo(workflowContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-actions-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'sample.yml'), workflowContent);
  return dir;
}

test('full SHA accepted: a properly pinned action is ok', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('tag rejected: a mutable tag reference (not a full SHA) is flagged critical', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@v7`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed');
  assert.equal(format.severity, 'critical');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('branch rejected: a branch reference is flagged critical', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@main`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('latest rejected: `@latest` is flagged critical, exactly like any other mutable ref', async () => {
  const repoRoot = makeFixtureRepo(`- uses: some/action@latest`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('unknown publisher metadata / expected SHA-version consistency: a mismatched tag->SHA mapping is flagged high', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const upstream = {
    async getGithubCommitForRef() {
      return { ok: true, json: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } };
    },
  };
  const results = await runActionsPinsChecks({ repoRoot, offline: false, upstream });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'changed');
  assert.equal(drift.severity, 'high');
  assert.equal(drift.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('SHA/version annotation consistency: a matching tag->SHA mapping is ok', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const upstream = {
    async getGithubCommitForRef() {
      return { ok: true, json: { sha: FULL_SHA } };
    },
  };
  const results = await runActionsPinsChecks({ repoRoot, offline: false, upstream });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('missing version comment is a low-severity warning, not a hard failure', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA}`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const annotated = results.find((r) => r.id === 'actions-pins-version-annotated');
  assert.equal(annotated.status, 'warning');
  assert.equal(annotated.severity, 'low');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('offline mode never claims the SHA-vs-tag resolution passed', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'unavailable');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
