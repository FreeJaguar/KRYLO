// docs/adr/0045-transient-state-io-retry.md: when this session's own run
// pointer, or the run state it names, exists but cannot be read, whether the
// session is governed is unknown. The risk gates on both hosts must deny
// instead of silently allowing, and a Codex $krylo-run re-invocation must not
// replace the live run. A session with no KRYLO pointer at all stays a silent
// allow: KRYLO is not the default agent.
//
// The fault is injected with a test-only --import preload
// (tests/fixtures/state-io/fail-reads-of-path.mjs) that fails every read of
// one exact file in the hook process and logs each injected failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SCRIPTS_ROOT,
  mkTempDataDir,
  createActiveRun,
  createActiveRunCodexOnly,
  runHook,
  runHookCodexOnly,
  cleanup,
} from './helpers.mjs';

const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'state-io', 'fail-reads-of-path.mjs');
const FIXTURES = path.resolve(SCRIPTS_ROOT, '..', 'tests', 'fixtures', 'codex-runtime-compat');
const FAKE_CLI = path.join(FIXTURES, os.platform() === 'win32' ? 'fake-codex-cli.cmd' : 'fake-codex-cli.sh');

const UNREADABLE_REASON = /could not read this session's KRYLO run (state|pointer)/;

function faultEnv(dataDir, target, code = 'EBUSY') {
  return {
    NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
    KRYLO_TEST_FAIL_READ_PATH: target,
    KRYLO_TEST_FAIL_READ_CODE: code,
    KRYLO_TEST_FAIL_READ_LOG: path.join(dataDir, 'injected-faults.log'),
  };
}

function faultsFired(dataDir) {
  const log = path.join(dataDir, 'injected-faults.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

function pointerPathFor(dataDir, host, sessionId) {
  const root = path.join(dataDir, 'active-runs');
  for (const project of fs.readdirSync(root)) {
    const candidate = path.join(root, project, host, `${sessionId}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no ${host} pointer for ${sessionId}`);
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

function reason(res) {
  return res.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
}

function gateEvents(dataDir, runId) {
  const file = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const FORCE_PUSH = 'git push --force origin main';

function claudePayload(cwd, sessionId = 'hook-session') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: FORCE_PUSH }, cwd, session_id: sessionId, permission_mode: 'auto' };
}

function codexPayload(cwd, sessionId = 'codex-hook-session') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: FORCE_PUSH }, cwd, session_id: sessionId, permission_mode: 'default' };
}

// ------------------------------------------------------------ Claude gate

test('risk-gate (Claude): control -- a readable run gets the native ask for a force push', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-ctl-');
  try {
    createActiveRun(dataDir);
    const res = runHook('security/risk-gate.mjs', claudePayload(dataDir), dataDir);
    assert.equal(decision(res), 'ask');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate (Claude): an unreadable run state denies instead of silently allowing', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-state-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    const res = runHook('security/risk-gate.mjs', claudePayload(dataDir), dataDir, { env: faultEnv(dataDir, statePath, 'EBUSY') });
    assert.equal(res.status, 0);
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), UNREADABLE_REASON);
    assert.match(reason(res), /\(EBUSY\)/);
    assert.ok(gateEvents(dataDir, runId).some((e) => e.event === 'risk-gate' && e.category === 'run-state-unreadable' && e.status === 'denied'));
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate (Claude): this session\'s unreadable pointer denies instead of silently allowing', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-ptr-');
  try {
    createActiveRun(dataDir);
    const pointerPath = pointerPathFor(dataDir, 'claude', 'hook-session');
    const res = runHook('security/risk-gate.mjs', claudePayload(dataDir), dataDir, { env: faultEnv(dataDir, pointerPath, 'EPERM') });
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), /could not read this session's KRYLO run pointer/);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate (Claude): a session with no KRYLO pointer stays a silent allow, even while another session\'s run is unreadable', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-none-');
  try {
    const { statePath } = createActiveRun(dataDir); // session 'hook-session'
    const res = runHook('security/risk-gate.mjs', claudePayload(dataDir, 'unrelated-session'), dataDir, {
      env: { ...faultEnv(dataDir, statePath, 'EBUSY'), CLAUDE_SESSION_ID: 'unrelated-session' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ungoverned session must never be intercepted');
  } finally {
    cleanup(dataDir);
  }
});

// ------------------------------------------------------------- Codex gate

test('risk-gate-codex: control -- a readable run denies a force push for the require-approval reason', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-codex-ctl-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly('security/risk-gate-codex.mjs', codexPayload(dataDir), dataDir);
    assert.equal(decision(res), 'deny');
    assert.doesNotMatch(reason(res), UNREADABLE_REASON);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: an unreadable run state denies instead of silently allowing', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-codex-state-');
  try {
    const { runId, statePath } = createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly('security/risk-gate-codex.mjs', codexPayload(dataDir), dataDir, { env: faultEnv(dataDir, statePath, 'EBUSY') });
    assert.equal(res.status, 0);
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), UNREADABLE_REASON);
    assert.ok(gateEvents(dataDir, runId).some((e) => e.event === 'risk-gate-codex' && e.category === 'run-state-unreadable' && e.status === 'denied'));
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: this session\'s unreadable pointer denies instead of silently allowing', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-codex-ptr-');
  try {
    createActiveRunCodexOnly(dataDir);
    const pointerPath = pointerPathFor(dataDir, 'codex', 'codex-hook-session');
    const res = runHookCodexOnly('security/risk-gate-codex.mjs', codexPayload(dataDir), dataDir, { env: faultEnv(dataDir, pointerPath, 'EBUSY') });
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), /could not read this session's KRYLO run pointer/);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: a session with no KRYLO pointer stays a silent allow, even while another session\'s run is unreadable', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-codex-none-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir); // session 'codex-hook-session'
    const res = runHookCodexOnly('security/risk-gate-codex.mjs', codexPayload(dataDir, 'unrelated-codex-session'), dataDir, { env: faultEnv(dataDir, statePath, 'EBUSY') });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ungoverned session must never be intercepted');
  } finally {
    cleanup(dataDir);
  }
});

