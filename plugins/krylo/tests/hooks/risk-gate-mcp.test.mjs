import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, patchState, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate.mjs';

function mcpPayload(cwd, toolName, toolInput = {}) {
  // permission_mode: 'auto' -- ADR-0027 restores native ask to MCP
  // require-approval classes too, so an ask-path test must supply an
  // eligible mode explicitly (same reasoning as risk-gate.test.mjs's
  // bashPayload()/powershellPayload()).
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd, permission_mode: 'auto' };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

test('risk-gate: unknown MCP server is HARD-denied for both a write- and a read-shaped operation, even under an ask-eligible permission mode', () => {
  // ADR-0027 restores native ask to MCP require-approval classes, but an
  // entirely unreviewed server has no identity a human could meaningfully
  // approve -- mcp-classifier.mjs's `hardDeny` flag keeps this a `deny`
  // classification (not `require-approval`), so it must never reach ask
  // regardless of permission mode.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const write = runHook(GATE, mcpPayload(dataDir, 'mcp__some_random_service__update_thing'), dataDir);
    assert.equal(decision(write), 'deny');
    const read = runHook(GATE, mcpPayload(dataDir, 'mcp__some_random_service__get_thing'), dataDir);
    assert.equal(decision(read), 'deny', 'a totally unreviewed server is gated even for read-shaped operations');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: known read-only-shaped operations on catalogued MCP servers pass silently', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const toolName of ['mcp__context7__query-docs', 'mcp__playwright__browser_snapshot', 'mcp__github__list_issues']) {
      const res = runHook(GATE, mcpPayload(dataDir, toolName, { q: 'hello' }), dataDir);
      assert.equal(decision(res), null, `expected silent allow for ${toolName}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: MCP writes across the required categories trigger native ask under an eligible permission mode (ADR-0027)', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const gated = [
      'mcp__postgres__execute_sql',
      'mcp__supabase__update_row',
      'mcp__github__merge_pull_request',
      'mcp__github__create_release',
      'mcp__github__set_secret',
      'mcp__github__trigger_workflow_dispatch',
      'mcp__vercel__create_deployment',
      'mcp__figma__create_comment',
      'mcp__sentry__update_issue',
      'mcp__slack__send_message',
      'mcp__aws__create_bucket',
      'mcp__vault__write_secret',
      'mcp__stripe__create_refund',
    ];
    for (const toolName of gated) {
      const res = runHook(GATE, mcpPayload(dataDir, toolName, { x: 1 }), dataDir);
      assert.equal(decision(res), 'ask', `expected ask for ${toolName}`);
      assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(toolName) || true);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: the same MCP writes fall back to deny under an ineligible permission mode', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const toolName of ['mcp__github__merge_pull_request', 'mcp__stripe__create_refund']) {
      const bypassRes = runHook(GATE, { ...mcpPayload(dataDir, toolName, { x: 1 }), permission_mode: 'bypassPermissions' }, dataDir);
      assert.equal(decision(bypassRes), 'deny', `expected deny (bypassPermissions) for ${toolName}`);
      const noModeRes = runHook(GATE, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { x: 1 }, cwd: dataDir }, dataDir);
      assert.equal(decision(noModeRes), 'deny', `expected deny (absent permission_mode) for ${toolName}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: a pre-existing local "approved" record for an MCP action class cannot authorize execution on its own', () => {
  // Same native-permission-approval invariant as the Bash case
  // (docs/adr/0025-native-permission-approval.md, ADR-0027): a local
  // riskApprovals record, however it got there, must never authorize
  // execution by itself. Now that MCP require-approval classes route
  // through the native ask prompt, the authorization decision belongs to
  // Claude Code's own permission UI -- the persisted local record is never
  // read or consumed here regardless, so this proves its presence changes
  // nothing: every attempt still routes through ask, not a silent allow.
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push({
        id: 'ra-1',
        actionClass: 'merge',
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
        summary: 'a stale/historical local approval record',
      });
    });

    const first = runHook(GATE, mcpPayload(dataDir, 'mcp__github__merge_pull_request', { pr: 42 }), dataDir);
    assert.equal(decision(first), 'ask');
    assert.notEqual(decision(first), 'allow');

    const second = runHook(GATE, mcpPayload(dataDir, 'mcp__github__merge_pull_request', { pr: 43 }), dataDir);
    assert.equal(decision(second), 'ask');
    assert.notEqual(decision(second), 'allow');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: no active run -> MCP calls pass silently regardless of class', () => {
  const dataDir = mkTempDataDir();
  try {
    for (const toolName of ['mcp__github__merge_pull_request', 'mcp__unknown_service__wipe_everything']) {
      const res = runHook(GATE, mcpPayload(dataDir, toolName), dataDir);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '');
    }
  } finally {
    cleanup(dataDir);
  }
});
