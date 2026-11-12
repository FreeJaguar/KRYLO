// Invariant: a run bound to host session S is enforced for S no matter what
// working directory a hook payload reports.
//
// Both hosts used to resolve the active run only through a hash of the
// payload's `cwd`. That `cwd` is not stable: Claude Code carries a `cd`
// into a project subdirectory over to later Bash calls (and reports it as
// the hook's `cwd`), and Codex 0.166.0 started reporting the command's own
// working directory to PreToolUse. Either way the hash moved, no run was
// found, and every gate fell through to its "ordinary session" pass-through
// in the middle of a governed run. Found by a direct probe of risk-gate.mjs;
// see docs/adr/0043-session-keyed-run-resolution.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mkTempDataDir,
  createActiveRun,
  runHook,
  runCli,
  createActiveRunCodexOnly,
  runHookCodexOnly,
  runCliCodexOnly,
  cleanup,
} from '../hooks/helpers.mjs';
import { computeProjectRootHash } from '../../scripts/lib/state.mjs';

function setup(prefix) {
  const dataDir = mkTempDataDir(prefix);
  const projectDir = path.join(dataDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'sub', 'deeper'), { recursive: true });
  const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-unrelated-'));
  return { dataDir, projectDir, unrelatedDir };
}

function teardown({ dataDir, unrelatedDir }) {
  cleanup(dataDir);
  fs.rmSync(unrelatedDir, { recursive: true, force: true });
}

function cwdCases({ projectDir, unrelatedDir }) {
  return [
    ['the project root', projectDir],
    ['a project subdirectory', path.join(projectDir, 'sub')],
    ['a nested project subdirectory', path.join(projectDir, 'sub', 'deeper')],
    ['an unrelated directory', unrelatedDir],
    ['no cwd at all', undefined],
  ];
}

function bash(sessionId, cwd, command) {
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: sessionId, permission_mode: 'default' };
  if (cwd !== undefined) payload.cwd = cwd;
  return payload;
}

function stop(sessionId, cwd) {
  const payload = { hook_event_name: 'Stop', session_id: sessionId, stop_hook_active: false };
  if (cwd !== undefined) payload.cwd = cwd;
  return payload;
}

const decisionOf = (res) => res.json?.hookSpecificOutput?.permissionDecision ?? null;

// ---------------------------------------------------------------- Claude host

test('claude risk-gate: a governed session stays gated wherever its cwd points', () => {
  const ctx = setup('krylo-cwd-claude-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    for (const [label, cwd] of cwdCases(ctx)) {
      const push = runHook('security/risk-gate.mjs', bash('hook-session', cwd, 'git push origin main'), ctx.dataDir);
      assert.equal(push.status, 0, label);
      assert.equal(decisionOf(push), 'ask', `git push from ${label} must reach the native approval prompt`);
      const secret = runHook('security/risk-gate.mjs', bash('hook-session', cwd, 'cat .env'), ctx.dataDir);
      assert.equal(decisionOf(secret), 'deny', `reading .env from ${label} must stay denied`);
    }
  } finally {
    teardown(ctx);
  }
});

test('claude risk-gate: a different, ungoverned session is still left alone (control)', () => {
  const ctx = setup('krylo-cwd-claude-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    for (const cwd of [ctx.projectDir, ctx.unrelatedDir]) {
      const res = runHook('security/risk-gate.mjs', bash('other-session', cwd, 'git push origin main'), ctx.dataDir, { env: { CLAUDE_SESSION_ID: 'other-session' } });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '', 'an ordinary session with no run of its own must pass through silently');
    }
  } finally {
    teardown(ctx);
  }
});

test('claude stop-gate: an unmet run cannot end just because the session changed directory', () => {
  const ctx = setup('krylo-cwd-claude-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    runCli('runtime/update-state.mjs', ['--add-criterion', 'cwd invariant holds', '--project-dir', ctx.projectDir], ctx.dataDir);
    const res = runHook('orbit/stop-gate.mjs', stop('hook-session', path.join(ctx.projectDir, 'sub')), ctx.dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, 'block');
  } finally {
    teardown(ctx);
  }
});

test('claude risk-gate: a run that already ended is not resurrected by the session lookup', () => {
  const ctx = setup('krylo-cwd-claude-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    const ended = runCli('runtime/update-state.mjs', ['--terminal', 'SAFE_BLOCKED', '--project-dir', ctx.projectDir], ctx.dataDir);
    assert.equal(ended.status, 0, ended.stdout);
    const res = runHook('security/risk-gate.mjs', bash('hook-session', path.join(ctx.projectDir, 'sub'), 'git push origin main'), ctx.dataDir);
    assert.equal(res.stdout, '', 'a terminal run must not gate anything');
  } finally {
    teardown(ctx);
  }
});

