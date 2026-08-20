// Shared helpers for KRYLO hook entry scripts.
//
// Every KRYLO gate acts only while a KRYLO run is active for the current
// project (ADR-0009). Ordinary Claude Code sessions are never intercepted:
// when there is no active run the gate exits 0 silently.

import { readActiveRunPointer, loadState, computeProjectRootHash } from './state.mjs';

const STDIN_LIMIT = 1024 * 1024; // 1 MB guard against unbounded input

/** Read all of stdin (bounded) and parse it as JSON. Never throws. */
export async function readStdinJson() {
  try {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > STDIN_LIMIT) break;
    }
    if (data.trim() === '') return { ok: false, error: 'empty' };
    return { ok: true, value: JSON.parse(data) };
  } catch {
    return { ok: false, error: 'unparseable' };
  }
}

/** Event name across observed payload spellings. */
export function eventName(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.hook_event_name ?? payload.event_type ?? '');
}

/**
 * Resolve the active KRYLO run for the hook's working directory.
 * Returns { active: false } unless a pointer exists, the state loads and
 * validates, the project root hash matches cwd, and no terminal state is set.
 */
export function resolveActiveRun(payload) {
  try {
    const cwd = payload && typeof payload.cwd === 'string' && payload.cwd.trim() !== ''
      ? payload.cwd
      : process.cwd();
    const cwdHash = computeProjectRootHash(cwd);
    const hostSessionId = payload && typeof payload.session_id === 'string' && payload.session_id.trim() !== ''
      ? payload.session_id
      : undefined;

    // TODO(multi-host Task 6): normalize through
    // normalizeClaudeHookPayload/resolveActiveRun({ projectRoot, host,
    // hostSessionId }) instead of this literal 'claude' host once every Hook
    // entrypoint is wired to the Claude Hook transport adapter.
    const pointer = readActiveRunPointer({ projectRootHash: cwdHash, host: 'claude', hostSessionId });
    if (!pointer.ok || !pointer.value || typeof pointer.value.runId !== 'string') {
      return { active: false };
    }
    if (pointer.value.projectRootHash && pointer.value.projectRootHash !== cwdHash) {
      return { active: false };
    }
    const loaded = loadState(pointer.value.runId);
    if (!loaded.ok) return { active: false };
    if (loaded.value.terminalState !== null) return { active: false };
    return { active: true, state: loaded.value };
  } catch {
    return { active: false };
  }
}

/** Emit a PreToolUse permission decision and exit 0. */
export function emitPreToolDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** Allow silently (no output). */
export function allowSilently() {
  process.exit(0);
}
