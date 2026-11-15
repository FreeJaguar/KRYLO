// TDD category D (task Section 19.D): Codex compatibility checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCodexCompatChecks } from '../../scripts/maintenance/checks/codex-compat.mjs';

const EVENTS_0120 = ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'];
const DEFAULT_CONTRACT = { supported: [{ version: '0.120.0', confirmedHookEvents: EVENTS_0120 }] };

function makeFixtureRepo({
  testedVersion = '0.120.0',
  mentionInAdr = true,
  hookEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
  contract = DEFAULT_CONTRACT,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-codex-'));
  fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', 'policies'), { recursive: true });

  // The reviewed runtime contract is the source of truth for which hook
  // events each supported Codex build is confirmed to accept. `contract: null`
  // omits the file; a string is written verbatim (for unparseable input).
  if (contract !== null) {
    fs.writeFileSync(
      path.join(dir, 'plugins', 'krylo', 'policies', 'codex-runtime-compatibility.json'),
      typeof contract === 'string' ? contract : JSON.stringify({ contractSchemaVersion: 1, blocked: [], ...contract }),
    );
  }

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
  assert.equal(hookCheck.severity, 'medium');
  assert.equal(hookCheck.requiresHumanReview, true);
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

// The checks below read the reviewed runtime contract
// (plugins/krylo/policies/codex-runtime-compatibility.json) instead of an
// expectation snapshot hard-coded from the 0.120.0 binary. That snapshot never
// learned about 0.154.0, so it kept naming SessionEnd as unknown in general
// when the real, narrower fact is "unconfirmed on 0.120.0 only".

test('hook events: an event confirmed by one supported version but not another is reported against that exact version', async () => {
  const repoRoot = makeFixtureRepo({
    hookEvents: ['PreToolUse', 'SessionEnd'],
    contract: {
      supported: [
        { version: '0.120.0', confirmedHookEvents: EVENTS_0120 },
        { version: '0.154.0', confirmedHookEvents: [...EVENTS_0120, 'SessionEnd'] },
      ],
    },
  });
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'changed');
  assert.equal(hookCheck.requiresHumanReview, true);
  assert.match(hookCheck.recommendedAction, /SessionEnd/);
  assert.match(hookCheck.recommendedAction, /0\.120\.0/);
  assert.doesNotMatch(hookCheck.recommendedAction, /0\.154\.0/);
  assert.ok(hookCheck.evidence.includes('plugins/krylo/policies/codex-runtime-compatibility.json'));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('hook events: every supported version confirms every declared event -> ok, even for events outside the 0.120.0 set', async () => {
  const repoRoot = makeFixtureRepo({
    hookEvents: ['PreToolUse', 'SessionEnd'],
    contract: { supported: [{ version: '0.154.0', confirmedHookEvents: [...EVENTS_0120, 'SessionEnd'] }] },
  });
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
  assert.equal(hookCheck.status, 'ok');
  assert.equal(hookCheck.requiresHumanReview, false);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

for (const [label, contract] of [
  ['missing', null],
  ['unparseable', '{ not json'],
  ['no supported versions', { supported: [] }],
  ['a supported version without confirmedHookEvents', { supported: [{ version: '0.154.0' }] }],
]) {
  test(`hook events: contract ${label} -> blocked, never a fallback to a hard-coded event list`, async () => {
    const repoRoot = makeFixtureRepo({ hookEvents: ['PreToolUse'], contract });
    const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
    const hookCheck = results.find((r) => r.id === 'codex-hook-event-names-recognized');
    assert.equal(hookCheck.status, 'blocked');
    assert.equal(hookCheck.requiresHumanReview, true);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

test('upstream drift: compares the NEWEST supported contract version, not the capability matrix\'s historical anchor', async () => {
  const repoRoot = makeFixtureRepo({
    testedVersion: '0.120.0',
    contract: {
      supported: [
        { version: '0.154.0', confirmedHookEvents: EVENTS_0120 },
        { version: '0.120.0', confirmedHookEvents: EVENTS_0120 },
      ],
    },
  });
  const results = await runCodexCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ latestTag: 'rust-v0.154.0' }) });
  const drift = results.find((r) => r.id === 'codex-tested-version-vs-latest-upstream');
  assert.equal(drift.status, 'ok');
  assert.equal(drift.current, 'codex-cli 0.154.0');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('upstream drift: newest supported contract version behind upstream -> changed, naming that version', async () => {
  const repoRoot = makeFixtureRepo({
    contract: { supported: [{ version: '0.154.0', confirmedHookEvents: EVENTS_0120 }] },
  });
  const results = await runCodexCompatChecks({ repoRoot, offline: false, upstream: fakeUpstream({ latestTag: 'rust-v0.167.2' }) });
  const drift = results.find((r) => r.id === 'codex-tested-version-vs-latest-upstream');
  assert.equal(drift.status, 'changed');
  assert.equal(drift.current, 'codex-cli 0.154.0');
  assert.equal(drift.observed, 'rust-v0.167.2');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('upstream drift: offline reports the newest supported contract version as current', async () => {
  const repoRoot = makeFixtureRepo({
    contract: { supported: [{ version: '0.154.0', confirmedHookEvents: EVENTS_0120 }] },
  });
  const results = await runCodexCompatChecks({ repoRoot, offline: true, upstream: fakeUpstream() });
  const drift = results.find((r) => r.id === 'codex-tested-version-vs-latest-upstream');
  assert.equal(drift.status, 'unavailable');
  assert.equal(drift.current, '0.154.0');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
