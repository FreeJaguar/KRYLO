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
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { mkTempDataDir, createActiveRun, runCli, patchState, cleanup, SCRIPTS_ROOT } from './helpers.mjs';

const RISK_GATE = path.join(SCRIPTS_ROOT, 'security', 'risk-gate.mjs');

function runRiskGateRaw(input, dataDir, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, ...extraEnv };
  delete env.CLAUDE_SESSION_ID;
  const res = spawnSync(process.execPath, [RISK_GATE], { encoding: 'utf8', input, env });
  let json = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, json };
}

test('a git push --force with a missing session_id is still gated while exactly one run is active (ADR-0020 fallback)', () => {
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
    // A well-formed require-approval classification (git-force), resolved via
    // the ADR-0020 fallback -- not a payload-read failure -- so this now
    // routes through the native ask prompt, same as a fully-identified
    // session would get.
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'ask');
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

test('unparseable stdin still checks for an active run via cwd fallback and denies instead of silently allowing', () => {
  // This path can never even classify the action (the payload could not be
  // parsed at all), so it is not a `require-approval` decision with a
  // legitimate human-review outcome the way a well-formed Bash git-push
  // attempt is (docs/adr/0025-native-permission-approval.md) -- it is
  // KRYLO's own inability to evaluate anything. `deny` remains the
  // unambiguous, fail-safe response here regardless of tool or Claude Code
  // version.
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
    assert.ok(json, 'expected a "deny" decision, not a silent allow, since a run is active');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
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
    // Same reasoning as above: a normal require-approval classification via
    // the ADR-0020 fallback now routes through the native ask prompt.
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    cleanup(dataDir);
  }
});

test('a valid session_id is never discarded by an unrelated payload validation failure (must not spend a different run\'s approval)', () => {
  // Independent confirmation review of the fix above found a follow-on gap:
  // the original catch-and-degrade fallback caught ANY bootstrap failure,
  // not only "session id unavailable" -- so an oversized permission_mode/
  // prompt_id could silently discard a perfectly good session_id and fall
  // back to "most recently updated pointer", which, with two concurrent
  // runs in one project, could resolve to a DIFFERENT run and spend ITS
  // approval instead of correctly evaluating (and denying) against the
  // session that was actually named.
  const dataDir = mkTempDataDir('krylo-failsafe-wrongrun-');
  try {
    createActiveRun(dataDir); // session 'hook-session'
    const initB = runCli('runtime/init-run.mjs', [
      '--goal', 'second concurrent session',
      '--session', 'hook-session-b',
      '--project-dir', dataDir,
      '--lane', 'PATCH',
      '--risk', 'low',
    ], dataDir);
    assert.equal(initB.status, 0);
    const runIdB = initB.json.runId;
    const statePathB = path.join(dataDir, 'runs', runIdB, 'state.json');

    // Run B (the more recently created/updated run) holds an approved,
    // unconsumed git-force approval. Run A (the session actually named in
    // the payload below) holds none.
    patchState(statePathB, (state) => {
      state.riskApprovals.push({
        id: 'ra-1',
        actionClass: 'git-force',
        status: 'approved',
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        projectRootHash: state.project.rootHash,
        runId: state.runId,
        environment: null,
        expiresAt: null,
        consumedAt: null,
        fingerprint: null,
        target: null,
        summary: 'pre-approved force push',
      });
    });

    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir };
    delete env.CLAUDE_SESSION_ID;
    const res2 = spawnSync(process.execPath, [RISK_GATE], {
      encoding: 'utf8',
      env,
      cwd: dataDir, // claudeCwdFallbackIdentity() falls back to the Hook process's own cwd
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' },
        cwd: dataDir,
        session_id: 'hook-session', // correctly names run A, which has NO approval
        permission_mode: 'x'.repeat(300), // exceeds host-context's 256-char limit
      }),
    });
    assert.equal(res2.status, 0);
    let json = null;
    try { json = JSON.parse(res2.stdout.trim()); } catch { json = null; }
    assert.ok(json, 'must not silently allow');
    assert.notEqual(
      json.hookSpecificOutput.permissionDecision,
      'allow',
      'must not fall back to a different run and spend its approval just because an unrelated field failed validation',
    );

    const stateB = JSON.parse(fs.readFileSync(statePathB, 'utf8'));
    assert.equal(stateB.riskApprovals[0].status, 'approved', 'run B\'s approval must remain unspent');
  } finally {
    cleanup(dataDir);
  }
});
