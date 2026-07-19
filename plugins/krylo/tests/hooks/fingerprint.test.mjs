import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, readState, persistedBytes, cleanup } from './helpers.mjs';

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
