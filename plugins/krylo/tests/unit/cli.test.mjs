import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeProjectRootHash } from '../../scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');

function runCli(scriptRelPath, args, dataDir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    // Tests that omit --project-dir rely on process.cwd() matching the
    // fixture's project dir (dataDir), exactly as init-run.mjs was invoked.
    cwd: dataDir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...extraEnv },
  });
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-cli-'));
}

test('init-run.mjs with a goal containing a fake secret never persists the secret', () => {
  const dataDir = mkTempDataDir();
  try {
    const secret = 'ghp_1234567890abcdefghijklmno';
    const res = runCli('runtime/init-run.mjs', [
      '--goal', `Fix leak of ${secret} in CI logs`,
      '--session', 'session-cli-1',
      '--project-dir', dataDir,
      '--lane', 'PATCH',
      '--risk', 'low',
    ], dataDir);

    assert.equal(res.status, 0);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.runId);
    assert.equal(res.json.budget, 3);

    const statePath = path.join(dataDir, 'runs', res.json.runId, 'state.json');
    assert.ok(fs.existsSync(statePath));
    const raw = fs.readFileSync(statePath, 'utf8');
    assert.ok(!raw.includes(secret));

    const state = JSON.parse(raw);
    assert.equal(state.schemaVersion, '1.1.0');
    assert.equal(state.phase, 'INITIALIZING');
    assert.equal(state.host.name, 'claude');
    assert.equal(state.host.sessionId, 'session-cli-1');
    assert.equal(state.delegation.externalWorker, false);
    assert.equal(state.delegation.depth, 0);
    assert.equal('sessionId' in state, false);

    // printed statePath must have the home dir masked, never a raw secret
    assert.ok(!res.json.statePath.includes(secret));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('read-state.mjs --field returns a single dotted field', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'read state field test',
      '--session', 'session-cli-2',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'medium',
    ], dataDir);
    assert.equal(init.json.ok, true);

    const res = runCli('runtime/read-state.mjs', ['--field', 'goal.lane'], dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.value, 'BUILD');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('read-state.mjs and update-state.mjs resolve the current run via --session after pointer migration', () => {
  const dataDir = mkTempDataDir();
  try {
    const initA = runCli('runtime/init-run.mjs', [
      '--goal', 'session A run',
      '--session', 'session-multi-a',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    assert.equal(initA.json.ok, true);

    const initB = runCli('runtime/init-run.mjs', [
      '--goal', 'session B run',
      '--session', 'session-multi-b',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    assert.equal(initB.json.ok, true);

    // Explicit --session must resolve to THAT session's own run, never
    // whichever pointer happens to be most recently updated.
    const readA = runCli('runtime/read-state.mjs', [
      '--session', 'session-multi-a', '--project-dir', dataDir, '--field', 'runId',
    ], dataDir);
    assert.equal(readA.json.ok, true);
    assert.equal(readA.json.value, initA.json.runId);

    const updateA = runCli('runtime/update-state.mjs', [
      '--session', 'session-multi-a', '--project-dir', dataDir, '--phase', 'EXECUTING',
    ], dataDir);
    assert.equal(updateA.json.ok, true);
    assert.equal(updateA.json.runId, initA.json.runId);

    const stateA = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', initA.json.runId, 'state.json'), 'utf8'));
    assert.equal(stateA.phase, 'EXECUTING');
    const stateB = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', initB.json.runId, 'state.json'), 'utf8'));
    assert.equal(stateB.phase, 'INITIALIZING');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('read-state.mjs fails cleanly when there is no current run', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runCli('runtime/read-state.mjs', [], dataDir);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('update-state.mjs full flow: criterion -> evidence -> proven -> VERIFIED_COMPLETE', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'ship the export feature',
      '--session', 'session-cli-3',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    assert.equal(init.json.ok, true);
    const runId = init.json.runId;

    const addCriterion = runCli('runtime/update-state.mjs', [
      '--run', runId,
      '--add-criterion', 'export button works',
    ], dataDir);
    assert.equal(addCriterion.status, 0);
    assert.equal(addCriterion.json.ok, true);

    const evidenceJson = JSON.stringify({
      type: 'test',
      label: 'export unit tests',
      sourceTool: 'node:test',
      result: 'pass',
      summary: '5 tests passed, 0 failed',
    });
    const addEvidence = runCli('runtime/update-state.mjs', [
      '--run', runId,
      '--add-evidence', evidenceJson,
    ], dataDir);
    assert.equal(addEvidence.status, 0);
    assert.equal(addEvidence.json.ok, true);

    const setCriterion = runCli('runtime/update-state.mjs', [
      '--run', runId,
      '--set-criterion', 'AC-1=proven',
      '--evidence', 'EV-1',
    ], dataDir);
    assert.equal(setCriterion.status, 0);
    assert.equal(setCriterion.json.ok, true);

    const terminal = runCli('runtime/update-state.mjs', [
      '--run', runId,
      '--terminal', 'VERIFIED_COMPLETE',
    ], dataDir);
    assert.equal(terminal.status, 0);
    assert.equal(terminal.json.ok, true);

    const stateRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runId, 'state.json'), 'utf8'));
    assert.equal(stateRaw.terminalState, 'VERIFIED_COMPLETE');
    assert.equal(stateRaw.phase, 'COMPLETING');

    // Terminal transition clears this run's active-run pointer.
    const projectRootHash = computeProjectRootHash(dataDir);
    const pointerPath = path.join(dataDir, 'active-runs', projectRootHash, 'session-cli-3.json');
    assert.equal(fs.existsSync(pointerPath), false);
    const legacyPointerPath = path.join(dataDir, 'current-run.json');
    assert.equal(fs.existsSync(legacyPointerPath), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('update-state.mjs: --terminal VERIFIED_COMPLETE fails (exit 1) when a criterion is still pending', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'second run pending criterion',
      '--session', 'session-cli-4',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    const runId = init.json.runId;

    runCli('runtime/update-state.mjs', ['--run', runId, '--add-criterion', 'still pending'], dataDir);

    const terminal = runCli('runtime/update-state.mjs', ['--run', runId, '--terminal', 'VERIFIED_COMPLETE'], dataDir);
    assert.equal(terminal.status, 1);
    assert.equal(terminal.json.ok, false);
    assert.equal(terminal.json.error, 'completion-gate-failed');
    assert.ok(Array.isArray(terminal.json.details));
    assert.ok(terminal.json.details.length > 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('update-state.mjs: question grant/consume and budget refusal', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'question gate test',
      '--session', 'session-cli-5',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    const runId = init.json.runId;

    const grant = runCli('runtime/update-state.mjs', [
      '--run', runId, '--grant-question', 'missing-credential',
    ], dataDir);
    assert.equal(grant.status, 0);
    assert.equal(grant.json.ok, true);

    // Default questionGate.budget is 1, so a second grant must be refused.
    const secondGrant = runCli('runtime/update-state.mjs', [
      '--run', runId, '--grant-question', 'privacy',
    ], dataDir);
    assert.equal(secondGrant.status, 1);
    assert.equal(secondGrant.json.ok, false);
    assert.equal(secondGrant.json.error, 'question-budget-exhausted');

    const consume = runCli('runtime/update-state.mjs', [
      '--run', runId, '--consume-question', 'qg-1',
    ], dataDir);
    assert.equal(consume.status, 0);
    assert.equal(consume.json.ok, true);

    const stateRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runId, 'state.json'), 'utf8'));
    assert.equal(stateRaw.questionGate.grants[0].status, 'consumed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('update-state.mjs: risk approval request and resolve', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'approval gate test',
      '--session', 'session-cli-6',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'high',
    ], dataDir);
    const runId = init.json.runId;
    assert.equal(init.json.budget, 7);

    const request = runCli('runtime/update-state.mjs', [
      '--run', runId, '--request-approval', 'git-push', '--summary', 'push feature branch',
    ], dataDir);
    assert.equal(request.status, 0);
    assert.equal(request.json.ok, true);

    const resolve = runCli('runtime/update-state.mjs', [
      '--run', runId, '--resolve-approval', 'ra-1=approved',
    ], dataDir);
    assert.equal(resolve.status, 0);
    assert.equal(resolve.json.ok, true);

    const stateRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runId, 'state.json'), 'utf8'));
    assert.equal(stateRaw.riskApprovals[0].status, 'approved');
    assert.equal(stateRaw.riskApprovals[0].actionClass, 'git-push');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('init-run.mjs: max_orbit_cycles is a cap that can only lower the risk-based budget, never raise it', () => {
  const dataDir = mkTempDataDir();
  try {
    // A low-risk run's budget (3) must not be raised by a generous cap.
    const lowUncapped = runCli('runtime/init-run.mjs', [
      '--goal', 'orbit cap low, generous cap',
      '--session', 'session-cli-cap-1',
      '--project-dir', dataDir,
      '--lane', 'PATCH',
      '--risk', 'low',
    ], dataDir, { CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: '10' });
    assert.equal(lowUncapped.json.budget, 3);

    // A high-risk run's budget (7) must be lowered by a stricter cap.
    const highCapped = runCli('runtime/init-run.mjs', [
      '--goal', 'orbit cap high, strict cap',
      '--session', 'session-cli-cap-2',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'high',
    ], dataDir, { CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: '2' });
    assert.equal(highCapped.json.budget, 2);

    // An out-of-range cap value is ignored; the risk-based default applies.
    const outOfRange = runCli('runtime/init-run.mjs', [
      '--goal', 'orbit cap out of range is ignored',
      '--session', 'session-cli-cap-3',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'medium',
    ], dataDir, { CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: '999' });
    assert.equal(outOfRange.json.budget, 5);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('update-state.mjs: unknown operation is refused', () => {
  const dataDir = mkTempDataDir();
  try {
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'unknown op test',
      '--session', 'session-cli-7',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'low',
    ], dataDir);
    const runId = init.json.runId;

    const res = runCli('runtime/update-state.mjs', ['--run', runId, '--not-a-real-flag', 'value'], dataDir);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