// ----------------------------------------------------------------- Codex host

test('codex risk-gate: a governed session stays gated wherever its cwd points', () => {
  const ctx = setup('krylo-cwd-codex-');
  try {
    createActiveRunCodexOnly(ctx.dataDir, { projectDir: ctx.projectDir });
    for (const [label, cwd] of cwdCases(ctx)) {
      for (const command of ['git push origin main', 'cat .env']) {
        const res = runHookCodexOnly('security/risk-gate-codex.mjs', bash('codex-hook-session', cwd, command), ctx.dataDir);
        assert.equal(res.status, 0, label);
        assert.equal(decisionOf(res), 'deny', `${command} from ${label} must be denied on Codex`);
      }
    }
  } finally {
    teardown(ctx);
  }
});

test('codex risk-gate: a different, ungoverned session is still left alone (control)', () => {
  const ctx = setup('krylo-cwd-codex-');
  try {
    createActiveRunCodexOnly(ctx.dataDir, { projectDir: ctx.projectDir });
    const res = runHookCodexOnly('security/risk-gate-codex.mjs', bash('other-codex-session', ctx.unrelatedDir, 'git push origin main'), ctx.dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    teardown(ctx);
  }
});

test('codex risk-gate: a recognized-but-failed bootstrap still fails closed from a subdirectory', () => {
  const ctx = setup('krylo-cwd-codex-');
  try {
    // No run exists; only the marker user-prompt-submit-codex.mjs writes
    // when a recognized $krylo-run invocation failed to bootstrap, keyed to
    // the session's own project root.
    const markerPath = path.join(ctx.dataDir, 'bootstrap-failures', computeProjectRootHash(ctx.projectDir), 'codex', 'codex-hook-session.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ reason: 'test failure', createdAt: new Date().toISOString() }), 'utf8');
    for (const cwd of [ctx.projectDir, path.join(ctx.projectDir, 'sub'), ctx.unrelatedDir]) {
      const res = runHookCodexOnly('security/risk-gate-codex.mjs', bash('codex-hook-session', cwd, 'echo hello'), ctx.dataDir);
      assert.equal(decisionOf(res), 'deny', `the failed-bootstrap marker must deny from ${cwd}`);
    }
  } finally {
    teardown(ctx);
  }
});

test('codex stop-gate: an unmet run cannot end just because the command cwd moved', () => {
  const ctx = setup('krylo-cwd-codex-');
  try {
    createActiveRunCodexOnly(ctx.dataDir, { projectDir: ctx.projectDir });
    runCliCodexOnly('runtime/update-state.mjs', ['--add-criterion', 'cwd invariant holds', '--project-dir', ctx.projectDir], ctx.dataDir);
    const res = runHookCodexOnly('orbit/stop-gate-codex.mjs', stop('codex-hook-session', path.join(ctx.projectDir, 'sub')), ctx.dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, 'block');
  } finally {
    teardown(ctx);
  }
});

// ------------------------------------------------- independent review round 1
// Each case below reproduces a gap an independent security review found in
// the first version of this fix (docs/adr/0043-session-keyed-run-resolution.md).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

// Spawns a hook with a chosen PROCESS cwd: the fail-safe paths have no
// usable payload cwd and fall back to the hook process's own directory.
function runHookIn(cwd, scriptRel, rawInput, env) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, scriptRel)], { cwd, input: rawInput, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, json };
}

const claudeEnv = (dataDir) => ({ CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, CLAUDE_SESSION_ID: '', KRYLO_LOCAL_TELEMETRY: 'false', KRYLO_HOST: '' });

test('review F1: the Claude fail-safe path denies from a subdirectory when only normalization failed', () => {
  const ctx = setup('krylo-cwd-review-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    // An oversized permission_mode fails host-identity validation while
    // session_id stays valid -- normalizeClaudeHookPayload()'s
    // 'invalid-host-identity' branch, which routes to the fail-safe path.
    const raw = JSON.stringify({ ...bash('hook-session', path.join(ctx.projectDir, 'sub'), 'echo hi'), permission_mode: 'x'.repeat(300) });
    for (const processCwd of [ctx.projectDir, path.join(ctx.projectDir, 'sub')]) {
      const res = runHookIn(processCwd, 'security/risk-gate.mjs', raw, claudeEnv(ctx.dataDir));
      assert.equal(res.status, 0);
      assert.equal(decisionOf(res), 'deny', `fail-safe must deny with process cwd ${processCwd}`);
    }
  } finally {
    teardown(ctx);
  }
});

