import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SCRIPTS_ROOT } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.resolve(__dirname, '..', '..', 'codex', 'project-hooks', 'codex-project-hook-launcher.mjs');

function mkStandaloneRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-root-'));
}

function copyRealRuntimeInto(root) {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  for (const dir of ['scripts', 'references', 'schemas', 'policies']) {
    fs.cpSync(path.join(pluginRoot, dir), path.join(root, dir), { recursive: true });
  }
}

function run(event, stdinPayload, standaloneRoot, extraEnv = {}) {
  const res = spawnSync(process.execPath, [LAUNCHER, event], {
    input: typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: { ...process.env, KRYLO_STANDALONE_ROOT: standaloneRoot, ...extraEnv },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* noop */ }
  return { status: res.status, stdout: res.stdout, json };
}

test('launcher: an unrecognized event argv denies as a fail-safe (PreToolUse-shaped output)', () => {
  const root = mkStandaloneRoot();
  try {
    const res = run('not-a-real-event', {}, root);
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: pre-tool-use denies as a fail-safe when the standalone runtime is not installed at all', () => {
  const root = mkStandaloneRoot(); // empty -- no scripts/ subtree copied
  try {
    const res = run('pre-tool-use', { session_id: 's1', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'echo hi' }, permission_mode: 'default' }, root);
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(res.json?.hookSpecificOutput?.permissionDecisionReason ?? '', /not installed|removed/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: user-prompt-submit and post-tool-use no-op silently (exit 0, no stdout) when the standalone runtime is not installed', () => {
  const root = mkStandaloneRoot();
  try {
    for (const event of ['user-prompt-submit', 'post-tool-use']) {
      const res = run(event, { session_id: 's1', cwd: process.cwd(), prompt: 'hello' }, root);
      assert.equal(res.status, 0, `${event} must exit 0`);
      assert.equal(res.stdout, '', `${event} must produce no stdout when runtime is missing`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: pre-tool-use denies as a fail-safe if the real script cannot even be launched (regression found by fresh independent Reviewer + Security Reviewer: an unhandled spawn failure previously exited silently with no deny, and Codex confirms a PreToolUse hook that fails to emit valid output fails OPEN)', () => {
  const root = mkStandaloneRoot();
  try {
    copyRealRuntimeInto(root);
    // Replace the real script with a directory of the same name: fs.existsSync()
    // still reports true, but spawnSync launching `node <that path>` fails.
    const scriptPath = path.join(root, 'scripts', 'security', 'risk-gate-codex.mjs');
    fs.rmSync(scriptPath, { force: true });
    fs.mkdirSync(scriptPath, { recursive: true });
    const res = run('pre-tool-use', { session_id: 's1', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'echo hi' }, permission_mode: 'default' }, root);
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', 'a spawn failure must still deny, never exit silently');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: pre-tool-use delegates to the real risk-gate-codex.mjs once the standalone runtime is present, with no active run (allow silently)', () => {
  const root = mkStandaloneRoot();
  try {
    copyRealRuntimeInto(root);
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
    const res = run('pre-tool-use', { session_id: 'no-such-session', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'echo hi' }, permission_mode: 'default' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'no active run for this session must allow silently, exactly like the real risk-gate-codex.mjs');
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: user-prompt-submit delegates to the real user-prompt-submit-codex.mjs once the standalone runtime is present (ordinary prompt stays inert)', () => {
  const root = mkStandaloneRoot();
  try {
    copyRealRuntimeInto(root);
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
    const res = run('user-prompt-submit', { session_id: 's-ordinary', cwd: process.cwd(), prompt: 'please explain this repository' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ordinary, non-$krylo-run prompt must stay completely inert through the launcher, exactly as the real hook does directly');
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: PreToolUse hard-deny (sensitive path) is enforced end to end through the launcher, exactly as invoking risk-gate-codex.mjs directly', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);

    const sessionId = 'launcher-hard-deny-session';
    const init = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs'), '--goal', 'launcher fixture run', '--session', sessionId, '--project-dir', process.cwd(), '--lane', 'PATCH', '--risk', 'low'], {
      encoding: 'utf8',
      env: { ...process.env, KRYLO_DATA_ROOT: dataRoot, KRYLO_HOST: 'codex' },
    });
    assert.equal(init.status, 0, init.stderr);

    const res = run('pre-tool-use', { session_id: sessionId, cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'cat .env' }, permission_mode: 'default' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', 'a real active run\'s sensitive-path hard-deny must still fire through the launcher');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: a genuine $krylo-run prompt creates a real, active Codex run through the launcher', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);
    const sessionId = 'launcher-activation-session';
    const res = run('user-prompt-submit', { session_id: sessionId, cwd: process.cwd(), prompt: '$krylo-run add a widget' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.match(res.json?.hookSpecificOutput?.additionalContext ?? '', /now active/i);

    // Prove the run is genuinely active for a SUBSEQUENT PreToolUse call
    // routed through the SAME launcher, not just that the bootstrap hook
    // itself printed something plausible.
    const preToolUse = run('pre-tool-use', { session_id: sessionId, cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'cat .env' }, permission_mode: 'default' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(preToolUse.json?.hookSpecificOutput?.permissionDecision, 'deny', 'the run bootstrapped via $krylo-run must be genuinely active for later PreToolUse calls');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: require-approval (git push) fails closed through the launcher under every permission_mode, never "ask"', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);
    const sessionId = 'launcher-require-approval-session';
    const init = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs'), '--goal', 'launcher fixture run', '--session', sessionId, '--project-dir', process.cwd(), '--lane', 'PATCH', '--risk', 'low'], {
      encoding: 'utf8',
      env: { ...process.env, KRYLO_DATA_ROOT: dataRoot, KRYLO_HOST: 'codex' },
    });
    assert.equal(init.status, 0, init.stderr);

    for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions', 'unknown-future-mode']) {
      const res = run('pre-tool-use', { session_id: sessionId, cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'git push origin main' }, permission_mode: permissionMode }, root, { KRYLO_DATA_ROOT: dataRoot });
      assert.equal(res.status, 0);
      assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', `permission_mode=${permissionMode} must deny through the launcher`);
      assert.notEqual(res.json?.hookSpecificOutput?.permissionDecision, 'ask', 'permissionDecision:"ask" must never be emitted, through the launcher or directly');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: stop event with a missing standalone runtime allows silently (Stop\'s safe fail-direction is letting the session end, never blocking it -- opposite of pre-tool-use)', () => {
  const root = mkStandaloneRoot();
  try {
    const res = run('stop', { session_id: 's1', cwd: process.cwd(), turn_id: 't1', model: 'gpt-test', permission_mode: 'default', stop_hook_active: false, last_assistant_message: null, transcript_path: null }, root);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'a missing runtime must never trap the stop hook into blocking termination');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: session-start and session-end with a missing standalone runtime no-op silently (non-security-boundary events)', () => {
  const root = mkStandaloneRoot();
  try {
    for (const event of ['session-start', 'session-end']) {
      const res = run(event, { session_id: 's1', cwd: process.cwd() }, root);
      assert.equal(res.status, 0, `${event} must exit 0`);
      assert.equal(res.stdout, '', `${event} must produce no stdout when runtime is missing`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher: stop delegates to the real stop-gate-codex.mjs once the standalone runtime is present, blocking a run with unmet criteria', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);
    const sessionId = 'launcher-stop-session';
    const init = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs'), '--goal', 'launcher fixture run', '--session', sessionId, '--project-dir', process.cwd(), '--lane', 'PATCH', '--risk', 'low'], {
      encoding: 'utf8',
      env: { ...process.env, KRYLO_DATA_ROOT: dataRoot, KRYLO_HOST: 'codex' },
    });
    assert.equal(init.status, 0, init.stderr);
    const addCriterion = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'runtime', 'update-state.mjs'), '--add-criterion', 'never proven'], {
      encoding: 'utf8',
      env: { ...process.env, KRYLO_DATA_ROOT: dataRoot, KRYLO_HOST: 'codex' },
      cwd: process.cwd(),
    });
    assert.equal(addCriterion.status, 0, addCriterion.stderr);

    const res = run('stop', { session_id: sessionId, cwd: process.cwd(), turn_id: 't1', model: 'gpt-test', permission_mode: 'default', stop_hook_active: false, last_assistant_message: null, transcript_path: null }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, 'block', 'unmet criteria on a real active run must still block through the launcher');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: session-start delegates to the real session-start-codex.mjs once the standalone runtime is present (ordinary session stays inert)', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);
    const res = run('session-start', { session_id: 's-ordinary', cwd: process.cwd(), model: 'gpt-test', permission_mode: 'default', source: 'startup', transcript_path: null }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ordinary session with no active run must stay inert through the launcher');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: session-end delegates to the real session-end-codex.mjs once the standalone runtime is present (no active run -> no-op)', () => {
  const root = mkStandaloneRoot();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
  try {
    copyRealRuntimeInto(root);
    const res = run('session-end', { session_id: 's-ordinary', cwd: process.cwd(), reason: 'other', transcript_path: null }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launcher: a $krylo-runner prefix collision stays inert through the launcher, exactly as invoking the real hook directly', () => {
  const root = mkStandaloneRoot();
  try {
    copyRealRuntimeInto(root);
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-standalone-data-'));
    const res = run('user-prompt-submit', { session_id: 's-collision', cwd: process.cwd(), prompt: '$krylo-runner do something else entirely' }, root, { KRYLO_DATA_ROOT: dataRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'a prefix-collision prompt must not be treated as a real $krylo-run invocation');
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
