// Shared helpers for KRYLO hook entry scripts.
//
// Every KRYLO gate acts only while a KRYLO run is active for the current
// project (ADR-0009). Ordinary Claude Code sessions are never intercepted:
// when there is no active run the gate exits 0 silently.
//
// Host-neutral: this module has no knowledge of Claude payload field names
// (session_id, prompt_id, permission_mode) or Claude's PreToolUse/Stop JSON
// output shapes. Every Hook entrypoint normalizes a raw host payload into a
// { projectRoot, host, hostSessionId } identity through its host's own
// transport module (e.g. scripts/host/claude/hook-transport.mjs) before
// calling resolveActiveRun() here.

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
 * Resolve the active KRYLO run for one already-normalized host identity.
 * Returns { active: false } unless a pointer exists, the state loads and
 * validates, the project root hash matches, host + hostSessionId are both
 * known, and no terminal state is set.
 */
export function resolveActiveRun({ projectRoot, host, hostSessionId } = {}) {
  try {
    const projectRootHash = computeProjectRootHash(projectRoot ?? process.cwd());
    if (!host || !hostSessionId) return { active: false };
    const pointer = readActiveRunPointer({ projectRootHash, host, hostSessionId });
    if (!pointer.ok || !pointer.value?.runId) return { active: false };
    if (pointer.value.projectRootHash && pointer.value.projectRootHash !== projectRootHash) return { active: false };
    const loaded = loadState(pointer.value.runId);
    if (!loaded.ok || loaded.value.terminalState !== null) return { active: false };
    if (loaded.value.host.name !== host || loaded.value.host.sessionId !== hostSessionId) return { active: false };
    return { active: true, state: loaded.value };
  } catch {
    return { active: false };
  }
}
