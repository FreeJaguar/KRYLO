import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { mkTempDataDir, createActiveRun, runHook, readState, persistedBytes, cleanup } from './helpers.mjs';
import { recordFailureFingerprint } from '../../scripts/orbit/fingerprint.mjs';

const HOOK = 'orbit/fingerprint.mjs';

const RAW_ERROR_MARKER = 'XyzzyUniqueFailureMarker_4242';

function failurePayload(cwd, errorText, toolName = 'Bash') {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: { command: 'npm test' },
    error: errorText,
    cwd,
  };
}

test('fingerprint: same failure twice -> one fingerprint, count 2, strategy change required', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    const err = `Test run failed: ${RAW_ERROR_MARKER} expected 5 to equal 6 at /home/user/project/test/x.test.js:42`;

    runHook(HOOK, failurePayload(dataDir, err), dataDir);
    let state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 1);
    assert.equal(state.orbit.fingerprints[0].count, 1);
    assert.equal(state.orbit.requiredStrategyChange, false);

    runHook(HOOK, failurePayload(dataDir, err), dataDir);
    state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 1);
    assert.equal(state.orbit.fingerprints[0].count, 2);
    assert.equal(state.orbit.requiredStrategyChange, true);
    assert.equal(state.orbit.fingerprints[0].category, 'test');
  } finally {
    cleanup(dataDir);
  }
});

test('fingerprint: different failures -> distinct hashes', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    runHook(HOOK, failurePayload(dataDir, 'eslint found 3 problems in src/a.js'), dataDir);
    runHook(HOOK, failurePayload(dataDir, 'tsc error TS2345: argument of type string'), dataDir);
    const state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 2);
    assert.notEqual(state.orbit.fingerprints[0].hash, state.orbit.fingerprints[1].hash);
  } finally {
    cleanup(dataDir);
  }
});

test('fingerprint: raw error text never reaches state or telemetry', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    runHook(HOOK, failurePayload(dataDir, `boom ${RAW_ERROR_MARKER} secret ghp_1234567890abcdefghijklmno`), dataDir);
    const everything = persistedBytes(dataDir);
    assert.ok(!everything.includes(RAW_ERROR_MARKER), 'raw error marker leaked into persisted data');
    assert.ok(!everything.includes('ghp_1234567890abcdefghijklmno'), 'secret leaked into persisted data');
  } finally {
    cleanup(dataDir);
  }
});

test('fingerprint: telemetry never claims a persisted mutation when saveState() actually failed', () => {
  // Security-hardening checkpoint: recordFailureFingerprint() must not
  // record a "failure" telemetry event (with a real cycle number) for a
  // fingerprint mutation that was never actually persisted -- e.g. because
  // the run's pre-migration backup write failed and saveState() correctly
  // refused the save (see scripts/lib/state.mjs's saveState()).
  const dataDir = mkTempDataDir('krylo-fingerprint-savefail-');
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dataDir;
  try {
    const runId = 'run-legacyfp0001';
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
      recordFailureFingerprint(runId, 'Bash', 'eslint found 3 problems in src/a.js');
    } finally {
      mock.restoreAll();
    }

    // The mutation must not have been persisted (the backup failure must
    // have refused the save)...
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.0.0', 'the original file must be untouched: the failed save must never have overwritten it');
    assert.equal(onDisk.orbit.fingerprints.length, 0);

    // ...and telemetry must not claim otherwise: no "failure" event recorded.
    const telemetryPath = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
    const telemetryText = fs.existsSync(telemetryPath) ? fs.readFileSync(telemetryPath, 'utf8') : '';
    assert.ok(!telemetryText.includes('"event":"failure"'), 'telemetry must not claim a fingerprint was recorded when the save actually failed');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    cleanup(dataDir);
  }
});

test('fingerprint: no active run -> exit 0, nothing persisted', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runHook(HOOK, failurePayload(dataDir, 'anything'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(persistedBytes(dataDir), '');
  } finally {
    cleanup(dataDir);
  }
});