test('review F2: a session with runs in two projects resolves a subdirectory to the project it is inside', () => {
  const ctx = setup('krylo-cwd-review-');
  const projectB = path.join(ctx.dataDir, 'project-b');
  fs.mkdirSync(projectB, { recursive: true });
  try {
    const a = createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    runCli('runtime/update-state.mjs', ['--add-criterion', 'A criterion', '--project-dir', ctx.projectDir], ctx.dataDir);
    const b = createActiveRun(ctx.dataDir, { projectDir: projectB }); // created later: the "most recent"
    runCli('runtime/update-state.mjs', ['--add-criterion', 'B criterion', '--project-dir', projectB], ctx.dataDir);
    const res = runHook('orbit/stop-gate.mjs', stop('hook-session', path.join(ctx.projectDir, 'sub')), ctx.dataDir);
    assert.equal(res.json?.decision, 'block');
    assert.match(res.json.reason, /A criterion/, 'the block must be about run A, the project the session is inside');
    const readOrbit = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).orbit.stopBlocks;
    assert.equal(readOrbit(a.statePath), 1, 'run A must consume the Stop block');
    assert.equal(readOrbit(b.statePath), 0, 'run B must be untouched');
  } finally {
    teardown(ctx);
  }
});

test('review F3: a malformed pointer under another project never hides the real run', () => {
  const ctx = setup('krylo-cwd-review-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    for (const [i, runId] of [42, '../../escape', ''].entries()) {
      const bogus = path.join(ctx.dataDir, 'active-runs', computeProjectRootHash(path.join(ctx.unrelatedDir, `p${i}`)), 'claude', 'hook-session.json');
      fs.mkdirSync(path.dirname(bogus), { recursive: true });
      fs.writeFileSync(bogus, JSON.stringify({ runId, updatedAt: '2999-01-01T00:00:00.000Z' }), 'utf8');
    }
    const res = runHook('security/risk-gate.mjs', bash('hook-session', ctx.unrelatedDir, 'git push origin main'), ctx.dataDir);
    assert.equal(decisionOf(res), 'ask');
  } finally {
    teardown(ctx);
  }
});

test('review F4: the runtime CLI finds the run from a subdirectory for a known session', () => {
  const ctx = setup('krylo-cwd-review-');
  try {
    createActiveRun(ctx.dataDir, { projectDir: ctx.projectDir });
    const sub = path.join(ctx.projectDir, 'sub');
    const res = runCli('runtime/update-state.mjs', ['--add-criterion', 'from a subdirectory', '--project-dir', sub, '--session', 'hook-session'], ctx.dataDir);
    assert.equal(res.status, 0, res.stdout);
    const read = runCli('runtime/read-state.mjs', ['--project-dir', sub, '--session', 'hook-session'], ctx.dataDir);
    assert.equal(read.status, 0, read.stdout);
    assert.match(read.stdout, /from a subdirectory/);
  } finally {
    teardown(ctx);
  }
});

test('review F5: the Codex failed-bootstrap marker still denies when the payload has no cwd', () => {
  const ctx = setup('krylo-cwd-review-');
  try {
    const markerPath = path.join(ctx.dataDir, 'bootstrap-failures', computeProjectRootHash(ctx.projectDir), 'codex', 'codex-hook-session.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ reason: 'test failure', createdAt: new Date().toISOString() }), 'utf8');
    // Both the normal path (identity normalizes, no cwd) and the fail-safe
    // path (identity fails validation via an oversized permission_mode, no
    // cwd) must deny; the fail-safe path used to skip the marker without a cwd.
    const normal = runHookCodexOnly('security/risk-gate-codex.mjs', bash('codex-hook-session', undefined, 'echo hello'), ctx.dataDir);
    assert.equal(decisionOf(normal), 'deny', 'normal path');
    const invalid = { ...bash('codex-hook-session', undefined, 'echo hello'), permission_mode: 'x'.repeat(300) };
    const failSafe = runHookCodexOnly('security/risk-gate-codex.mjs', invalid, ctx.dataDir);
    assert.equal(decisionOf(failSafe), 'deny', 'fail-safe path');
  } finally {
    teardown(ctx);
  }
});
