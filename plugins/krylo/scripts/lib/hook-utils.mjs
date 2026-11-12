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

import { locateActiveRunPointer } from './state.mjs';

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
 * validates, the project root hash and host match, and no terminal state is
 * set.
 *
 * `hostSessionId` may be omitted (undefined): per ADR-0020, when the caller's
 * session id could not be established (e.g. a malformed/missing Hook
 * `session_id` field), resolution falls back to the single most recently
 * updated pointer for this host + project, matching the pre-multi-host
 * behavior and preserving single-session enforcement instead of treating an
 * unidentifiable session as "no run is active" and bypassing the gate
 * entirely. `readActiveRunPointer` already implements this fallback scoped
 * to one host's own directory; it is never applied across hosts.
 *
 * When `hostSessionId` IS known and the path-keyed lookup misses, the
 * session is looked up under the nearest ancestor directory, then under any
 * project, before this returns { active: false }; see locateActiveRunPointer()
 * in state.mjs and docs/adr/0043-session-keyed-run-resolution.md.
 * `projectRoot` comes from the payload's `cwd`, which the session itself can
 * move: Claude Code documents that a `cd` inside the project carries over to
 * later calls, and Codex 0.166.0 reports the command's own working directory.
 * A path miss for a named session is therefore never proof that the session
 * is ungoverned, and treating it as such switched every gate off mid-run.
 */
export function resolveActiveRun({ projectRoot, host, hostSessionId } = {}) {
  try {
    if (!host) return { active: false };
    const found = locateActiveRunPointer({ projectRoot, host, hostSessionId, requireActive: true });
    return found.ok && found.state ? { active: true, state: found.state } : { active: false };
  } catch {
    return { active: false };
  }
}
