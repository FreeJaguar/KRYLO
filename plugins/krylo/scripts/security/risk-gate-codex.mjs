#!/usr/bin/env node
// KRYLO Codex risk gate (PreToolUse). This is the Codex-specific adapter: it
// parses Codex's PreToolUse stdin payload, normalizes it into a host-neutral
// identity, delegates the actual classification to the shared, host-neutral
// scripts/security/risk-policy.mjs, and translates the resulting decision
// into Codex's PreToolUse Hook output shape. It holds no policy logic of its
// own -- mirrors scripts/security/risk-gate.mjs (the Claude adapter)
// structurally, but the approval boundary itself is rewritten for Codex's
// real, current capabilities rather than ported from Claude.
//
// Fail mode: fail SAFE (deny) while a run is active; silent pass-through
// when no KRYLO run is active for this project (same inactive-run contract
// as the Claude gate, and the same one every Codex hook needs per
// docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 10.6, since
// Codex has no Skill-scoped hook lifecycle -- these hooks fire for every
// ordinary Codex session, not only $krylo-run).
//
// Approval boundary (docs/adr/0029-codex-host-packaging-and-approval-boundary.md):
// EVERY `require-approval` classification -- shell, apply_patch, or MCP --
// fails closed (deterministic deny) on Codex. Current official Codex docs
// confirm `permissionDecision: "ask"` is parsed but unsupported and fails
// the hook if returned, so KRYLO cannot route a require-approval action
// through Codex's native prompt the way it does on Claude (ADR-0027). This
// module has NO code path capable of producing an "ask"-shaped decision --
// scripts/host/codex/hook-transport.mjs does not even define a function for
// it. A separate, optional, KRYLO-generated Codex rule (Task 6 of the
// implementation plan) may let an OPERATOR get Codex's own native prompt for
// a specific safe command shape in an ordinary (non-KRYLO) session, but this
// gate does not trust or depend on that rule being installed: the
// rules/PreToolUse/approval_policy execution order is not documented
// upstream, so trusting it here would risk a fail-open gap this module
// cannot verify is actually closed.
//
// Hard-deny (KRYLO's own sensitive-path/data-root/hook-entrypoint/oversized-
// command classifications) always denies regardless of permission_mode,
// identical guarantee to the Claude host.
//
// Session-id bridge (independent review finding, security-critical): current
// official Codex documentation does not expose the real session_id to the
// MODEL itself anywhere -- only Hook payloads carry it (confirmed open
// upstream gap, openai/codex#8923). Only the Skill's own generated shell
// commands can express a session id, and the model has no way to know the
// real one. Left unaddressed, a model-invented placeholder session id would
// never match the real one every subsequent hook resolves, so
// resolveActiveRun() would return { active: false } for the entire run --
// EVERY Codex hook silently no-ops, with no enforcement and no error. The
// Skill's own instructions (codex/skills/krylo-run/SKILL.md) tell the model to use
// a fixed literal placeholder, SESSION_PLACEHOLDER below, for every
// --session argument; THIS hook -- the only place that ever sees the real
// session_id AND the command about to run -- substitutes it before the
// command executes, via Codex's confirmed-supported PreToolUse `allow` +
// `updatedInput` rewrite. Performed unconditionally, not gated on an active
// run: the bootstrapping `init-run.mjs` call is EXACTLY the case where no
// run exists yet. The rewritten command is still fully classified before
// being allowed through, exactly like any other command -- a rewrite is
// never used to bypass a deny.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeCodexHookPayload,
  emitCodexPreToolDeny,
  emitCodexPreToolAllowWithRewrite,
  allowCodexSilently,
  codexCwdFallbackIdentity,
} from '../host/codex/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';

export const SESSION_PLACEHOLDER = 'KRYLO_CODEX_SESSION';

// shell/exec_command -> Bash; apply_patch keeps its own distinct identity
// (never relabeled as Claude's Edit/Write, per the task's explicit
// instruction); mcp__server__tool-shaped names and any other local function
// tool pass through under their own name -- risk-policy.mjs's tool-name
// switch already treats an unrecognized name conservatively.
function normalizeCodexToolName(rawName) {
  if (rawName === 'shell' || rawName === 'exec_command') return 'Bash';
  return rawName;
}

