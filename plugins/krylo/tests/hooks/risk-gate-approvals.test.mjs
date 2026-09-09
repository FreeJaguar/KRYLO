// Regression coverage for the native permission-approval boundary
// (docs/adr/0025-native-permission-approval.md, superseding ADR-0024): a
// KRYLO-local riskApprovals record must never independently authorize
// execution. It may still exist in state for audit/history purposes, but
// the risk gate must always route a require-approval classification through
// Claude Code's own native `ask` permission prompt -- regardless of any
// local record's shape, status, scope, or age.
//
// This file previously exercised risk-policy.mjs's now-removed
// consumeMatchingApproval()/isApprovalUsable() consumption path (exact
// target match, expiry, single-use consumption, project/run/environment
// binding). That whole mechanism was deleted: a local "approved" record can
// no longer, by itself, flip a decision to "allow". These tests now prove
// the opposite invariant for the same scenarios.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { mkTempDataDir, createActiveRun, runHook, patchState, readState, cleanup, SCRIPTS_ROOT } from './helpers.mjs';
import { fingerprintText } from '../../scripts/lib/action-fingerprint.mjs';

const GATE = 'security/risk-gate.mjs';

function bashPayload(cwd, command) {
  // permission_mode: 'auto' is the real, empirically-observed default for a
  // non-interactive session with no --permission-mode flag; ASK_ELIGIBLE_
  // PERMISSION_MODES in risk-gate.mjs is an allowlist, so a test asserting
  // 'ask' must supply an eligible mode explicitly.
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, permission_mode: 'auto' };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

function baseApproval(state, overrides = {}) {
  return {
    id: 'ra-1',
    actionClass: 'git-push',
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
    summary: 'push feature branch',
    ...overrides,
  };
}

const SCENARIOS = [
  ['exact target-bound match', (state, command) => baseApproval(state, { fingerprint: fingerprintText(command), target: command })],
  ['different target, same class', (state) => baseApproval(state, { fingerprint: fingerprintText('git push origin main'), target: 'git push origin main' })],
  ['not yet expired', (state) => baseApproval(state, { expiresAt: new Date(Date.now() + 60_000).toISOString() })],
  ['already consumed', (state) => baseApproval(state, { status: 'consumed', consumedAt: new Date().toISOString() })],
  ['same project/run/no environment', (state) => baseApproval(state)],
];

for (const [label, buildApproval] of SCENARIOS) {
  test(`ask (not local approval state) decides every case: ${label}`, () => {
    const dataDir = mkTempDataDir();
    try {
      const { statePath } = createActiveRun(dataDir);
      const command = 'git push origin main';
      patchState(statePath, (state) => {
        state.riskApprovals.push(buildApproval(state, command));
      });
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(decision(res), 'ask', `expected ask regardless of local approval state (${label})`);
    } finally {
      cleanup(dataDir);
    }
  });
}

test('a local approval record is never mutated by the risk gate any more (no more consumption)', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state));
    });
    const before = readState(statePath).riskApprovals[0];

    runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);

    const after = readState(statePath).riskApprovals[0];
    assert.deepEqual(after, before, 'the risk gate must not read-modify-write riskApprovals at all any more');
  } finally {
    cleanup(dataDir);
  }
});

test('metadata safety is unaffected: a secret in the attempted command is never persisted anywhere by the ask path', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const secret = 'ghp_1234567890abcdefghijklmno';
    const res = runHook(GATE, bashPayload(dataDir, `git push origin main # token=${secret}`), dataDir);
    assert.equal(decision(res), 'ask');
    assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(secret));
  } finally {
    cleanup(dataDir);
  }
});

test('concurrent attempts: many racing require-approval attempts each independently get ask (no shared single-use state to race over)', async () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);

    const gatePath = path.join(SCRIPTS_ROOT, GATE);
    const runOnce = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [gatePath], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_SESSION_ID: 'hook-session' },
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(out.trim() === '' ? null : JSON.parse(out.trim()));
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.write(JSON.stringify(bashPayload(dataDir, 'git push origin main')));
      child.stdin.end();
    });

    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    const decisions = [a, b].map((r) => r?.hookSpecificOutput?.permissionDecision ?? null);
    assert.deepEqual(decisions, ['ask', 'ask'], `expected both racing attempts to independently get ask, got ${JSON.stringify(decisions)}`);
  } finally {
    cleanup(dataDir);
  }
});
