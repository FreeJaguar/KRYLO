// Multi-host foundation regression requirement (docs/process/
// MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md, Task 8, Step 1): for every
// direct Claude-facing path, execute it with ONLY a temporary
// CLAUDE_PLUGIN_DATA set (KRYLO_DATA_ROOT explicitly absent, never inherited)
// and assert every KRYLO-owned write/read stays under that Claude data root
// after Claude adapter bootstrap -- it must never fall back to a real,
// non-isolated default (~/.krylo, ~/.claude/plugins/data/krylo, ...).
//
// Covers: posttool telemetry, failure fingerprint, question token
// consumption, stop-gate state mutation, agent event state mutation, and
// cleanup. (Status rendering and the Doctor storage probe are already
// covered the same way by tests/status/statusline.test.mjs,
// tests/status/wrapper.test.mjs, and tests/setup/doctor.test.mjs, which set
// only CLAUDE_PLUGIN_DATA.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mkTempDataDir,
  createActiveRunClaudeOnly,
  runCliClaudeOnly,
  runHookClaudeOnly,
  readState,
  cleanup,
} from './helpers.mjs';

/** Every path KRYLO wrote to must resolve inside dataDir. */
function assertAllPathsUnder(dataDir, paths) {
  const root = path.resolve(dataDir) + path.sep;
  for (const p of paths) {
    const resolved = path.resolve(p);
    assert.ok(resolved === path.resolve(dataDir) || resolved.startsWith(root), `expected ${resolved} to stay under ${dataDir}`);
  }
}

test('claude-only env: posttool telemetry stays under CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-posttool-');
  try {
    const { runId, statePath } = createActiveRunClaudeOnly(dataDir);
    const res = runHookClaudeOnly('runtime/posttool-telemetry.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      duration_ms: 5,
      cwd: dataDir,
    }, dataDir);
    assert.equal(res.status, 0);

    const state = readState(statePath);
    assert.equal(state.toolCounters.Grep, 1);
    assertAllPathsUnder(dataDir, [statePath]);
    assert.ok(fs.existsSync(path.join(dataDir, 'telemetry', `${runId}.jsonl`)), 'telemetry file must live under CLAUDE_PLUGIN_DATA');
  } finally {
    cleanup(dataDir);
  }
});

test('claude-only env: failure fingerprint stays under CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-fingerprint-');
  try {
    const { statePath } = createActiveRunClaudeOnly(dataDir);
    const res = runHookClaudeOnly('orbit/fingerprint.mjs', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: 'test failed: expected 1 to equal 2',
      cwd: dataDir,
    }, dataDir);
    assert.equal(res.status, 0);

    const state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 1);
    assertAllPathsUnder(dataDir, [statePath]);
  } finally {
    cleanup(dataDir);
  }
});

test('claude-only env: question token consumption stays under CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-question-');
  try {
    const { statePath } = createActiveRunClaudeOnly(dataDir);
    const grant = runCliClaudeOnly('runtime/update-state.mjs', ['--grant-question', 'privacy'], dataDir);
    assert.equal(grant.status, 0);

    const res = runHookClaudeOnly('security/question-gate.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'ok?' }] },
      cwd: dataDir,
    }, dataDir);
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'allow');

    const state = readState(statePath);
    assert.equal(state.questionGate.used, 1);
    assert.equal(state.questionGate.grants[0].status, 'consumed');
    assertAllPathsUnder(dataDir, [statePath]);
  } finally {
    cleanup(dataDir);
  }
});

test('claude-only env: stop-gate state mutation stays under CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-stopgate-');
  try {
    const { statePath } = createActiveRunClaudeOnly(dataDir);
    runCliClaudeOnly('runtime/update-state.mjs', ['--add-criterion', 'unmet'], dataDir);

    const res = runHookClaudeOnly('orbit/stop-gate.mjs', { hook_event_name: 'Stop', cwd: dataDir }, dataDir);
    assert.equal(res.json.decision, 'block');

    const state = readState(statePath);
    assert.equal(state.orbit.stopBlocks, 1);
    assertAllPathsUnder(dataDir, [statePath]);
  } finally {
    cleanup(dataDir);
  }
});

test('claude-only env: agent event state mutation stays under CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-agentevents-');
  try {
    const { statePath } = createActiveRunClaudeOnly(dataDir);
    const res = runHookClaudeOnly('status/agent-events.mjs', {
      hook_event_name: 'SubagentStart',
      agent_type: 'krylo:builder',
      model: 'sonnet',
      cwd: dataDir,
    }, dataDir);
    assert.equal(res.status, 0);

    const state = readState(statePath);
    assert.equal(state.agents.length, 1);
    assertAllPathsUnder(dataDir, [statePath]);
  } finally {
    cleanup(dataDir);
  }
});

test('claude-only env: cleanup only ever touches CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkTempDataDir('krylo-isolate-cleanup-');
  try {
    const { runId } = createActiveRunClaudeOnly(dataDir);
    const runDir = path.join(dataDir, 'runs', runId);
    assert.ok(fs.existsSync(runDir), 'fixture run must exist before cleanup');

    // --all forces removal regardless of age, without needing to backdate
    // timestamps; the run is still active (no terminalState), but --all does
    // not check that either, so this is a safe, deterministic assertion that
    // cleanup acted on the CLAUDE_PLUGIN_DATA-rooted run dir at all.
    const res = runCliClaudeOnly('runtime/cleanup.mjs', ['--all'], dataDir);
    assert.equal(res.status, 0);
    assert.ok(res.json.ok);
    assert.ok(res.json.removed.runs.includes(runId));
    assert.equal(fs.existsSync(runDir), false);
  } finally {
    cleanup(dataDir);
  }
});