// Substitutes every occurrence of SESSION_PLACEHOLDER in a Bash command with
// the real session id from this hook's own already-normalized identity.
// Returns { rewrote: false } untouched when the tool is not Bash-shaped, the
// command carries no placeholder, or (defensively) no real session id is
// actually available to substitute.
function rewriteSessionPlaceholder(toolName, toolInput, hostSessionId) {
  if (toolName !== 'Bash' || typeof toolInput.command !== 'string' || !toolInput.command.includes(SESSION_PLACEHOLDER)) {
    return { rewrote: false, toolInput };
  }
  if (typeof hostSessionId !== 'string' || hostSessionId === '') {
    return { rewrote: false, toolInput };
  }
  return {
    rewrote: true,
    toolInput: { ...toolInput, command: toolInput.command.split(SESSION_PLACEHOLDER).join(hostSessionId) },
  };
}

function failSafeOnUnreadablePayload() {
  const identity = codexCwdFallbackIdentity();
  if (identity) {
    const run = resolveActiveRun({ projectRoot: identity.projectRoot, host: identity.host, hostSessionId: identity.hostSessionId });
    if (run.active) emitCodexPreToolDeny('KRYLO risk gate could not read this action and denied it as a fail-safe. Re-run with a well-formed request.');
  }
  allowCodexSilently();
}

async function main() {
  const input = await readStdinJson();
  if (!input.ok) failSafeOnUnreadablePayload();
  const normalized = normalizeCodexHookPayload(input.value);
  if (!normalized.ok) failSafeOnUnreadablePayload();
  const payload = normalized.payload;

  const toolName = normalizeCodexToolName(String(payload.tool_name ?? ''));
  const rawToolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  const { rewrote, toolInput } = rewriteSessionPlaceholder(toolName, rawToolInput, normalized.identity.hostSessionId);

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });

  if (!run.active) {
    // No active run yet is the NORMAL case for the bootstrapping
    // init-run.mjs call -- but that call still needs its placeholder
    // rewritten, and it is still classified first (never a blind rewrite):
    // the rewritten command is exactly what will run, so it must pass the
    // same check any other command does before being delivered.
    if (rewrote) {
      try {
        const decision = classifyRiskAction({
          toolName,
          toolInput,
          cwd,
          dataRoot: normalized.identity.dataRoot,
          pluginRoot: normalized.identity.pluginRoot,
        });
        if (decision.action === 'pass') emitCodexPreToolAllowWithRewrite(toolInput);
        // A rewrite-eligible command that does not classify as pass falls
        // through to the ordinary silent allow below rather than denying --
        // there is no active run to protect yet, and the unrewritten
        // placeholder-bearing command is what Codex will actually run in
        // that case (harmless: it only fails to resolve a session, it does
        // not execute anything different).
      } catch {
        // Fall through to silent allow -- same reasoning as above.
      }
    }
    allowCodexSilently();
  }

  const state = run.state;

  try {
    const decision = classifyRiskAction({
      toolName,
      toolInput,
      cwd,
      dataRoot: normalized.identity.dataRoot,
      pluginRoot: normalized.identity.pluginRoot,
    });

    if (decision.action === 'pass') {
      recordEvent(state.runId, { event: 'risk-gate-codex', category: decision.category, status: 'allowed' });
      if (rewrote) emitCodexPreToolAllowWithRewrite(toolInput);
      allowCodexSilently();
    }

    if (decision.action === 'deny') {
      recordEvent(state.runId, { event: 'risk-gate-codex', category: decision.category, status: 'denied' });
      emitCodexPreToolDeny(decision.reason);
    }

    if (decision.action === 'require-approval') {
      // Deny deterministically, every time, regardless of tool surface or
      // permission_mode -- see this module's own header comment for why.
      recordEvent(state.runId, { event: 'risk-gate-codex', category: decision.actionClass, status: 'denied' });
      emitCodexPreToolDeny(
        `${decision.reason} The current Codex host cannot reliably force a native human-approval prompt for this action from inside a KRYLO run. `
        + 'Perform this action outside the KRYLO autonomous run, or under an explicitly supported Codex approval path, then continue the run. '
        + `If a human should review and unblock it, record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
      );
    }

    allowCodexSilently();
  } catch {
    emitCodexPreToolDeny('KRYLO risk gate could not evaluate this action and denied it as a fail-safe.');
  }
}

main().catch(() => {
  allowCodexSilently();
});
