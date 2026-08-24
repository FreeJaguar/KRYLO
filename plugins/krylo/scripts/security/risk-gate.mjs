#!/usr/bin/env node
// KRYLO risk gate (PreToolUse, matcher: Bash|PowerShell|Write|Edit|NotebookEdit|mcp__.*).
//
// This is the Claude-specific adapter: it parses Claude's PreToolUse stdin
// payload, normalizes it into a host-neutral identity, delegates the actual
// classification to the shared, host-neutral scripts/security/risk-policy.mjs,
// and translates the resulting decision into Claude's PreToolUse Hook output
// shape. It holds no policy logic of its own.
//
// Fail mode: fail SAFE (deny) while a run is active; silent pass-through
// when no KRYLO run is active for this project.
//
// Human approval boundary (docs/adr/0025-native-permission-approval.md):
// a `require-approval` classification is translated into Claude Code's own
// native `permissionDecision: "ask"` -- putting the actual authorization
// decision in the host's own permission UI, not in any KRYLO-local state a
// prompt-injected model could forge or manipulate -- replacing the prior
// KRYLO-APPROVE chat-phrase mechanism (ADR-0024, superseded).
//
// `ask` is used ONLY for the Bash tool. Current official Claude Code
// documentation (this project's own verified CHANGELOG entry for v2.1.211,
// the version ADR-0022 raises the compatibility floor to) states precisely:
// "Fixed auto mode overriding a PreToolUse hook's `ask` decision for
// unsandboxed Bash -- a hook `ask` now floors the decision at a prompt."
// That confirmation is scoped explicitly to Bash; no equivalent fix has been
// found for PowerShell or for any MCP tool's permission dialog in the same
// CHANGELOG (checked in full through the current released version). Per the
// task's own instruction not to invent runtime contracts, `ask` is not used
// for those tool types absent that confirmation: they keep the deterministic
// `deny` fail-safe (the same choice this module made for every
// require-approval class before this checkpoint), which is strictly more
// conservative than an unconfirmed `ask`, never a weaker one. This is a
// known, deliberate ergonomic gap -- documented in ADR-0025 and ADR-0026 --
// to be revisited once official documentation confirms the same auto-mode
// guarantee for PowerShell/MCP.
//
// Every failure path (unreadable payload, classification exception) also
// still uses deterministic `deny`: those are not `require-approval`
// decisions with a legitimate human-review outcome, they are KRYLO's own
// inability to classify the action at all, and `deny` remains the
// unambiguous, fail-safe response to that.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeClaudeHookPayload,
  emitClaudePreToolDecision,
  allowClaudeSilently,
  claudeCwdFallbackIdentity,
} from '../host/claude/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';

/**
 * The stdin payload could not be read or normalized at all, so the tool
 * call itself cannot be classified. Per this module's fail-safe contract,
 * that is not license to silently allow: still check (via the Hook
 * process's own cwd, since there is no parsed payload to read `cwd` from)
 * whether a KRYLO run is active, and deny rather than pass through silently
 * if so.
 */
function failSafeOnUnreadablePayload() {
  const identity = claudeCwdFallbackIdentity();
  if (identity) {
    const run = resolveActiveRun({ projectRoot: identity.projectRoot, host: identity.host, hostSessionId: identity.hostSessionId });
    if (run.active) emitClaudePreToolDecision('deny', 'KRYLO risk gate could not read this action and denied it as a fail-safe. Re-run with a well-formed request.');
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
      // Authorization now belongs entirely to Claude Code's own native
      // permission UI (Bash only -- see the header comment for why): no
      // KRYLO-local approval record is looked up or consumed here, so a
      // persisted riskApprovals entry (however it got there) can never by
      // itself let this action through, for any tool.
      //
      // Structured as if/else (not two sequential ifs) so the Bash path
      // never reaches the deny branch even in principle -- it must not
      // depend on emitClaudePreToolDecision()'s process.exit(0) as the only
      // thing preventing a double decision.
      if (toolName === 'Bash') {
        recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'ask' });
        emitClaudePreToolDecision(
          'ask',
          `${decision.reason} Claude Code will ask you to allow or deny this specific action.`,
        );
      } else {
        recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'denied' });
        emitClaudePreToolDecision(
          'deny',
          `${decision.reason} This action class does not yet use the native approval prompt for this tool. If a human should review and unblock it, record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
        );
      }
    }

    allowClaudeSilently();
  } catch {
    // Fail safe while a run is active: deny, don't silently pass through.
    emitClaudePreToolDecision('deny', 'KRYLO risk gate could not evaluate this action and denied it as a fail-safe.');
  }
}

main().catch(() => {
  // Outer failure (before active-run resolution succeeded): pass through.
  allowClaudeSilently();
});
