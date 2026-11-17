// docs/adr/0046-unreadable-state-followups-and-lock-deadline.md, decision 1:
// when the question gate resolves its run but cannot read the run state
// under the lock (a failed reload, or saveState() refusing with
// 'state-unreadable'), it has not evaluated the question policy at all. It
// must take its fail-open path, as it already does for a lock failure, and
// never deny with the hint to grant a new, human-reviewed question token.
// Before ADR-0046 both cases fell through to that deny.
//
// The fault is injected with the test-only --import preload
// tests/fixtures/state-io/fail-state-rereads.mjs: the first N reads of
// state.json succeed (N = KRYLO_TEST_STATE_READS_BEFORE_FAULT) and every later
// one fails with EISDIR. Each test asserts that the fault actually fired.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkTempDataDir, createActiveRun, runCli, runHook, readState, cleanup } from './helpers.mjs';

const GATE = 'security/question-gate.mjs';
const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'state-io', 'fail-state-rereads.mjs');

function askPayload(cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which file name should I use?' }] },
    cwd,
  };
}

function faultEnv(dataDir, readsBeforeFault) {
  const log = path.join(dataDir, 'injected-faults.log');
  return {
    log,
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
      KRYLO_TEST_STATE_READS_BEFORE_FAULT: String(readsBeforeFault),
      KRYLO_TEST_FAIL_READ_LOG: log,
    },
  };
}

function questionGateEvents(dataDir, runId) {
  const file = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'question-gate');
}

function assertFailOpenOnUnreadableState(res, dataDir, runId) {
  assert.equal(res.status, 0);
  assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', `expected the fail-open allow, got: ${res.stdout}`);
  const reason = res.json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /could not read/i);
  assert.match(reason, /do not grant a new token/i);
  assert.doesNotMatch(reason, /--grant-question/, 'must not tell the model to spend a new human-reviewed grant');
  const events = questionGateEvents(dataDir, runId);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'allowed-state-unreadable');
}

test('question-gate: a failed reload under the lock fails open instead of denying with the grant hint', () => {
  const dataDir = mkTempDataDir('krylo-qgate-reload-');
  try {
    const { runId } = createActiveRun(dataDir);
    const { log, env } = faultEnv(dataDir, 1);
    const res = runHook(GATE, askPayload(dataDir), dataDir, { env });
    assert.ok(fs.existsSync(log), 'the injected reload fault must have fired');
    assertFailOpenOnUnreadableState(res, dataDir, runId);
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: a failed reload with a grant available fails open and leaves the grant unspent', () => {
  const dataDir = mkTempDataDir('krylo-qgate-reload-grant-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    assert.equal(runCli('runtime/update-state.mjs', ['--grant-question', 'missing-credential'], dataDir).status, 0);
    const { log, env } = faultEnv(dataDir, 1);
    const res = runHook(GATE, askPayload(dataDir), dataDir, { env });
    assert.ok(fs.existsSync(log), 'the injected reload fault must have fired');
    assertFailOpenOnUnreadableState(res, dataDir, runId);
    const grants = readState(statePath).questionGate.grants;
    assert.equal(grants.length, 1);
    assert.equal(grants[0].status, 'available', 'nothing was persisted, so the grant must still be available');
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: a saveState() refusal with state-unreadable fails open and leaves the grant unspent', () => {
  const dataDir = mkTempDataDir('krylo-qgate-save-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    assert.equal(runCli('runtime/update-state.mjs', ['--grant-question', 'missing-credential'], dataDir).status, 0);
    // Reads 1 (run resolution) and 2 (reload under the lock) succeed, so the
    // gate finds the grant and marks it consumed in memory; read 3,
    // saveState()'s pre-write read, fails, so the save is refused.
    const { log, env } = faultEnv(dataDir, 2);
    const res = runHook(GATE, askPayload(dataDir), dataDir, { env });
    assert.match(fs.readFileSync(log, 'utf8'), /EISDIR read 3/, 'the fault must have hit saveState()\'s pre-write read');
    assertFailOpenOnUnreadableState(res, dataDir, runId);
    const grants = readState(statePath).questionGate.grants;
    assert.equal(grants[0].status, 'available', 'the refused save must not have consumed the grant');
  } finally {
    cleanup(dataDir);
  }
});

test('control: with the preload loaded but no fault reached, the gate still consumes a grant and then denies', () => {
  const dataDir = mkTempDataDir('krylo-qgate-control-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    assert.equal(runCli('runtime/update-state.mjs', ['--grant-question', 'privacy'], dataDir).status, 0);
    const { log, env } = faultEnv(dataDir, 1000);
    const first = runHook(GATE, askPayload(dataDir), dataDir, { env });
    assert.equal(first.json.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /privacy/);
    assert.equal(readState(statePath).questionGate.grants[0].status, 'consumed');
    const second = runHook(GATE, askPayload(dataDir), dataDir, { env });
    assert.equal(second.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(second.json.hookSpecificOutput.permissionDecisionReason, /--grant-question/);
    assert.equal(fs.existsSync(log), false, 'no fault was injected');
    assert.deepEqual(questionGateEvents(dataDir, runId).map((e) => e.status), ['allowed', 'denied']);
  } finally {
    cleanup(dataDir);
  }
});
