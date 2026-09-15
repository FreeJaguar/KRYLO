import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, patchState, cleanup, createActiveRunCodexOnly, runHookCodexOnly } from './helpers.mjs';

const HOOK = 'security/session-start-codex.mjs';

function sessionStartPayload(cwd, extra = {}) {
  return {
    hook_event_name: 'SessionStart',
    cwd,
    session_id: 'codex-hook-session',
    model: 'gpt-test',
    permission_mode: 'default',
    source: 'startup',
    transcript_path: null,
    ...extra,
  };
}

test('session-start-codex: ordinary session (no active run) stays completely inert -- no output, exit 0', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const res = runHookCodexOnly(HOOK, sessionStartPayload(dataDir), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: cannot create a KRYLO run under any circumstance', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    runHookCodexOnly(HOOK, sessionStartPayload(dataDir), dataDir);
    // No active run must exist afterward -- resolveActiveRun via the real
    // Stop gate must still report no active run, since SessionStart never
    // creates one.
    const stopRes = runHookCodexOnly('orbit/stop-gate-codex.mjs', {
      hook_event_name: 'Stop', cwd: dataDir, session_id: 'codex-hook-session', turn_id: 't1',
      model: 'gpt-test', permission_mode: 'default', stop_hook_active: false, last_assistant_message: null, transcript_path: null,
    }, dataDir);
    assert.equal(stopRes.stdout.trim(), '', 'no run should exist to even consider blocking');
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: every source value (startup/resume/clear/compact) stays inert when no run is active', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      const res = runHookCodexOnly(HOOK, sessionStartPayload(dataDir, { source }), dataDir);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '', `source=${source} must stay inert with no active run`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: an active, non-terminal run bound to this exact session emits a factual additionalContext reminder, never a fabricated claim', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(HOOK, sessionStartPayload(dataDir, { source: 'resume' }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(res.json?.hookSpecificOutput?.additionalContext ?? '', /already active/i);
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: an active run bound to a DIFFERENT session stays inert (session isolation, no cross-session leak)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir); // bound to 'codex-hook-session' by the helper's own default
    const res = runHookCodexOnly(HOOK, sessionStartPayload(dataDir, { session_id: 'a-totally-different-session' }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: an already-terminal run stays inert (nothing useful to say, and never implies KRYLO is active)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    patchState(statePath, (s) => {
      s.terminalState = 'VERIFIED_COMPLETE';
      s.phase = 'COMPLETING';
    });
    const res = runHookCodexOnly(HOOK, sessionStartPayload(dataDir, { source: 'resume' }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('session-start-codex: malformed/unreadable stdin fails safe -- inert, never crashes, never emits misleading output', () => {
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
