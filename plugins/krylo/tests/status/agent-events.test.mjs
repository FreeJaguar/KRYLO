import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { mkTempDataDir, createActiveRun, runHook, readState, persistedBytes, cleanup } from '../hooks/helpers.mjs';
import { recordAgentEvent } from '../../scripts/status/agent-events.mjs';

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

test('agent-events: telemetry never claims a persisted mutation when saveState() actually failed', () => {
  // Same bug class and same fix pattern as fingerprint.mjs's analogous test:
  // recordAgentEvent() must not record an "agent-start"/"agent-stop"
  // telemetry event for a mutation that was never actually persisted --
  // e.g. because the run's pre-migration backup write failed and
  // saveState() correctly refused the save (see scripts/lib/state.mjs).
  const dataDir = mkTempDataDir('krylo-agentevents-savefail-');
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dataDir;
  try {
    const runId = 'run-legacyae0001';
    const runDir = path.join(dataDir, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    // A real 1.0.0-schema fixture: loadState() migrates it in memory to the
    // current schema, so saveState() will see a schemaVersion mismatch
    // against the on-disk file and attempt the one-time pre-migration backup.
    const legacy = {
      schemaVersion: '1.0.0',
      kryloVersion: '0.1.1',
      sessionId: 'legacy-session',
      runId,
      project: { rootHash: 'a'.repeat(64) },
      goal: { normalized: 'legacy fixture', lane: 'BUILD', risk: 'low' },
      acceptanceCriteria: [],
      agents: [],
      toolCounters: {},
      orbit: {
        budget: 3, cycle: 1, stopBlocks: 0, fingerprints: [],
        stagnation: { cyclesWithoutProgress: 0, lastProgressCycle: 0 },
        strategyChanges: 0, requiredStrategyChange: false,
      },
      questionGate: { budget: 1, used: 0, grants: [] },
      riskApprovals: [],
      findings: [],
      evidence: [],
      phase: 'EXECUTING',
      terminalState: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const realWriteFileSync = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (typeof target === 'string' && target.includes('state.pre-migration-')) {
        throw new Error('simulated disk failure writing the pre-migration backup');
      }
      return realWriteFileSync.call(fs, target, ...rest);
    });

    try {
      recordAgentEvent(runId, 'SubagentStart', { agent_type: 'krylo:builder', model: 'sonnet' });
    } finally {
      mock.restoreAll();
    }

    // The mutation must not have been persisted (the backup failure must
    // have refused the save)...
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.0.0', 'the original file must be untouched: the failed save must never have overwritten it');
    assert.equal(onDisk.agents.length, 0);

    // ...and telemetry must not claim otherwise: no agent-start event recorded.
    const telemetryPath = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
    const telemetryText = fs.existsSync(telemetryPath) ? fs.readFileSync(telemetryPath, 'utf8') : '';
    assert.ok(!telemetryText.includes('"event":"agent-start"'), 'telemetry must not claim an agent was recorded when the save actually failed');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    cleanup(dataDir);
  }
});
