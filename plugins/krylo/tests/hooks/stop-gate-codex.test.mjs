import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mkTempDataDir, createActiveRun, runCli, runHook, patchState, readState, cleanup,
  createActiveRunCodexOnly, runCliCodexOnly, runHookCodexOnly,
} from './helpers.mjs';

const GATE = 'orbit/stop-gate-codex.mjs';

function stopPayload(cwd, extra = {}) {
  return {
    hook_event_name: 'Stop',
    cwd,
    session_id: 'codex-hook-session',
    turn_id: 'turn-1',
    model: 'gpt-test',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: null,
    transcript_path: null,
    ...extra,
  };
}

test('stop-gate-codex: unmet criteria -> {decision:"block", reason} with Orbit delta; budget consumed; no unsupported fields', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'export endpoint returns CSV'], dataDir);

    const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json.decision, 'block');
    assert.match(res.json.reason, /AC-1/);
    assert.match(res.json.reason, /Remaining Orbit budget/);
    // continue:false would override decision:"block" on the real Codex
    // parser (confirmed directly against rust-v0.152.1) -- must never appear.
    assert.equal(res.json.continue, undefined);
    assert.equal(res.json.stopReason, undefined);

    const state = readState(statePath);
    assert.equal(state.orbit.stopBlocks, 1);
    assert.equal(state.orbit.cycle, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: stop_hook_active -> allow silently, state untouched (Codex\'s own recursion guard, same semantics as Claude)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    const before = readState(statePath);

    const res = runHookCodexOnly(GATE, stopPayload(dataDir, { stop_hook_active: true }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    const after = readState(statePath);
    assert.equal(after.orbit.stopBlocks, before.orbit.stopBlocks);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: no active run for this session -> allow silently', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: Stop for a DIFFERENT session_id than the active run is inert (session isolation)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    const before = readState(statePath);

    const res = runHookCodexOnly(GATE, stopPayload(dataDir, { session_id: 'a-completely-different-session' }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(readState(statePath).orbit.stopBlocks, before.orbit.stopBlocks, 'the real active run must be completely untouched');
  } finally {
    cleanup(dataDir);
  }
});

for (const terminalState of ['VERIFIED_COMPLETE', 'SAFE_BLOCKED', 'USER_DECISION_REQUIRED', 'RISK_APPROVAL_REQUIRED', 'ITERATION_LIMIT_REACHED', 'CANCELLED_BY_USER']) {
  test(`stop-gate-codex: ${terminalState} does not continue -- allow silently, state untouched`, () => {
    const dataDir = mkTempDataDir('krylo-codex-hook-');
    try {
      const { statePath } = createActiveRunCodexOnly(dataDir);
      patchState(statePath, (s) => {
        s.terminalState = terminalState;
        s.phase = terminalState === 'VERIFIED_COMPLETE' ? 'COMPLETING' : 'BLOCKED';
      });
      const before = readState(statePath);
      const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '', `${terminalState} must never be continued`);
      assert.deepEqual(readState(statePath), before, `${terminalState} state must be completely untouched`);
    } finally {
      cleanup(dataDir);
    }
  });
}

test('stop-gate-codex: budget exhaustion -> ITERATION_LIMIT_REACHED and pointer cleared', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    patchState(statePath, (s) => {
      s.orbit.cycle = s.orbit.budget;
    });

    const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');

    const state = readState(statePath);
    assert.equal(state.terminalState, 'ITERATION_LIMIT_REACHED');
    assert.equal(state.phase, 'ITERATION_LIMIT');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: stagnation -> SAFE_BLOCKED', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    patchState(statePath, (s) => {
      s.orbit.stagnation.cyclesWithoutProgress = 3;
    });

    const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(readState(statePath).terminalState, 'SAFE_BLOCKED');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: satisfied completion gate -> allow without setting a terminal state (model remains responsible for VERIFIED_COMPLETE)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'covered behavior'], dataDir);
    runCliCodexOnly('runtime/update-state.mjs', [
      '--add-evidence', JSON.stringify({ type: 'test', label: 'unit', sourceTool: 'node --test', result: 'pass', summary: '5 pass 0 fail' }),
    ], dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--set-criterion', 'AC-1=proven', '--evidence', 'EV-1'], dataDir);

    const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(readState(statePath).terminalState, null);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: repeated stops are strictly bounded by the Orbit budget and end in ITERATION_LIMIT_REACHED -- no unbounded loop', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir); // low risk -> budget 3
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);

    let blocks = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
      if (res.json?.decision === 'block') {
        blocks += 1;
      } else {
        break;
      }
    }
    const state = readState(statePath);
    assert.ok(blocks <= state.orbit.budget, `blocks (${blocks}) must not exceed budget (${state.orbit.budget})`);
    assert.equal(state.terminalState, 'ITERATION_LIMIT_REACHED');
    const after = runHookCodexOnly(GATE, stopPayload(dataDir), dataDir);
    assert.equal(after.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex: malformed/unreadable stdin fails safe -- allow silently, never blocks', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, null, dataDir, { rawInput: 'not json' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate-codex/stop-gate (Claude) parity: identical starting state and unmet criteria reach the identical orbit outcome -- no policy drift between adapters', () => {
  const claudeDir = mkTempDataDir();
  const codexDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const claudeRun = createActiveRun(claudeDir, { risk: 'medium' });
    const codexRun = createActiveRunCodexOnly(codexDir, { risk: 'medium' });
    runCli('runtime/update-state.mjs', ['--add-criterion', 'same criterion text'], claudeDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'same criterion text'], codexDir);

    // The Claude side uses its own minimal payload shape (no session_id --
    // runHook()'s CLAUDE_SESSION_ID env var, matching createActiveRun()'s
    // hardcoded 'hook-session', is what binds identity there), exactly the
    // convention tests/hooks/stop-gate.test.mjs's own stopPayload() uses.
    const claudeRes = runHook('orbit/stop-gate.mjs', { hook_event_name: 'Stop', cwd: claudeDir }, claudeDir);
    const codexRes = runHookCodexOnly(GATE, stopPayload(codexDir), codexDir);

    assert.equal(claudeRes.json.decision, 'block');
    assert.equal(codexRes.json.decision, 'block');
    const claudeState = readState(claudeRun.statePath);
    const codexState = readState(codexRun.statePath);
    assert.equal(claudeState.orbit.cycle, codexState.orbit.cycle);
    assert.equal(claudeState.orbit.stopBlocks, codexState.orbit.stopBlocks);
    assert.equal(claudeState.terminalState, codexState.terminalState);
  } finally {
    cleanup(claudeDir);
    cleanup(codexDir);
  }
});
