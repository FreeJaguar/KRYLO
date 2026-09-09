// TDD category C (task Section 19.C): Claude compatibility checks.
// Deterministic fixtures only -- an injected `upstream` fake, never a real
// network call.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runClaudeCompatChecks } from '../../scripts/maintenance/checks/claude-compat.mjs';

function makeFixtureRepo({ floorValidate = '2.1.223', floorRelease = '2.1.223', mentionInAdr = true, mentionInReadiness = true, hookEvents = ['PreToolUse', 'PostToolUse', 'Stop'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-claude-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', 'skills', 'run'), { recursive: true });

  const releaseUrl = (v) => `curl -fsSL -o claude.tar.gz "https://github.com/anthropics/claude-code/releases/download/v${v}/claude-linux-x64.tar.gz"`;
  if (floorValidate) fs.writeFileSync(path.join(dir, '.github', 'workflows', 'validate-plugin.yml'), releaseUrl(floorValidate));
  if (floorRelease) fs.writeFileSync(path.join(dir, '.github', 'workflows', 'release.yml'), releaseUrl(floorRelease));

  fs.writeFileSync(
    path.join(dir, 'docs', 'adr', '0022-claude-code-compatibility-policy.md'),
    mentionInAdr ? `The floor is ${floorValidate}.` : 'No version mentioned.',
  );
  fs.writeFileSync(
    path.join(dir, 'RELEASE_READINESS.md'),
    mentionInReadiness ? `pinned floor is ${floorValidate}` : 'no version stated',
  );

  const hooksYaml = hookEvents.map((e) => `  ${e}:\n    - hooks:\n        - type: command\n          command: "x"`).join('\n');
  fs.writeFileSync(
    path.join(dir, 'plugins', 'krylo', 'skills', 'run', 'SKILL.md'),
    `---\nname: run\nhooks:\n${hooksYaml}\n---\nbody`,
  );

  return dir;
}

function fakeUpstream({ floorAvailable = true, latestTag = 'v2.1.223' } = {}) {
  return {
    async getGithubReleaseByTag(owner, repo, tag) {
      return floorAvailable ? { ok: true, json: { tag_name: tag } } : { ok: false, reason: 'not-found' };
    },
    async getLatestGithubRelease() {
      return { ok: true, json: { tag_name: latestTag } };
    },
  };
}

test('current minimum consistent: validate-plugin.yml and release.yml agree, docs mention it', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runClaudeCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const consistency = results.find((r) => r.id === 'claude-pinned-floor-internal-consistency');
  assert.equal(consistency.status, 'ok');
  const docs = results.find((r) => r.id === 'claude-pinned-floor-documented-consistently');
  assert.equal(docs.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('pin mismatch: validate-plugin.yml and release.yml disagree -> changed/high, human review required', async () => {
  const repoRoot = makeFixtureRepo({ floorValidate: '2.1.223', floorRelease: '2.1.200' });
  const results = await runClaudeCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const consistency = results.find((r) => r.id === 'claude-pinned-floor-internal-consistency');
  assert.equal(consistency.status, 'changed');
  assert.equal(consistency.severity, 'high');
  assert.equal(consistency.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('required contract present: all six known KRYLO hook events are recognized', async () => {
  const repoRoot = makeFixtureRepo({ hookEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop'] });
  const results = await runClaudeCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'claude-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('required contract missing/unrecognized: an event not in KRYLO\'s own known-accepted set is flagged for review', async () => {
  const repoRoot = makeFixtureRepo({ hookEvents: ['PreToolUse', 'SomeFutureEventKryloDoesNotKnowAbout'] });
  const results = await runClaudeCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'claude-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'changed');
  assert.equal(hookCheck.requiresHumanReview, true);
  assert.match(hookCheck.recommendedAction, /SomeFutureEventKryloDoesNotKnowAbout/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('newer release only: the pinned floor is still available, but a newer release exists -> informational, never blocking', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runClaudeCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ latestTag: 'v2.1.246' }) });
  const newer = results.find((r) => r.id === 'claude-newer-release-available');
  assert.equal(newer.status, 'changed');
  assert.equal(newer.severity, 'info');
  assert.equal(newer.requiresHumanReview, false);
  const floorCheck = results.find((r) => r.id === 'claude-pinned-floor-still-available-upstream');
  assert.equal(floorCheck.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('unavailable upstream: the pinned floor no longer resolves -> changed/high, human review required', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runClaudeCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ floorAvailable: false }) });
  const floorCheck = results.find((r) => r.id === 'claude-pinned-floor-still-available-upstream');
  assert.equal(floorCheck.status, 'changed');
  assert.equal(floorCheck.severity, 'high');
  assert.equal(floorCheck.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (Verifier, CONFIRMED via a real live GitHub API rate-limit
// hit mid-review): a transient upstream failure (rate-limited, timeout,
// network-error, server-error) previously collapsed into the SAME
// 'changed'/'high'/requiresHumanReview:true result as a genuine 404 --
// meaning ordinary GitHub API rate limiting on a shared CI runner would
// produce a false high-severity "pinned floor unavailable" alert on
// every affected monthly run. Only a genuine not-found means the release
// itself is actually gone.
test('a transient upstream failure (rate-limited) is reported as unavailable, never as a false "floor unavailable" alert', async () => {
  const repoRoot = makeFixtureRepo();
  const upstream = {
    async getGithubReleaseByTag() {
      return { ok: false, reason: 'rate-limited' };
    },
    async getLatestGithubRelease() {
      return { ok: false, reason: 'rate-limited' };
    },
  };
  const results = await runClaudeCompatChecks({ repoRoot, offline: false, upstream });
  const floorCheck = results.find((r) => r.id === 'claude-pinned-floor-still-available-upstream');
  assert.equal(floorCheck.status, 'unavailable');
  assert.equal(floorCheck.severity, 'info');
  assert.equal(floorCheck.requiresHumanReview, false);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('offline mode: live-only checks report "unavailable", never a false "ok"', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runClaudeCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const floorCheck = results.find((r) => r.id === 'claude-pinned-floor-still-available-upstream');
  assert.equal(floorCheck.status, 'unavailable');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
