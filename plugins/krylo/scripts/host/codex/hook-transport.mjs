// Codex Hook transport. This is the only module allowed to know Codex's
// PreToolUse/PermissionRequest JSON output shapes and Codex-specific payload
// fields (session_id, turn_id, permission_mode). Active-run resolution
// itself is host-neutral (scripts/lib/hook-utils.mjs); this module
// normalizes a raw Codex Hook stdin payload into a host-neutral identity
// before Shared Core ever sees it -- mirrors
// scripts/host/claude/hook-transport.mjs exactly.
//
// Security-critical constraint (docs/adr/0029-codex-host-packaging-and-approval-boundary.md):
// current official Codex documentation confirms permissionDecision: "ask"
// (and legacy decision: "approve", continue: false, stopReason,
// suppressOutput) are parsed but NOT supported -- returning any of them
// fails the hook. This module intentionally has NO function capable of
// emitting any of those five fields. There is no emitCodexPreToolAsk here,
// by construction, so a future edit cannot introduce that call by mistake
// without first adding the (absent) function itself.

import path from 'node:path';

import {
  bootstrapCodexRuntimeEnvironment,
  bootstrapCodexStorageEnvironment,
  resolveCodexDataRoot,
  resolveCodexPluginRoot,
  resolveCodexSessionId,
} from './context.mjs';

/**
 * Normalize a raw Codex Hook payload into a host-neutral identity. Same
 * { ok, identity, degraded, payload } contract as
 * normalizeClaudeHookPayload() -- see that function's own comment for the
 * full rationale of the degraded (session-less) fallback path.
 */
export function normalizeCodexHookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'invalid-payload' };
  const projectRoot = typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd : process.cwd();
  try {
    const identity = bootstrapCodexRuntimeEnvironment({ hookPayload: payload, projectRoot });
    return { ok: true, identity, payload };
  } catch {
    if (resolveCodexSessionId({ hookPayload: payload }) !== null) {
      return { ok: false, error: 'invalid-host-identity' };
    }
    try {
      bootstrapCodexStorageEnvironment();
      return {
        ok: true,
        degraded: true,
        identity: {
          host: 'codex',
          hostSessionId: undefined,
          projectRoot: path.resolve(projectRoot),
          dataRoot: resolveCodexDataRoot(process.env),
          pluginRoot: resolveCodexPluginRoot(process.env),
        },
        payload,
      };
    } catch {
      return { ok: false, error: 'missing-host-identity' };
    }
  }
}

/**
 * The degraded, session-less identity used when stdin could not be parsed
 * as JSON at all. Mirrors claudeCwdFallbackIdentity().
 */
export function codexCwdFallbackIdentity() {
  try {
    bootstrapCodexStorageEnvironment();
    return { host: 'codex', hostSessionId: undefined, projectRoot: process.cwd(), dataRoot: resolveCodexDataRoot(process.env) };
  } catch {
    return null;
  }
}

/**
 * Emit a PreToolUse deny decision and exit 0. The ONLY PreToolUse decision
 * shape this module produces -- confirmed-supported by direct inspection of
 * the installed codex-cli 0.120.0 binary's own hook-output validation error
 * table. That same table also confirmed `permissionDecision: "allow"` (with
 * or without `updatedInput`) is REJECTED on this build, alongside `ask` --
 * an earlier version of this module briefly had an
 * `emitCodexPreToolAllowWithRewrite` function for a session-id rewrite
 * mechanism; it was removed once independent review found that shape does
 * not actually work on the verified-installed build (see
 * docs/adr/0029-codex-host-packaging-and-approval-boundary.md's own
 * review-finding history). Do not reintroduce an "allow"-shaped emitter
 * without first verifying, against a real build, that it is accepted.
 */
export function emitCodexPreToolDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/**
 * Emit a PermissionRequest decision. Distinct output shape from PreToolUse
 * (decision.behavior, not permissionDecision) -- confirmed against current
 * official docs. Used only from the PermissionRequest hook.
 */
export function emitCodexPermissionRequestDecision(behavior, message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: message ? { behavior, message } : { behavior },
    },
  }));
  process.exit(0);
}

/** Allow silently (no output) -- also the correct PermissionRequest "no opinion, let Codex's own prompt continue" response. */
export function allowCodexSilently() {
  process.exit(0);
}
