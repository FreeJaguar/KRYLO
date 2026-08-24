#!/usr/bin/env node
// KRYLO risk gate (PreToolUse, matcher: Bash|PowerShell|Write|Edit|NotebookEdit|Read|Glob|Grep|mcp__.*).
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
// `ask` is used ONLY for the Bash tool, ONLY for the `git-push`/`git-force`
// action classes, and ONLY when the payload's `permission_mode` is in the
// `ASK_ELIGIBLE_PERMISSION_MODES` allowlist below (`auto`, `manual`) --
// never merely "not `bypassPermissions`" (see that allowlist's own comment
// for the polarity reasoning). Current official Claude Code documentation (this
// project's own verified CHANGELOG, checked in full through the current
// released version) confirms exactly one relevant guarantee, at v2.1.211
// (ADR-0022's floor, further raised to v2.1.223 -- see below):
// "Fixed auto mode overriding a PreToolUse hook's `ask` decision for
// unsandboxed Bash -- a hook `ask` now floors the decision at a prompt."
// That confirmation is scoped to Bash and to "auto mode"; it says nothing
// about `bypassPermissions` (a session mode whose entire documented purpose
// is skipping permission prompts, so trusting `ask` there would be
// nonsensical regardless), about PowerShell, or about any MCP tool's
// permission dialog. Per the task's own instruction not to invent runtime
// contracts, `ask` is not used outside exactly what is confirmed.
//
// Native `ask` is further narrowed to `git-push`/`git-force` only, not every
// require-approval class. Independent security review found that
// production-policy.json's classes vary hugely in severity (a routine
// `git push` vs. `production-deploy`/`payment`/`iam-or-secrets`), yet
// classifyRiskAction() already treated every one of them identically before
// this checkpoint (the policy file's own per-class `decision` field has
// never been read by the classifier). Extending a single-click native
// prompt -- which the v2.1.211 CHANGELOG entry itself notes can be saved as
// an "always allow" rule persisting across sessions and worktrees -- to the
// most severe classes uniformly would be a real proportionality regression
// versus the deliberately heavier `--request-approval`/`RISK_APPROVAL_REQUIRED`
// human-review path those classes deserve. `git-push`/`git-force` are the
// common, low-severity, high-frequency case `ask` genuinely fits; every
// other require-approval class keeps the deterministic `deny` fail-safe
// this module used for all of them before this checkpoint.
//
// v2.1.223 (per this project's CHANGELOG, checked verbatim): "Fixed a Bash
// permission bypass where a crafted command could hide parts of itself from
// permission checks." Relying on a human's native `ask` prompt for informed
// consent requires that the prompt actually shows the real command; a
// version where part of a command could hide from that same permission
// layer would undermine the whole premise. ADR-0022's floor is raised to
// 2.1.223 (not just 2.1.211) for this reason.
//
// Every failure path (unreadable payload, classification exception) still
// uses deterministic `deny`: those are not `require-approval` decisions
// with a legitimate human-review outcome, they are KRYLO's own inability to
// classify the action at all, and `deny` remains the unambiguous, fail-safe
// response to that.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeClaudeHookPayload,
  emitClaudePreToolDecision,
  allowClaudeSilently,
  claudeCwdFallbackIdentity,
} from '../host/claude/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';

const NATIVE_ASK_ACTION_CLASSES = new Set(['git-push', 'git-force']);

// Allowlist, not a denylist: independent security review found the original
// `permission_mode !== 'bypassPermissions'` check inverted the polarity of
// everything else in this decision (tool name and action class are both
// allowlists) and fails toward `ask` -- the unproven direction -- whenever
// `permission_mode` is absent, renamed, or a new mode is added upstream.
// Only modes actually observed, live, to honor a Hook's `ask` decision
// (docs/adr/0025-native-permission-approval.md's verification log: `manual`
// tested explicitly; `auto` tested explicitly and also observed as the
// real default for a non-interactive session with no --permission-mode flag
// at all) are eligible. Everything else -- `bypassPermissions`, `plan`,
// `acceptEdits`, `dontAsk`, an absent field, or any future/renamed mode --
// falls through to the deterministic `deny` fail-safe.
const ASK_ELIGIBLE_PERMISSION_MODES = new Set(['auto', 'manual']);

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
      // permission UI, narrowly (Bash, git-push/git-force only, not
      // bypassPermissions -- see the header comment for why): no
      // KRYLO-local approval record is looked up or consumed here, so a
      // persisted riskApprovals entry (however it got there) can never by
      // itself let this action through, for any tool or class.
      //
      // Structured as if/else (not two sequential ifs) so the native-ask
      // path never reaches the deny branch even in principle -- it must not
      // depend on emitClaudePreToolDecision()'s process.exit(0) as the only
      // thing preventing a double decision.
      // Read permission_mode directly off the raw payload, not off the
      // normalized identity: independent review found that
      // normalizeClaudeHookPayload()'s degraded (session-less) identity
      // path omits permissionMode entirely, so a bypassPermissions session
      // whose session_id happened to be unresolvable would still read
      // undefined here and pass this check -- exactly the gap it exists to
      // close. The raw payload always carries the field when Claude Code
      // sets it, independent of session-id resolution.
      const eligibleForNativeAsk = toolName === 'Bash'
        && NATIVE_ASK_ACTION_CLASSES.has(decision.actionClass)
        && ASK_ELIGIBLE_PERMISSION_MODES.has(payload.permission_mode);

      if (eligibleForNativeAsk) {
        recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'ask' });
        emitClaudePreToolDecision(
          'ask',
          `${decision.reason} Claude Code will ask you to allow or deny this specific action.`,
        );
      } else {
        recordEvent(state.runId, { event: 'risk-gate', category: decision.actionClass, status: 'denied' });
        emitClaudePreToolDecision(
          'deny',
          `${decision.reason} This action class does not yet use the native approval prompt for this tool/mode. If a human should review and unblock it, record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
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
