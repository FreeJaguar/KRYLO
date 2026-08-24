// Regression coverage for a gap found while investigating SECURITY BLOCKER 2
// (security-hardening checkpoint): loadState() no longer persists a
// migration unlocked, but several PostToolUse/PostToolUseFailure/
// SubagentStart/SubagentStop/Stop hook entrypoints (posttool-telemetry.mjs,
// question-gate.mjs, status/agent-events.mjs, orbit/fingerprint.mjs,
// orbit/stop-gate.mjs) still called saveState() with NO lock of their own --
// only update-state.mjs, risk-policy.mjs's consumeMatchingApproval, and the
// new human-approval-gate.mjs wrapped their load-mutate-save sequence in the
// run's exclusive lock. Two of these unlocked hooks (or one of them racing a
// locked mutator) firing concurrently against the same run could still lose
// an update: classic read-mutate-write race, independent of the migration
// question this task originally asked about.
//
// Fixed: all five now reload state fresh under withFileLock(runLockPath(...))
// before mutating and saving, exactly like the already-locked mutators.
//
// This uses real separate `node` child processes (spawn, not spawnSync),
// never a real/live KRYLO data directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mkTempDataDir, createActiveRun, readState, cleanup, SCRIPTS_ROOT } from './helpers.mjs';

const POSTTOOL_TELEMETRY = path.join(SCRIPTS_ROOT, 'runtime', 'posttool-telemetry.mjs');
const AGENT_EVENTS = path.join(SCRIPTS_ROOT, 'status', 'agent-events.mjs');

function spawnAsync(scriptPath, { input, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ status: code, stdout }));
    child.stdin.end(input);
  });
}

test('real concurrency: many concurrent posttool-telemetry hook invocations never lose a tool-counter increment', async () => {
  const dataDir = mkTempDataDir('krylo-concurrent-mut-');
  try {
    const { statePath } = createActiveRun(dataDir);
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, CLAUDE_SESSION_ID: 'hook-session' };

    const N = 15;
    const calls = Array.from({ length: N }, () => spawnAsync(POSTTOOL_TELEMETRY, {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Grep', duration_ms: 1, cwd: dataDir }),
      env,
    }));

    const results = await Promise.all(calls);
    for (const r of results) assert.equal(r.status, 0);

    const state = readState(statePath);
    assert.equal(
      state.toolCounters.Grep,
      N,
      `expected exactly ${N} increments with no lost updates under real concurrency, got ${state.toolCounters.Grep}`,
    );
  } finally {
    cleanup(dataDir);
  }
});

test('real concurrency: many concurrent SubagentStart events each get a distinct agent id (no collision, none lost)', async () => {
  const dataDir = mkTempDataDir('krylo-concurrent-mut-');
  try {
    const { statePath } = createActiveRun(dataDir);
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, CLAUDE_SESSION_ID: 'hook-session' };

    const N = 15;
    const calls = Array.from({ length: N }, () => spawnAsync(AGENT_EVENTS, {
      input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'krylo:builder', model: 'sonnet', cwd: dataDir }),
      env,
    }));

    const results = await Promise.all(calls);
    for (const r of results) assert.equal(r.status, 0);

    const state = readState(statePath);
    assert.equal(state.agents.length, N, `expected exactly ${N} recorded agents with none lost, got ${state.agents.length}`);
    const ids = state.agents.map((a) => a.id);
    assert.equal(new Set(ids).size, N, 'every concurrently-created agent must get its own distinct id, with no collisions');
  } finally {
    cleanup(dataDir);
  }
});
