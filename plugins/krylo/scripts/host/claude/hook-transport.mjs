// Claude Hook transport. This is the only module allowed to know Claude's
// PreToolUse/Stop JSON output shapes and Claude-specific payload fields
// (session_id, prompt_id, permission_mode). Active-run resolution itself is
// host-neutral (scripts/lib/hook-utils.mjs); this module normalizes a raw
// Claude Hook stdin payload into a host-neutral identity before Shared Core
// ever sees it.

import { bootstrapClaudeRuntimeEnvironment } from './context.mjs';

/**
 * Normalize a raw Claude Hook payload into a host-neutral identity.
 * Returns { ok: false } (never throws) when the payload is malformed or a
 * session id cannot be established, so a caller can fail open/safe per its
 * own documented Hook semantics instead of binding to another session's
 * most-recent pointer.
 */
export function normalizeClaudeHookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'invalid-payload' };
  try {
    const identity = bootstrapClaudeRuntimeEnvironment({
      hookPayload: payload,
      projectRoot: typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd : process.cwd(),
    });
    return { ok: true, identity, payload };
  } catch {
    return { ok: false, error: 'missing-host-identity' };
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
