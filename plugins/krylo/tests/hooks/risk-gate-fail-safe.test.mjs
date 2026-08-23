// Regression coverage for a fail-open bug found during independent review of
// the multi-host Foundation refactor (docs/process/
// MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md, Tasks 6-7): a Hook payload
// whose session identity could not be established, or that could not be
// parsed at all, caused risk-gate.mjs to silently allow the tool call --
// even while a KRYLO run was actively enforcing approvals for the project --
// instead of following ADR-0020's documented fallback (resolve the single
// most-recently-updated pointer for the project) or the module's own
// documented fail-safe contract ("fail SAFE while a run is active").
//
// Fixed in scripts/lib/hook-utils.mjs (resolveActiveRun no longer hard-
// requires hostSessionId), scripts/host/claude/hook-transport.mjs
// (normalizeClaudeHookPayload returns a degraded session-less identity
// instead of failing outright; claudeCwdFallbackIdentity for unparseable
// stdin), and scripts/security/risk-gate.mjs (checks for an active run via
// the cwd fallback before giving up on unreadable input).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { mkTempDataDir, createActiveRun, cleanup, SCRIPTS_ROOT } from './helpers.mjs';

const RISK_GATE = path.join(SCRIPTS_ROOT, 'security', 'risk-gate.mjs');

function runRiskGateRaw(input, dataDir, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, ...extraEnv };
  delete env.CLAUDE_SESSION_ID;
  const res = spawnSync(process.execPath, [RISK_GATE], { encoding: 'utf8', input, env });
  let json = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, json };
}

test('a git push --force with a missing session_id is still denied while exactly one run is active (ADR-0020 fallback)', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-push-');
  try {
    createActiveRun(dataDir); // registers session 'hook-session' as the sole active run
    const res = runRiskGateRaw(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
      cwd: dataDir,
      // session_id deliberately omitted, CLAUDE_SESSION_ID deliberately unset
    }), dataDir);
    assert.equal(res.status, 0);
    assert.ok(res.json, 'expected a PreToolUse JSON decision, not a silent allow');
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('a write to .env with a missing session_id is still denied while exactly one run is active', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-env-');
  try {
    createActiveRun(dataDir);
    const res = runRiskGateRaw(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.env', content: 'SECRET=1' },
      cwd: dataDir,
    }), dataDir);
    assert.equal(res.status, 0);
    assert.ok(res.json);
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('a missing session_id with genuinely no active run still allows silently (unchanged negative control)', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-norun-');
  try {
    // No createActiveRun() call: no run exists for this project at all.
    const res = runRiskGateRaw(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
      cwd: dataDir,
    }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json, null, 'no active run means silent allow, exactly like a session_id-bearing payload would get');
  } finally {
    cleanup(dataDir);
  }
});

test('unparseable stdin still checks for an active run via cwd fallback and asks instead of silently allowing', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-garbage-');
  try {
    createActiveRun(dataDir, { projectDir: dataDir });
    // cwd for the spawned process IS dataDir's project (matches createActiveRun's projectDir),
    // so claudeCwdFallbackIdentity()'s process.cwd() fallback must resolve it.
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir };
    delete env.CLAUDE_SESSION_ID;
    const res = spawnSync(process.execPath, [RISK_GATE], { encoding: 'utf8', input: 'not valid json {{{', cwd: dataDir, env });
    assert.equal(res.status, 0);
    let json = null;
    try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
    assert.ok(json, 'expected an "ask" decision, not a silent allow, since a run is active');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    cleanup(dataDir);
  }
});

test('unparseable stdin with genuinely no active run still allows silently (unchanged negative control)', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-garbage-norun-');
  try {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir };
    delete env.CLAUDE_SESSION_ID;
    const res = spawnSync(process.execPath, [RISK_GATE], { encoding: 'utf8', input: 'not valid json {{{', cwd: dataDir, env });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('a missing session_id never binds to a different host\'s pointer (host is still mandatory)', () => {
  const dataDir = mkTempDataDir('krylo-failsafe-hostcheck-');
  try {
    createActiveRun(dataDir);
    // Sanity: this run only exists under the 'claude' host directory; there is
    // no code path in the Claude risk-gate that could resolve a 'codex'
    // pointer, since normalizeClaudeHookPayload always sets host: 'claude'.
    // This test documents that invariant rather than exercising a second
    // host (not implemented yet).
    const res = runRiskGateRaw(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
      cwd: dataDir,
    }), dataDir);
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup(dataDir);
  }
});
