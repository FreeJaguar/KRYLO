// TDD category D (task Section 19.D): Codex compatibility checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCodexCompatChecks } from '../../scripts/maintenance/checks/codex-compat.mjs';

function makeFixtureRepo({ testedVersion = '0.120.0', mentionInAdr = true, hookEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-codex-'));
  fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', 'hooks'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'docs', 'codex-capability-matrix.md'), `Installed Codex CLI verified against: \`codex-cli ${testedVersion}\``);
  fs.writeFileSync(
    path.join(dir, 'docs', 'adr', '0029-codex-host-packaging-and-approval-boundary.md'),
    mentionInAdr ? `verified against codex-cli ${testedVersion}` : 'no version stated',
  );

  // Events nest under `hooks` -- the shape real Codex builds accept, and the
  // one the checker must read (docs/adr/0035-codex-live-hook-verification.md).
  // This fixture previously wrote the flat shape, which is why the suite did
  // not catch the checker still reading the top level after the shape change.
  const eventMap = {};
  for (const e of hookEvents) eventMap[e] = [{ hooks: [{ type: 'command', command: 'x' }] }];
  fs.writeFileSync(
    path.join(dir, 'plugins', 'krylo', 'hooks', 'codex-hooks.json'),
    JSON.stringify({ description: 'fixture', hooks: eventMap }),
  );

  return dir;
}

function fakeUpstream({ latestTag = 'rust-v0.120.0' } = {}) {
  return {
    async getLatestGithubRelease() {
      return { ok: true, json: { tag_name: latestTag } };
    },
  };
}

test('tested version consistent: capability matrix and ADR-0029 agree', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const consistency = results.find((r) => r.id === 'codex-tested-version-consistent-with-adr');
  assert.equal(consistency.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('required session_id field present: UserPromptSubmit is declared (the event that binds real session identity, ADR-0029)', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'ok');
  assert.match(hookCheck.observed, /UserPromptSubmit/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('required event missing: codex-hooks.json has zero declared events -> blocked, medium', async () => {
  const repoRoot = makeFixtureRepo({ hookEvents: [] });
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'blocked');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('hook contract drift: an event outside ADR-0029\'s confirmed enum (e.g. PermissionRequest, confirmed ABSENT from the real binary) is flagged high', async () => {
  const repoRoot = makeFixtureRepo({ hookEvents: ['PreToolUse', 'PermissionRequest'] });
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'changed');
  assert.equal(hookCheck.severity, 'high');
  assert.match(hookCheck.observed, /PermissionRequest/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('newer release only: Codex tested version is behind upstream -> changed/medium, human review, never blocking', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runCodexCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ latestTag: 'rust-v0.149.1' }) });
  const drift = results.find((r) => r.id === 'codex-tested-version-vs-latest-upstream');
  assert.equal(drift.status, 'changed');
  assert.equal(drift.severity, 'medium');
  assert.equal(drift.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('never silently treats latest as automatically compatible: same tested and latest version -> ok, not "changed"', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runCodexCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ latestTag: 'rust-v0.120.0' }) });
  const drift = results.find((r) => r.id === 'codex-tested-version-vs-latest-upstream');
  assert.equal(drift.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
