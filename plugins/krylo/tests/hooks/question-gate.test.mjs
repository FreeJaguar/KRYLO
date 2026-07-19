import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runCli, runHook, readState, cleanup } from './helpers.mjs';

const GATE = 'security/question-gate.mjs';

function askPayload(cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which file name should I use?' }] },
    cwd,
  };
}

test('question-gate: no active run -> exit 0, no output', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runHook(GATE, askPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: active run without grant -> deny with policy guidance', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const res = runHook(GATE, askPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /question policy/i);
    assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /--grant-question/);
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: available grant -> allow once, then deny', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    const grant = runCli('runtime/update-state.mjs', ['--grant-question', 'missing-credential'], dataDir);
    assert.equal(grant.status, 0);

    const first = runHook(GATE, askPayload(dataDir), dataDir);
    assert.equal(first.json.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /missing-credential/);

    const state = readState(statePath);
    assert.equal(state.questionGate.used, 1);
    assert.equal(state.questionGate.grants[0].status, 'consumed');
    assert.ok(state.questionGate.grants[0].consumedAt);

    const second = runHook(GATE, askPayload(dataDir), dataDir);
    assert.equal(second.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: grant budget refusal is enforced by update-state', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const first = runCli('runtime/update-state.mjs', ['--grant-question', 'privacy'], dataDir);
    assert.equal(first.status, 0);
    // budget is 1: a second grant while one is already available/used must fail
    const second = runCli('runtime/update-state.mjs', ['--grant-question', 'privacy'], dataDir);
    assert.equal(second.status, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('question-gate: malformed stdin with active run -> fail open (allow)', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const res = runHook(GATE, null, dataDir, { rawInput: '{not json' });
    assert.equal(res.status, 0);
    // fail-open path: either silent allow or explicit allow, never deny
    if (res.json) {
      assert.notEqual(res.json.hookSpecificOutput?.permissionDecision, 'deny');
    }
  } finally {
    cleanup(dataDir);
  }
});
