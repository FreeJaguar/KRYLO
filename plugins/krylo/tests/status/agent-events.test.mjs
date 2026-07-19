import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, readState, persistedBytes, cleanup } from '../hooks/helpers.mjs';

const HOOK = 'status/agent-events.mjs';
const CANARY = 'AgentEventCanary_5150';

test('agent-events: start registers, stop completes; resolved model never inferred', () => {
  const dataDir = mkTempDataDir('krylo-agents-');
  try {
    const { statePath } = createActiveRun(dataDir);

    runHook(HOOK, {
      hook_event_name: 'SubagentStart',
      agent_type: 'krylo:builder',
      model: 'sonnet',
      description: 'implement export flow',
      secret_payload: CANARY,
      cwd: dataDir,
    }, dataDir);

    let state = readState(statePath);
    assert.equal(state.agents.length, 1);
    assert.equal(state.agents[0].type, 'krylo:builder');
    assert.equal(state.agents[0].configuredModel, 'sonnet');
    assert.equal(state.agents[0].resolvedModel, null, 'resolved model must not be inferred');
    assert.equal(state.agents[0].status, 'running');

    runHook(HOOK, {
      hook_event_name: 'SubagentStop',
      agent_type: 'krylo:builder',
      status: 'completed',
      cwd: dataDir,
    }, dataDir);

    state = readState(statePath);
    assert.equal(state.agents[0].status, 'completed');
    assert.ok(state.agents[0].endedAt);

    assert.ok(!persistedBytes(dataDir).includes(CANARY), 'unexpected payload fields must not persist');
  } finally {
    cleanup(dataDir);
  }
});

test('agent-events: explicit resolved model is recorded', () => {
  const dataDir = mkTempDataDir('krylo-agents-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runHook(HOOK, {
      hook_event_name: 'SubagentStart',
      agent_type: 'krylo:reviewer',
      model: 'opus',
      resolved_model: 'claude-opus-4-6',
      cwd: dataDir,
    }, dataDir);
    assert.equal(readState(statePath).agents[0].resolvedModel, 'claude-opus-4-6');
  } finally {
    cleanup(dataDir);
  }
});

test('agent-events: no active run -> silent, nothing persisted', () => {
  const dataDir = mkTempDataDir('krylo-agents-');
  try {
    const res = runHook(HOOK, { hook_event_name: 'SubagentStart', agent_type: 'x', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(persistedBytes(dataDir), '');
  } finally {
    cleanup(dataDir);
  }
});
