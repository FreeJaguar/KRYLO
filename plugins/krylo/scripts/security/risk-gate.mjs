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
// Human approval boundary (docs/adr/0025-native-permission-approval.md,
// restored to full require-approval-class coverage by
// docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md):
// a `require-approval` classification is translated into Claude Code's own
// native `permissionDecision: "ask"` -- putting the actual authorization
// decision in the host's own permission UI, not in any KRYLO-local state a
// prompt-injected model could forge or manipulate -- replacing the prior
// KRYLO-APPROVE chat-phrase mechanism (ADR-0024, superseded).
//
// `ask` is used for EVERY `require-approval` classification (all classes in
// production-policy.json, and every genuinely-identified MCP write class --
// see mcp-classifier.mjs's `hardDeny` flag for the malformed/unknown/blocked
// exceptions, which stay `deny`), for the Bash, PowerShell, and MCP tool
// surfaces (the only three that can ever produce a `require-approval`
// classification -- see risk-policy.mjs), and ONLY when the payload's
// `permission_mode` is in the `ASK_ELIGIBLE_PERMISSION_MODES` allowlist
// below (`auto`, `manual`, `default`) -- never merely "not
// `bypassPermissions`" (see that allowlist's own comment for the polarity
// reasoning).
//
// ADR-0025 originally narrowed native ask to Bash-only, `git-push`/
// `git-force`-only, reasoning that (a) official confirmation of the
// underlying `ask` guarantee was scoped to Bash and "auto mode" in the
// v2.1.211 CHANGELOG, and (b) a single-click prompt was disproportionate for
// severe classes. ADR-0027 supersedes that narrowing: current official
// Claude Code documentation (code.claude.com/docs/hooks, permissions)
// states that PreToolUse hooks run "before the permission prompt, for every
// tool" and that `permissionDecision` is a single generic mechanism (allow/
// deny/ask, plus an undocumented `defer`) -- the v2.1.211 fix was a
// narrow bug fix for one specific auto-mode override on Bash, not evidence
// that `ask` is unconfirmed for other tools. Leaving every other
// `require-approval` class and tool as a hard `deny` was itself found to
// violate KRYLO's own product contract: a policy outcome of
// `require-approval` must have a real human-approval path, not a
// deterministic block indistinguishable from a genuine `deny`.
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
// response to that. Sensitive-path, data-root, hook-entrypoint, and
// oversized-command decisions are `deny`, not `require-approval`, and are
// completely unaffected by this checkpoint -- they never reach the ask path.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeClaudeHookPayload,
  emitClaudePreToolDecision,
  allowClaudeSilently,
  claudeCwdFallbackIdentity,
} from '../host/claude/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';
import { isMcpToolName } from './mcp-classifier.mjs';

// The only three tool surfaces that can ever produce a `require-approval`
// classification (risk-policy.mjs: Write/Edit/NotebookEdit/Read/Glob/Grep
// only ever produce `deny` or `pass`, never `require-approval`). No
// class-based allowlist is needed any more -- ADR-0027 restores native ask
// to every `require-approval` class, so eligibility here is purely about
// which tool surface KRYLO can present a meaningful native prompt for, not
// about picking and choosing which classes "deserve" one.
const NATIVE_ASK_ELIGIBLE_TOOLS = new Set(['Bash', 'PowerShell']);

// Allowlist, not a denylist: independent security review found the original
// `permission_mode !== 'bypassPermissions'` check inverted the polarity of
// everything else in this decision (tool name and action class are both
// allowlists) and fails toward `ask` -- the unproven direction -- whenever
// `permission_mode` is absent, renamed, or a new mode is added upstream.
// Only modes actually observed, live, to honor a Hook's `ask` decision
// (docs/adr/0025-native-permission-approval.md's verification log: `manual`
// tested explicitly; `auto` tested explicitly and also observed as the
// real default for a non-interactive session with no --permission-mode flag
// at all; `default` -- an undocumented sixth value accepted by the CLI
// despite being absent from `claude --help`'s own choices list -- tested
// explicitly on the pinned 2.1.223 floor binary and confirmed to honor
// `ask` identically) are eligible. Everything else -- `bypassPermissions`,
// `plan`, `acceptEdits`, `dontAsk`, an absent field, or any future/renamed
// mode --
// falls through to the deterministic `deny` fail-safe.
const ASK_ELIGIBLE_PERMISSION_MODES = new Set(['auto', 'manual', 'default']);

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
      // permission UI, for every require-approval class, on the Bash,
      // PowerShell, and MCP tool surfaces (ADR-0027): no KRYLO-local
      // approval record is looked up or consumed here, so a persisted
      // riskApprovals entry (however it got there) can never by itself let
      // this action through, for any tool or class.
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
      const eligibleForNativeAsk = (NATIVE_ASK_ELIGIBLE_TOOLS.has(toolName) || isMcpToolName(toolName))
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
          `${decision.reason} This action's permission mode does not support the native approval prompt. If a human should review and unblock it, record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
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
