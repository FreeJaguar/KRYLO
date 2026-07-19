import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, readState, persistedBytes, cleanup } from './helpers.mjs';

const HOOK = 'runtime/posttool-telemetry.mjs';

const ARG_MARKER = 'SecretArgMarker_9911';

test('posttool-telemetry: increments the tool counter, never persists arguments', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: ARG_MARKER, path: `/home/user/${ARG_MARKER}` },
      duration_ms: 123,
      cwd: dataDir,
    };
    runHook(HOOK, payload, dataDir);
    runHook(HOOK, payload, dataDir);

    const state = readState(statePath);
    assert.equal(state.toolCounters.Grep, 2);

    const everything = persistedBytes(dataDir);
    assert.ok(!everything.includes(ARG_MARKER), 'tool arguments leaked into persisted data');
  } finally {
    cleanup(dataDir);
  }
});

test('posttool-telemetry: no active run -> exit 0, silent', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runHook(HOOK, { hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});
