import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');

function runCli(scriptRelPath, args, dataDir) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
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
    assert.equal(state.schemaVersion, '1.0.0');
    assert.equal(state.phase, 'INITIALIZING');

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

    // Terminal transition clears the current-run pointer for this run.
    const pointerPath = path.join(dataDir, 'current-run.json');
    assert.equal(fs.existsSync(pointerPath), false);
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
