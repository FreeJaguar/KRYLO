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
// ordinary Codex session, not only $krylo-run) -- UNLESS a bootstrap-failure
// marker (scripts/lib/state.mjs) shows a RECOGNIZED $krylo-run invocation
// in THIS exact session failed to bootstrap, in which case this also denies
// (see the check below): an ordinary session with no marker still passes
// through exactly as before.
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
// Session identity: this hook plays NO role in establishing which run is
// active -- it resolves the ALREADY-bootstrapped run using the real
// session_id from ITS OWN hook payload (`resolveActiveRun`), exactly the
// same way scripts/security/risk-gate.mjs (Claude) always has. The run
// itself is created exactly once, by scripts/security/user-prompt-submit-codex.mjs
// (the Codex UserPromptSubmit hook), using the authoritative host-supplied
// session_id from THAT event -- never a model-invented or model-rewritten
// value. See docs/adr/0029-codex-host-packaging-and-approval-boundary.md's
// review-finding history for the two earlier, unsafe model-side bootstrap
// attempts this design replaces.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeCodexHookPayload,
  emitCodexPreToolDeny,
  allowCodexSilently,
  codexCwdFallbackIdentity,
} from '../host/codex/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';
import { computeProjectRootHash, readBootstrapFailureMarker } from '../lib/state.mjs';

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

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) {
    // No active run is normally the "ordinary Codex session" case (silent
    // pass-through, by design -- see this file's header). But it is ALSO
    // what a RECOGNIZED $krylo-run invocation that failed to bootstrap
    // looks like from here, and those two must not be treated the same:
    // the user believes this session is under KRYLO's governance in the
    // second case. user-prompt-submit-codex.mjs records that distinction
    // as a short-lived marker; check it before falling through to the
    // ordinary silent-allow path.
    const projectRootHash = computeProjectRootHash(normalized.identity.projectRoot);
    const failure = readBootstrapFailureMarker({
      projectRootHash,
      host: normalized.identity.host,
      hostSessionId: normalized.identity.hostSessionId,
    });
    if (failure.active) {
      emitCodexPreToolDeny(
        `KRYLO failed to initialize for this session (${failure.reason}) after an explicit $krylo-run invocation. `
        + 'This action is denied until KRYLO successfully initializes: retry $krylo-run, or proceed outside an autonomous KRYLO run.',
      );
    }
    allowCodexSilently();
  }

  const state = run.state;

  try {
    const toolName = normalizeCodexToolName(String(payload.tool_name ?? ''));
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

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
