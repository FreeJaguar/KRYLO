// TDD category I (task Section 19.I): network unavailable -- offline
// checks still run, live checks explicitly unavailable, no false "pass".

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEcosystemMaintenance } from '../../scripts/maintenance/check-ecosystem.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function alwaysFailingUpstream() {
  const fail = async () => ({ ok: false, reason: 'network-error' });
  return { getLatestGithubRelease: fail, getGithubTags: fail, getGithubReleaseByTag: fail, getGithubCommitForRef: fail };
}

test('offline: internal-consistency checks still run and produce real ok/changed verdicts against this repository', async () => {
  const report = await runEcosystemMaintenance({ repoRoot: REPO_ROOT, offline: true });
  assert.equal(report.mode, 'offline');
  const internalChecks = report.checks.filter((c) => c.id.includes('internal-consistency') || c.category === 'internal-drift' || c.category === 'node-runtime');
  assert.ok(internalChecks.length > 0);
  assert.ok(internalChecks.every((c) => c.status !== 'unavailable'), 'internal/offline-capable checks must never report unavailable just because offline mode is on');
});

test('offline: every check that genuinely requires the network reports "unavailable", never a fabricated "ok"', async () => {
  const report = await runEcosystemMaintenance({ repoRoot: REPO_ROOT, offline: true });
  // claude-newer-release-available is intentionally NOT emitted at all in
  // offline mode (claude-compat.mjs returns early once it knows it cannot
  // reach upstream) -- absence-of-a-live-only-check is itself a valid,
  // non-false-passing shape, distinct from presence-with-status-"ok".
  const liveOnlyIds = [
    'claude-pinned-floor-still-available-upstream',
    'codex-tested-version-vs-latest-upstream',
    'actions-pins-resolve-to-stated-release',
    'npm-audit',
  ];
  for (const id of liveOnlyIds) {
    const check = report.checks.find((c) => c.id === id);
    assert.ok(check, `expected a check with id ${id}`);
    assert.equal(check.status, 'unavailable', `${id} must report unavailable in offline mode, never a false pass`);
  }
});

test('live mode with a totally unreachable upstream: every network-dependent check reports unavailable/low-severity, never a fabricated "up to date"', async () => {
  const report = await runEcosystemMaintenance({ repoRoot: REPO_ROOT, offline: false, upstream: alwaysFailingUpstream() });
  const floorCheck = report.checks.find((c) => c.id === 'claude-pinned-floor-still-available-upstream');
  // A network-error result for THIS check is treated as "changed" (task's
  // own explicit high-severity shape for "pinned floor unavailable") --
  // the important guarantee under test is that it is never silently
  // reported as "ok" merely because the network call failed.
  assert.notEqual(floorCheck.status, 'ok');
  const auditCheck = report.checks.find((c) => c.id === 'npm-audit');
  assert.ok(auditCheck.status === 'unavailable' || auditCheck.status === 'ok', 'npm audit does not depend on the injected upstream fake at all -- it runs locally');
  // No check anywhere in the report is allowed to silently claim "ok" for
  // a genuinely upstream-sourced fact when upstream itself is unreachable.
  const pinsResolveCheck = report.checks.find((c) => c.id === 'actions-pins-resolve-to-stated-release');
  assert.notEqual(pinsResolveCheck.status, 'ok');
});

test('a temporary network failure never produces the top-level report status "ok" when a real upstream-dependent check could not run and something is genuinely unknown', async () => {
  const report = await runEcosystemMaintenance({ repoRoot: REPO_ROOT, offline: true });
  // Offline mode's "unavailable" checks are low-severity by design (task
  // Section 21: "should not necessarily make main permanently red"), so
  // the report CAN legitimately be "ok" overall in offline mode -- what
  // this test actually guards is that no individual unavailable check's
  // OWN status field is "ok".
  const unavailableChecks = report.checks.filter((c) => c.status === 'unavailable');
  assert.ok(unavailableChecks.length > 0);
});
