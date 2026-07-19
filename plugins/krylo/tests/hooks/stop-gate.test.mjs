import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { mkTempDataDir, createActiveRun, runCli, runHook, patchState, readState, cleanup } from './helpers.mjs';

const GATE = 'orbit/stop-gate.mjs';

function stopPayload(cwd, extra = {}) {
  return { hook_event_name: 'Stop', cwd, ...extra };
}

test('stop-gate: unmet criteria -> block with Orbit delta; budget consumed', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'export endpoint returns CSV'], dataDir);

    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json.decision, 'block');
    assert.match(res.json.reason, /AC-1/);
    assert.match(res.json.reason, /Remaining Orbit budget/);

    const state = readState(statePath);
    assert.equal(state.orbit.stopBlocks, 1);
    assert.equal(state.orbit.cycle, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: stop_hook_active -> allow silently, state untouched', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    const before = readState(statePath);

    const res = runHook(GATE, stopPayload(dataDir, { stop_hook_active: true }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    const after = readState(statePath);
    assert.equal(after.orbit.stopBlocks, before.orbit.stopBlocks);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: terminal state set -> allow silently', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (s) => {
      s.terminalState = 'SAFE_BLOCKED';
      s.phase = 'BLOCKED';
    });
    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: budget exhaustion -> ITERATION_LIMIT_REACHED and pointer cleared', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    patchState(statePath, (s) => {
      s.orbit.cycle = s.orbit.budget;
    });

    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');

    const state = readState(statePath);
    assert.equal(state.terminalState, 'ITERATION_LIMIT_REACHED');
    assert.equal(state.phase, 'ITERATION_LIMIT');
    assert.ok(!fs.existsSync(path.join(dataDir, 'current-run.json')));
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: stagnation -> SAFE_BLOCKED', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    patchState(statePath, (s) => {
      s.orbit.stagnation.cyclesWithoutProgress = 3;
    });

    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(readState(statePath).terminalState, 'SAFE_BLOCKED');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: satisfied completion gate -> allow without setting a terminal state', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'covered behavior'], dataDir);
    runCli('runtime/update-state.mjs', [
      '--add-evidence', JSON.stringify({ type: 'test', label: 'unit', sourceTool: 'node --test', result: 'pass', summary: '5 pass 0 fail' }),
    ], dataDir);
    runCli('runtime/update-state.mjs', ['--set-criterion', 'AC-1=proven', '--evidence', 'EV-1'], dataDir);

    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(readState(statePath).terminalState, null);
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: repeated stops are strictly bounded and end in ITERATION_LIMIT_REACHED', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir); // low risk -> budget 3
    runCli('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);

    let blocks = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = runHook(GATE, stopPayload(dataDir), dataDir);
      if (res.json?.decision === 'block') {
        blocks += 1;
      } else {
        break;
      }
    }
    const state = readState(statePath);
    assert.ok(blocks <= state.orbit.budget, `blocks (${blocks}) must not exceed budget (${state.orbit.budget})`);
    assert.equal(state.terminalState, 'ITERATION_LIMIT_REACHED');
    // After the terminal state, further stops pass through silently.
    const after = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(after.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('stop-gate: block reason includes strategy-change instruction on repeated fingerprints', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'never proven'], dataDir);
    patchState(statePath, (s) => {
      s.orbit.fingerprints.push({ hash: 'abcdef0123456789', category: 'test', count: 2, firstSeenCycle: 0, lastSeenCycle: 1 });
      // repeated fingerprint sets change-strategy, but stagnation must stay below 3
    });
    const res = runHook(GATE, stopPayload(dataDir), dataDir);
    assert.equal(res.json.decision, 'block');
    assert.match(res.json.reason, /Change strategy/i);
    assert.match(res.json.reason, /abcdef0123456789/);
  } finally {
    cleanup(dataDir);
  }
});
