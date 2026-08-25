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
// fails closed (deterministic deny) on Codex. Direct inspection of the
// installed codex-cli 0.120.0 binary's own hook-output validation error
// table confirms `permissionDecision: "ask"` is rejected outright
// ("PreToolUse hook returned unsupported permissionDecision:ask"), so KRYLO
// cannot route a require-approval action through Codex's native prompt the
// way it does on Claude (ADR-0027). This module has NO code path capable of
// producing an "ask"-shaped decision.
//
// Hard-deny (KRYLO's own sensitive-path/data-root/hook-entrypoint/oversized-
// command classifications) always denies regardless of permission_mode,
// identical guarantee to the Claude host.
//
// Session-id bootstrapping (independent review finding, security-critical,
// disclosed platform limitation -- see docs/adr/0029's own review-finding
// addenda for the full history of two prior attempted fixes and why each
// was found unsafe): current official Codex documentation does not expose
// the real session_id to the MODEL anywhere -- only Hook payloads carry it
// (confirmed open upstream gap, openai/codex#8923). A first fix attempt had
// the model invent a placeholder session id (broke enforcement silently: a
// invented id never matches the real one every later hook resolves). A
// second attempt had THIS hook rewrite the placeholder to the real id via
// PreToolUse's `permissionDecision:"allow"` + `updatedInput` -- confirmed,
// by direct byte inspection of the SAME installed binary's own error-string
// table, to ALSO be rejected outright on this build
// ("PreToolUse hook returned unsupported permissionDecision:allow" /
// "...unsupported updatedInput", immediately adjacent to the already-
// confirmed `ask` rejection). Silently falling back to letting the
// placeholder-bearing command run unmodified would reproduce the original
// silent-total-loss-of-enforcement bug. Instead: THIS hook denies a
// placeholder-bearing command outright, loudly, with an explanation --
// converting an undetectable silent failure into an immediate, visible one.
// This means automatic KRYLO run bootstrapping on Codex does not currently
// work end to end on the verified-installed build; this is a disclosed,
// confirmed capability gap (docs/codex-capability-matrix.md), not silently
// papered over.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeCodexHookPayload,
  emitCodexPreToolDeny,
  allowCodexSilently,
  codexCwdFallbackIdentity,
} from '../host/codex/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';

export const SESSION_PLACEHOLDER = 'KRYLO_CODEX_SESSION';

const SESSION_PLACEHOLDER_REASON =
  'KRYLO cannot currently resolve your real Codex session identity automatically on this Codex build: current Codex hook output '
  + 'validation rejects every mechanism KRYLO could otherwise use to bridge the session id from a Hook payload back to a command '
  + 'you run (confirmed by direct inspection of the installed binary). This is a disclosed platform limitation, not a bug you can '
  + 'work around -- do not invent, guess, or hardcode a session id yourself. Report this as a blocker and stop the run rather than '
  + 'attempting to proceed without correct session binding.';

// shell/exec_command -> Bash; apply_patch keeps its own distinct identity
// (never relabeled as Claude's Edit/Write, per the task's explicit
// instruction); mcp__server__tool-shaped names and any other local function
// tool pass through under their own name -- risk-policy.mjs's tool-name
// switch already treats an unrecognized name conservatively.
function normalizeCodexToolName(rawName) {
  if (rawName === 'shell' || rawName === 'exec_command') return 'Bash';
  return rawName;
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
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  // Checked before the active-run gate, deliberately: the bootstrapping
  // init-run.mjs call is EXACTLY the case where no run is active yet, and
  // this deny must still fire for it -- a silent allow here would recreate
  // the original bug (a run created under a placeholder that no later hook
  // can ever match).
  if (toolName === 'Bash' && typeof toolInput.command === 'string' && toolInput.command.includes(SESSION_PLACEHOLDER)) {
    emitCodexPreToolDeny(SESSION_PLACEHOLDER_REASON);
  }

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowCodexSilently();

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
