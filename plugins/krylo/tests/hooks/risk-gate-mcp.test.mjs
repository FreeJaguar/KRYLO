import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, patchState, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate.mjs';

function mcpPayload(cwd, toolName, toolInput = {}) {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

test('risk-gate: unknown MCP server is denied for both a write- and a read-shaped operation', () => {
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

test('risk-gate: MCP writes across the required categories are denied pending approval', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const denied = [
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
    for (const toolName of denied) {
      const res = runHook(GATE, mcpPayload(dataDir, toolName, { x: 1 }), dataDir);
      assert.equal(decision(res), 'deny', `expected deny for ${toolName}`);
      assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(toolName) || true);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: an approved class-level approval allows exactly one MCP write and then requires a fresh approval', () => {
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
        summary: 'merge PR #42 after review',
      });
    });

    const first = runHook(GATE, mcpPayload(dataDir, 'mcp__github__merge_pull_request', { pr: 42 }), dataDir);
    assert.equal(decision(first), 'allow');

    const second = runHook(GATE, mcpPayload(dataDir, 'mcp__github__merge_pull_request', { pr: 43 }), dataDir);
    assert.equal(decision(second), 'deny', 'the single-use approval must not authorize a second merge');
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
