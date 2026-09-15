import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

    // A telemetry marker was recorded (best-effort, never a security
    // boundary -- but recordEvent() is a synchronous, unconditional
    // fs.appendFileSync call on this code path, so this must always be
    // present, not merely checked when present (Reviewer Finding 3).
    const telemetryPath = `${dataDir}/telemetry/${runId}.jsonl`;
    assert.ok(fs.existsSync(telemetryPath), 'a session-end telemetry event should be recorded for an active non-terminal run');
    const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.some((l) => l.includes('session-end')), 'a session-end telemetry event should be recorded for an active non-terminal run');
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

// Regression (Medium, independently found and reproduced by both a fresh
// Reviewer and a fresh Security Reviewer): SessionEnd previously acquired
// the run's exclusive state lock even though it never mutates state.json
// (only a read, plus an already-atomic-append recordEvent() call). Given
// the confirmed ~1-3 second SessionEnd platform teardown budget and the
// lock's own up-to-6-second retry window, SessionEnd could be killed by
// the platform WHILE holding (or waiting on) that lock -- and since
// lock.mjs has no staleness recovery, the orphaned lock file then makes
// every later locked operation on that SAME run (Stop, update-state.mjs)
// wait the full retry budget and fail with lock-timeout, permanently
// degrading a run that should have kept working. SessionEnd needs no lock
// at all, so it no longer takes one -- proven here by holding the real
// lock externally for the whole hook invocation and confirming SessionEnd
// still completes immediately rather than blocking on it.
test('session-end-codex: never blocks on the run lock, since it performs no state mutation (regression: previously could orphan the lock and degrade the run for its own teardown deadline)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { runId } = createActiveRunCodexOnly(dataDir);
    const lockPath = path.join(dataDir, 'runs', runId, '.state.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, 'wx'); // hold the real lock for the whole test
    try {
      const start = Date.now();
      const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir), dataDir);
      const elapsedMs = Date.now() - start;
      assert.equal(res.status, 0);
      assert.ok(elapsedMs < 1000, `SessionEnd must not wait on the run lock at all (took ${elapsedMs}ms)`);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
    }
  } finally {
    cleanup(dataDir);
  }
});

// Regression (Reviewer Finding 4): the earlier version of this test used two
// SEPARATE temp data dirs, which only proves data-root isolation (already
// covered by the "DIFFERENT session" test above) -- not that two genuinely
// CONCURRENT sessions in the SAME project (same data root, same
// projectRootHash, two different hostSessionIds, two distinct active-run
// pointers) stay isolated from each other. This version creates both runs
// directly against one shared dataDir.
test('session-end-codex: two concurrent KRYLO sessions in the SAME project -- SessionEnd for session A never touches session B\'s run', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const initA = runCliCodexOnly('runtime/init-run.mjs', [
      '--goal', 'session A run', '--session', 'codex-session-a', '--project-dir', dataDir, '--lane', 'PATCH', '--risk', 'low',
    ], dataDir);
    if (initA.status !== 0 || !initA.json?.ok) throw new Error(`fixture init-run (session A) failed: ${initA.stdout} ${initA.stderr}`);

    const initB = runCliCodexOnly('runtime/init-run.mjs', [
      '--goal', 'session B run', '--session', 'codex-session-b', '--project-dir', dataDir, '--lane', 'PATCH', '--risk', 'low',
    ], dataDir);
    if (initB.status !== 0 || !initB.json?.ok) throw new Error(`fixture init-run (session B) failed: ${initB.stdout} ${initB.stderr}`);
    const runBStatePath = path.join(dataDir, 'runs', initB.json.runId, 'state.json');
    const beforeB = readState(runBStatePath);

    const res = runHookCodexOnly(HOOK, sessionEndPayload(dataDir, { session_id: 'codex-session-a' }), dataDir);
    assert.equal(res.status, 0);

    assert.deepEqual(readState(runBStatePath), beforeB, "session A's SessionEnd must never touch session B's run in the same project");
  } finally {
    cleanup(dataDir);
  }
});
