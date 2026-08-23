#!/usr/bin/env node
// KRYLO risk gate (PreToolUse, matcher: Bash|Write|Edit|NotebookEdit|mcp__.*).
//
// This is the Claude-specific adapter: it parses Claude's PreToolUse stdin
// payload, normalizes it into a host-neutral identity, delegates the actual
// classification and approval consumption to the shared, host-neutral
// scripts/security/risk-policy.mjs, and translates the resulting decision
// into Claude's PreToolUse Hook output shape. It holds no policy logic of
// its own.
//
// Fail mode: fail SAFE (ask) while a run is active; silent pass-through when
// no KRYLO run is active for this project.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeClaudeHookPayload,
  emitClaudePreToolDecision,
  allowClaudeSilently,
  claudeCwdFallbackIdentity,
} from '../host/claude/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction, consumeMatchingApproval } from './risk-policy.mjs';

/**
 * The stdin payload could not be read or normalized at all, so the tool
 * call itself cannot be classified. Per this module's fail-safe contract,
 * that is not license to silently allow: still check (via the Hook
 * process's own cwd, since there is no parsed payload to read `cwd` from)
 * whether a KRYLO run is active, and ask a human rather than pass through
 * silently if so.
 */
function failSafeOnUnreadablePayload() {
  const identity = claudeCwdFallbackIdentity();
  if (identity) {
    const run = resolveActiveRun({ projectRoot: identity.projectRoot, host: identity.host, hostSessionId: identity.hostSessionId });
    if (run.active) emitClaudePreToolDecision('ask', 'KRYLO risk gate could not read this action; review it manually.');
  }
  allowClaudeSilently();
}

async function main() {
  const input = await readStdinJson();
  if (!input.ok) failSafeOnUnreadablePayload();
  const normalized = normalizeClaudeHookPayload(input.value);
  if (!normalized.ok) failSafeOnUnreadablePayload();
  const payload = normalized.payload;

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const state = run.state;

  try {
    const toolName = String(payload.tool_name ?? '');
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

    const decision = classifyRiskAction({ toolName, toolInput, cwd, dataRoot: normalized.identity.dataRoot });

    if (decision.action === 'pass') {
      recordEvent(state.runId, { event: 'risk-gate', category: decision.category, status: 'allowed' });
      allowClaudeSilently();
    }

    if (decision.action === 'deny') {
      recordEvent(state.runId, { event: 'risk-gate', category: decision.category, status: 'denied' });
      emitClaudePreToolDecision('deny', decision.reason);
    }

    if (decision.action === 'require-approval') {
      const consumed = consumeMatchingApproval({
        runId: state.runId,
        actionClass: decision.actionClass,
        toolName,
        toolInput,
        projectRootHash: state.project.rootHash,
        securityProfile: process.env.KRYLO_SECURITY_PROFILE ?? null,
      });
      if (consumed.consumed) {
        recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'approved-override' });
        emitClaudePreToolDecision('allow', `Action class ${decision.actionClass} was approved by the user (${consumed.approvalId}) and is now spent.`);
      }
      recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'denied' });
      emitClaudePreToolDecision(
        'deny',
        `${decision.reason} Record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
      );
    }

    allowClaudeSilently();
  } catch {
    // Fail safe while a run is active: require the user to look at it.
    emitClaudePreToolDecision('ask', 'KRYLO risk gate could not evaluate this action.');
  }
}

main().catch(() => {
  // Outer failure (before active-run resolution succeeded): pass through.
  allowClaudeSilently();
});
