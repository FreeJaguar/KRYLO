// Regression coverage for SECURITY BLOCKER 1 (security-hardening
// checkpoint, prompt.md): the model must not have authority to turn its own
// pending risk-approval request into an approved human authorization.
//
// Found: runtime/update-state.mjs's model-accessible `--resolve-approval
// <id>=approved` CLI path had no gate at all -- any Bash call (the model's
// own) could flip a pending approval straight to approved, then immediately
// retry the gated action and have the risk gate consume it. Scoped/
// single-use/atomic approval consumption (ADR-0019) is meaningless if the
// requester can also be the approver.
//
// Fixed: `--resolve-approval <id>=approved` is now unconditionally refused
// from the CLI (denied remains allowed -- that direction is harmless). The
// ONLY path that can grant an approval is
// scripts/security/human-approval-gate.mjs, a UserPromptSubmit hook that
// reads the raw, unprocessed text of a genuine top-level prompt submission
// -- content the model cannot originate within its own turn -- for an
// explicit "KRYLO-APPROVE <id>" / "KRYLO-DENY <id>" phrase. Subagent-
// attributed prompts (agent_id/agent_type present) are explicitly excluded.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  mkTempDataDir,
  runCli,
  runHook,
  createActiveRun,
  patchState,
  readState,
  cleanup,
  SCRIPTS_ROOT,
} from './helpers.mjs';

const GATE = 'security/human-approval-gate.mjs';
const RISK_GATE = 'security/risk-gate.mjs';

function bashPayload(cwd, command) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

test('the vulnerable flow is closed end to end: CLI self-approve fails, human phrase approves, only then does risk-gate allow the retry', () => {
  const dataDir = mkTempDataDir('krylo-humangate-e2e-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);

    const request = runCli('runtime/update-state.mjs', [
      '--run', runId, '--request-approval', 'git-force', '--summary', 'force push after rebase',
    ], dataDir);
    assert.equal(request.status, 0);
    assert.equal(request.json.ok, true);

    // Step 1: the model tries to approve its own request via the CLI. Must fail.
    const selfApprove = runCli('runtime/update-state.mjs', ['--run', runId, '--resolve-approval', 'ra-1=approved'], dataDir);
    assert.notEqual(selfApprove.status, 0);
    assert.equal(selfApprove.json.ok, false);
    assert.equal(selfApprove.json.error, 'model-approval-forbidden');
    assert.equal(readState(statePath).riskApprovals[0].status, 'pending');

    // Step 2: the risk gate must still deny/require-approval for the gated
    // action while nothing has actually been approved.
    const stillGated = runHook(RISK_GATE, bashPayload(dataDir, 'git push --force origin main'), dataDir);
    assert.equal(decision(stillGated), 'deny');

    // Step 3: a genuine top-level UserPromptSubmit payload containing the
    // human confirmation phrase -- no agent_id/agent_type -- grants it.
    const humanTurn = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'ok, KRYLO-APPROVE ra-1', cwd: dataDir }, dataDir);
    assert.equal(humanTurn.status, 0);
    assert.equal(humanTurn.stdout, '', 'the hook must never print anything visible to the model');

    const approved = readState(statePath).riskApprovals[0];
    assert.equal(approved.status, 'approved');
    assert.ok(approved.expiresAt, 'approval TTL must be set on grant, same as before');

    // Step 4: only now does the risk gate allow the retried action, and it
    // is consumed exactly once.
    const allowed = runHook(RISK_GATE, bashPayload(dataDir, 'git push --force origin main'), dataDir);
    assert.equal(decision(allowed), 'allow');
    assert.equal(readState(statePath).riskApprovals[0].status, 'consumed');
  } finally {
    cleanup(dataDir);
  }
});

