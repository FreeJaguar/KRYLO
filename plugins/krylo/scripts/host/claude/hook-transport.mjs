// Claude Hook transport. This is the only module allowed to know Claude's
// PreToolUse/Stop JSON output shapes and Claude-specific payload fields
// (session_id, prompt_id, permission_mode). Active-run resolution itself is
// host-neutral (scripts/lib/hook-utils.mjs); this module normalizes a raw
// Claude Hook stdin payload into a host-neutral identity before Shared Core
// ever sees it.

import path from 'node:path';

import {
  bootstrapClaudeRuntimeEnvironment,
  bootstrapClaudeStorageEnvironment,
  resolveClaudeDataRoot,
  resolveClaudePluginRoot,
  resolveClaudeSessionId,
} from './context.mjs';

/**
 * Normalize a raw Claude Hook payload into a host-neutral identity.
 * Returns { ok: false } only when the payload itself is unusable (not an
 * object). When a session id cannot be established from the payload (a
 * missing/malformed `session_id` and no `CLAUDE_SESSION_ID` fallback), this
 * still returns { ok: true, degraded: true, identity } with `hostSessionId`
 * left undefined, carrying only the project/host/data-root identity that
 * does not depend on a session id.
 *
 * This degraded identity is what lets resolveActiveRun() apply its
 * ADR-0020 fallback (the single most-recently-updated pointer for this
 * host + project) instead of the caller treating an unidentifiable session
 * as "no run is active" and bypassing risk/completion enforcement entirely
 * in the common single-session case. It never binds across hosts or across
 * genuinely distinct sessions with recorded, differing session ids.
 */
export function normalizeClaudeHookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'invalid-payload' };
  const projectRoot = typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd : process.cwd();
  try {
    const identity = bootstrapClaudeRuntimeEnvironment({ hookPayload: payload, projectRoot });
    return { ok: true, identity, payload };
  } catch {
    // Only degrade to a session-less identity when the session id itself is
    // genuinely unresolvable. A different validation failure (an oversized
    // permission_mode/prompt_id, an unresolvable data/plugin root, ...) must
    // NOT silently discard a perfectly good session_id and fall back to
    // "most recent pointer for the project" -- that would let a malformed-
    // but-otherwise-valid payload for session A get evaluated against
    // session B's run and spend session B's approvals. In that case, fail
    // the same way an invalid payload does and let the caller's own
    // fail-safe path (e.g. risk-gate.mjs's cwd-fallback deny) decide.
    if (resolveClaudeSessionId({ hookPayload: payload }) !== null) {
      return { ok: false, error: 'invalid-host-identity' };
    }
    try {
      bootstrapClaudeStorageEnvironment();
      return {
        ok: true,
        degraded: true,
        identity: {
          host: 'claude',
          hostSessionId: undefined,
          projectRoot: path.resolve(projectRoot),
          dataRoot: resolveClaudeDataRoot(process.env),
          // Independent review found this degraded path omitted pluginRoot
          // entirely, so touchesPluginInstallation() (risk-policy.mjs) was
          // silently inert -- no signal, not even a safe default -- for any
          // session whose session id could not be resolved but whose
          // active run was still found via the ADR-0020 fallback (the
          // exact scenario this degraded path exists for). Same bug class
          // already fixed once for `permission_mode` in risk-gate.mjs.
          pluginRoot: resolveClaudePluginRoot(process.env),
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
 * as JSON at all (unparseable, empty, or truncated by the size guard) --
 * there is no payload to read `cwd` from, so this falls back to the Hook
 * process's own working directory, which Claude Code sets to the project
 * root. Used only by callers whose documented fail mode requires still
 * checking for an active run before giving up (see risk-gate.mjs).
 */
export function claudeCwdFallbackIdentity() {
  try {
    bootstrapClaudeStorageEnvironment();
    return { host: 'claude', hostSessionId: undefined, projectRoot: process.cwd(), dataRoot: resolveClaudeDataRoot(process.env) };
  } catch {
    return null;
  }
}

/** Emit a PreToolUse permission decision and exit 0. */
export function emitClaudePreToolDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** Emit a Stop-hook block decision and exit 0. */
export function emitClaudeStopBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

/** Allow silently (no output). */
export function allowClaudeSilently() {
  process.exit(0);
}
