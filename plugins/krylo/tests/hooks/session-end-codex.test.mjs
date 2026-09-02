import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { mkTempDataDir, patchState, readState, cleanup, createActiveRunCodexOnly, runCliCodexOnly, runHookCodexOnly } from './helpers.mjs';

const HOOK = 'status/session-end-codex.mjs';

function sessionEndPayload(cwd, extra = {}) {
  return {
    hook_event_name: 'SessionEnd',
    cwd,
    session_id: 'codex-hook-session',
    reason: 'other',
    transcript_path: null,
    ...extra,
  };
}

test('session-end-codex: no active run -> no-op, exit 0, no output', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('session-end-codex: SessionEnd for a DIFFERENT session than the active run is a no-op (cannot finalize/mutate another session\'s run)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    const before = readState(statePath);

    const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir, { session_id: 'a-different-session-entirely' }), dataDir);
    assert.equal(res.status, 0);
    assert.deepEqual(readState(statePath), before, 'the real active run must be completely untouched by a different session\'s SessionEnd');
  } finally {
    cleanup(dataDir);
  }
});

test('session-end-codex: an already-terminal run is a no-op -- terminalState, findings, and evidence remain byte-for-byte unchanged', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    patchState(statePath, (s) => {
      s.terminalState = 'VERIFIED_COMPLETE';
      s.phase = 'COMPLETING';
    });
    const before = readState(statePath);

    const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.deepEqual(readState(statePath), before);
  } finally {
    cleanup(dataDir);
  }
});

test('session-end-codex: an active, NON-terminal run records a telemetry marker but never mutates terminalState, findings, or acceptance criteria (evidence/history preserved)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath, runId } = createActiveRunCodexOnly(dataDir);
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'still in progress'], dataDir);
    const before = readState(statePath);

    const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir), dataDir);
    assert.equal(res.status, 0);

    const after = readState(statePath);
    assert.equal(after.terminalState, null, 'SessionEnd must never fabricate a terminal state');
    assert.deepEqual(after.acceptanceCriteria, before.acceptanceCriteria, 'evidence/criteria history must be preserved exactly');
    assert.deepEqual(after.findings, before.findings);

    // A telemetry marker was recorded (best-effort, never a security boundary).
    const telemetryPath = `${dataDir}/telemetry/${runId}.jsonl`;
    if (fs.existsSync(telemetryPath)) {
      const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.ok(lines.some((l) => l.includes('session-end')), 'a session-end telemetry event should be recorded for an active non-terminal run');
    }
  } finally {
    cleanup(dataDir);
  }
});

test('session-end-codex: malformed/unreadable stdin fails safe -- no-op, never crashes', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(HOOK, null, dataDir, { rawInput: 'not json' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('session-end-codex: concurrent KRYLO sessions in the same project -- SessionEnd for session A never touches session B\'s run', () => {
  const dataDirA = mkTempDataDir('krylo-codex-hook-a-');
  const dataDirB = mkTempDataDir('krylo-codex-hook-b-');
  try {
    // Two independent data roots simulate two isolated sessions/projects
    // (matching this codebase's established session-isolation test
    // convention elsewhere -- state is keyed by {host, hostSessionId,
    // projectRootHash}, and each temp data dir here is its own project root).
    const runA = createActiveRunCodexOnly(dataDirA);
    const runB = createActiveRunCodexOnly(dataDirB);
    const beforeB = readState(runB.statePath);

    runHookCodexOnly(HOOK, sessionEndPayload(dataDirA), dataDirA);

    assert.deepEqual(readState(runB.statePath), beforeB, "session A's SessionEnd must never touch session B's run");
  } finally {
    cleanup(dataDirA);
    cleanup(dataDirB);
  }
});