test('a subagent-attributed prompt (agent_id present) cannot grant an approval', () => {
  const dataDir = mkTempDataDir('krylo-humangate-subagent-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', readState(statePath).runId, '--request-approval', 'git-force'], dataDir);

    const res = runHook(GATE, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'KRYLO-APPROVE ra-1',
      cwd: dataDir,
      agent_id: 'agent-1',
      agent_type: 'krylo:builder',
    }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(readState(statePath).riskApprovals[0].status, 'pending', 'a subagent task context must never grant approval');
  } finally {
    cleanup(dataDir);
  }
});

test('an ordinary human message without the confirmation phrase never changes approval state and produces no output', () => {
  const dataDir = mkTempDataDir('krylo-humangate-ordinary-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', readState(statePath).runId, '--request-approval', 'git-force'], dataDir);

    const res = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'continue with the task please', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(readState(statePath).riskApprovals[0].status, 'pending');
  } finally {
    cleanup(dataDir);
  }
});

test('KRYLO-DENY via the human-approval gate denies the request', () => {
  const dataDir = mkTempDataDir('krylo-humangate-deny-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', readState(statePath).runId, '--request-approval', 'git-force'], dataDir);

    const res = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-DENY ra-1, do not force push', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(readState(statePath).riskApprovals[0].status, 'denied');
  } finally {
    cleanup(dataDir);
  }
});

test('multiple confirmation phrases in one message resolve all of them', () => {
  const dataDir = mkTempDataDir('krylo-humangate-multi-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', runId, '--request-approval', 'git-force'], dataDir);
    runCli('runtime/update-state.mjs', ['--run', runId, '--request-approval', 'production-data-write'], dataDir);

    const res = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-APPROVE ra-1 and KRYLO-DENY ra-2', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    const approvals = readState(statePath).riskApprovals;
    assert.equal(approvals.find((a) => a.id === 'ra-1').status, 'approved');
    assert.equal(approvals.find((a) => a.id === 'ra-2').status, 'denied');
  } finally {
    cleanup(dataDir);
  }
});

test('a nonexistent approval id in the confirmation phrase is a safe no-op', () => {
  const dataDir = mkTempDataDir('krylo-humangate-noexist-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', readState(statePath).runId, '--request-approval', 'git-force'], dataDir);

    const res = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-APPROVE ra-999', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(readState(statePath).riskApprovals[0].status, 'pending');
  } finally {
    cleanup(dataDir);
  }
});

test('an already-resolved approval cannot be re-resolved by a later confirmation phrase (idempotent, single transition)', () => {
  const dataDir = mkTempDataDir('krylo-humangate-idempotent-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', runId, '--request-approval', 'git-force'], dataDir);
    runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-DENY ra-1', cwd: dataDir }, dataDir);
    assert.equal(readState(statePath).riskApprovals[0].status, 'denied');

    // A later message trying to approve the same, already-denied id must not flip it.
    runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-APPROVE ra-1', cwd: dataDir }, dataDir);
    assert.equal(readState(statePath).riskApprovals[0].status, 'denied', 'a resolved approval must never be re-resolved');
  } finally {
    cleanup(dataDir);
  }
});

test('the confirmation phrase is case-insensitive', () => {
  const dataDir = mkTempDataDir('krylo-humangate-case-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--run', readState(statePath).runId, '--request-approval', 'git-force'], dataDir);

    const res = runHook(GATE, { hook_event_name: 'UserPromptSubmit', prompt: 'krylo-approve RA-1', cwd: dataDir }, dataDir);
    assert.equal(res.status, 0);
    assert.equal(readState(statePath).riskApprovals[0].status, 'approved');
  } finally {
    cleanup(dataDir);
  }
});

test('a missing/malformed session_id with no active run resolvable is a safe no-op (never crashes, never guesses)', () => {
  const dataDir = mkTempDataDir('krylo-humangate-norun-');
  try {
    // No createActiveRun(): nothing is active for this project.
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir };
    delete env.CLAUDE_SESSION_ID;
    const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, GATE)], {
      encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'KRYLO-APPROVE ra-1', cwd: dataDir }),
      env,
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});
