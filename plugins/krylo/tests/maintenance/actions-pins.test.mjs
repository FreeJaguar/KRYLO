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

test('tag rejected: a mutable tag reference (not a full SHA) is flagged high (task severity ladder reserves critical for compromised-publisher-shaped evidence)', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@v7`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed');
  assert.equal(format.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('branch rejected: a branch reference is flagged (high severity)', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@main`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('latest rejected: `@latest` is flagged, exactly like any other mutable ref', async () => {
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

// Regression (HIGH-1, Reviewer, CONFIRMED): the original comment-capture
// regex required a single token after `#`, silently dropping any pin with
// a multi-word trailing comment from extraction entirely -- a mutable-ref
// pin with a realistic comment like "# v7.0.0 (pinned)" was never even
// considered, and the resulting empty pin list read as a clean pass.
test('a multi-word trailing comment does not cause the pin to vanish from extraction (HIGH-1)', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@main # temporary, revert before release`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'changed', 'the mutable "main" ref must still be detected despite the multi-word comment');
  assert.match(format.current, /1 total pins/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (HIGH-2, Reviewer, CONFIRMED): when extraction found zero
// pins despite non-empty, readable workflow files -- exactly the failure
// mode a parser bug like HIGH-1 produces -- the original code had no
// distinct guard and fell through to reporting "0 total pins" as `ok`.
// A parser failure must never look identical to a genuinely pin-free repo.
test('zero pins extracted from a non-empty workflow file is reported as blocked, never a silent ok pass (HIGH-2)', async () => {
  const repoRoot = makeFixtureRepo(`name: sample\non:\n  push: {}\njobs:\n  x:\n    runs-on: ubuntu-latest`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'blocked');
  assert.equal(format.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (MEDIUM-8, Reviewer, CONFIRMED): a legal YAML single-quoted
// `uses:` value (`uses: 'owner/repo@sha'`) previously had its quote
// characters swallowed into the captured ref/sha groups, so a genuinely
// full-SHA pin was misreported as not-a-full-SHA.
test('a YAML single-quoted uses: value is parsed correctly, not misreported as an invalid pin (MEDIUM-8)', async () => {
  const repoRoot = makeFixtureRepo(`- uses: 'actions/checkout@${FULL_SHA}' # v7.0.0`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const format = results.find((r) => r.id === 'actions-pins-format');
  assert.equal(format.status, 'ok', 'a quoted full-SHA pin must be recognized as a valid pin, not misparsed as containing quote characters');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (MEDIUM-1, Reviewer, CONFIRMED): deduplicating unique
// action/version pairs by owner/repo@comment alone (omitting the SHA)
// let two workflows pin the SAME action/version comment with DIFFERENT
// SHAs collapse into a single entry -- only the first-seen SHA was ever
// network-verified, silently hiding a genuinely wrong second pin.
test('two workflows pinning the same action/comment with DIFFERENT SHAs are both network-verified, never collapsed into one (MEDIUM-1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-actions-dedup-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'a.yml'), `- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const wrongSha = 'ffffffffffffffffffffffffffffffffffffffff';
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'b.yml'), `- uses: actions/checkout@${wrongSha} # v7.0.0`);
  const upstream = {
    async getGithubCommitForRef() {
      return { ok: true, json: { sha: FULL_SHA } }; // upstream truth: only FULL_SHA is correct for v7.0.0
    },
  };
  const results = await runActionsPinsChecks({ repoRoot: dir, offline: false, upstream });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'changed', 'the wrong SHA in b.yml must be caught, not hidden behind a.yml\'s correct one');
  assert.equal(drift.severity, 'high');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression (MEDIUM-2, Reviewer, CONFIRMED): every unresolved-lookup
// cause (rate-limited, not-found, timeout, server-error) previously
// collapsed into an undifferentiated warning/low with EMPTY evidence,
// contradicting this checker's own "a transport failure becomes
// unavailable, never a fabricated pass" design intent. If EVERY lookup
// failed for a transport reason (never a genuine not-found), the whole
// check must be unavailable, and the reason must be visible in evidence.
test('when every action lookup fails for a transport reason, the check reports unavailable with the reason visible, never a bare warning (MEDIUM-2)', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const upstream = {
    async getGithubCommitForRef() {
      return { ok: false, reason: 'rate-limited' };
    },
  };
  const results = await runActionsPinsChecks({ repoRoot, offline: false, upstream });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'unavailable');
  assert.match(drift.evidence.join(' '), /rate-limited/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('offline mode never claims the SHA-vs-tag resolution passed', async () => {
  const repoRoot = makeFixtureRepo(`- uses: actions/checkout@${FULL_SHA} # v7.0.0`);
  const results = await runActionsPinsChecks({ repoRoot, offline: true, upstream: {} });
  const drift = results.find((r) => r.id === 'actions-pins-resolve-to-stated-release');
  assert.equal(drift.status, 'unavailable');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