// ------------------------------------------- unreadable-payload fail-safe

// Unparseable stdin: the gates cannot classify anything and fall back to the
// process cwd plus the host's session environment variable to find a run to
// deny under. An indeterminate run must be denied there too.
function spawnGateWithGarbage(script, dataDir, env) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, script)], { encoding: 'utf8', input: 'not valid json {{{', cwd: dataDir, env });
  let json = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, json };
}

function claudeGarbageEnv(dataDir, extra) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, KRYLO_LOCAL_TELEMETRY: 'true', ...extra };
  if (!('CLAUDE_SESSION_ID' in extra)) delete env.CLAUDE_SESSION_ID;
  return env;
}

test('risk-gate (Claude) fail-safe path: unparseable stdin with an unreadable run state denies for that reason', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-garbage-');
  try {
    const { statePath } = createActiveRun(dataDir);
    const res = spawnGateWithGarbage('security/risk-gate.mjs', dataDir, claudeGarbageEnv(dataDir, { CLAUDE_SESSION_ID: 'hook-session', ...faultEnv(dataDir, statePath, 'EBUSY') }));
    assert.equal(res.status, 0);
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), UNREADABLE_REASON);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate (Claude) fail-safe path: with no session id at all, the unreadable state of the newest pointer still denies (ADR-0020 fallback)', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-claude-garbage-nosession-');
  try {
    const { statePath } = createActiveRun(dataDir);
    const res = spawnGateWithGarbage('security/risk-gate.mjs', dataDir, claudeGarbageEnv(dataDir, faultEnv(dataDir, statePath, 'EBUSY')));
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), UNREADABLE_REASON);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex fail-safe path: unparseable stdin with an unreadable run state denies for that reason', () => {
  const dataDir = mkTempDataDir('krylo-unreadable-codex-garbage-');
  try {
    const { statePath } = createActiveRunCodexOnly(dataDir);
    const env = { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: dataDir, KRYLO_HOST: 'codex', KRYLO_LOCAL_TELEMETRY: 'true', CODEX_THREAD_ID: 'codex-hook-session', ...faultEnv(dataDir, statePath, 'EBUSY') };
    for (const key of ['KRYLO_DATA_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_SESSION_ID']) delete env[key];
    const res = spawnGateWithGarbage('security/risk-gate-codex.mjs', dataDir, env);
    assert.equal(res.status, 0);
    assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
    assert.equal(decision(res), 'deny', `expected a fail-safe deny, got: ${res.stdout}`);
    assert.match(reason(res), UNREADABLE_REASON);
  } finally {
    cleanup(dataDir);
  }
});

// ---------------------------------------------- Codex $krylo-run re-entry

function promptPayload(cwd, sessionId) {
  return {
    hook_event_name: 'UserPromptSubmit',
    prompt: '$krylo-run do the task',
    session_id: sessionId,
    turn_id: 'turn-1',
    cwd,
    model: 'gpt-5.1-codex',
    permission_mode: 'default',
    transcript_path: null,
  };
}

function submitPrompt(dataDir, projectDir, sessionId, env = {}) {
  return runHookCodexOnly('security/user-prompt-submit-codex.mjs', promptPayload(projectDir, sessionId), dataDir, {
    env: { KRYLO_CODEX_COMPAT_TEST_MODE: '1', KRYLO_CODEX_CLI_PATH: FAKE_CLI, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0', ...env },
  });
}

function additionalContext(res) {
  return res.json?.hookSpecificOutput?.additionalContext ?? '';
}

function runDirs(dataDir) {
  return fs.readdirSync(path.join(dataDir, 'runs')).filter((d) => d.startsWith('run-'));
}

for (const target of ['state', 'pointer']) {
  test(`user-prompt-submit-codex: re-invoking $krylo-run while the existing run's ${target} is unreadable keeps the live run`, () => {
    const dataDir = mkTempDataDir('krylo-unreadable-ups-');
    const projectDir = mkTempDataDir('krylo-unreadable-ups-project-');
    try {
      const first = submitPrompt(dataDir, projectDir, 'codex-session-A');
      const runId = /run-[0-9a-f]+/.exec(additionalContext(first))?.[0];
      assert.ok(runId, `fixture bootstrap failed: ${first.stdout}`);
      const statePath = path.join(dataDir, 'runs', runId, 'state.json');
      const pointerPath = pointerPathFor(dataDir, 'codex', 'codex-session-A');
      const stateBefore = fs.readFileSync(statePath, 'utf8');

      const second = submitPrompt(dataDir, projectDir, 'codex-session-A', faultEnv(dataDir, target === 'state' ? statePath : pointerPath, 'EBUSY'));
      assert.equal(second.status, 0);
      assert.ok(faultsFired(dataDir) > 0, 'the injected fault must actually have fired');
      assert.match(additionalContext(second), /could not read this session's existing run state/);
      assert.match(additionalContext(second), /No new run was started/);

      assert.deepEqual(runDirs(dataDir), [runId], 'no second run may be created');
      assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).runId, runId, 'the pointer must still name the live run');
      assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore, 'the live run state must be untouched');
    } finally {
      cleanup(dataDir);
      cleanup(projectDir);
    }
  });
}
