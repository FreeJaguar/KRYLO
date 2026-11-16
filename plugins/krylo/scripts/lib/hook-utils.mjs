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
//
// `indeterminate: true` (with active: false) means this session's own
// pointer, or the state behind the pointer this lookup picked (with no
// session id, the newest one per ADR-0020), exists but could not be read
// (docs/adr/0045-transient-state-io-retry.md): the session may be governed,
// so it is not the same as "no run". The risk gates deny on it; every other
// hook keeps its inactive-run behavior, because none of them is a security
// boundary (telemetry, status, Stop and question gates fail open by design).
export function resolveActiveRun({ projectRoot, host, hostSessionId } = {}) {
  try {
    if (!host) return { active: false };
    const found = locateActiveRunPointer({ projectRoot, host, hostSessionId, requireActive: true });
    if (found.ok && found.state) return { active: true, state: found.state };
    if (found.indeterminate) {
      return {
        active: false,
        indeterminate: true,
        reason: found.reason,
        runId: found.runId ?? null,
        transient: found.transient === true,
        code: found.code ?? null,
      };
    }
    return { active: false };
  } catch {
    return { active: false };
  }
}

/** The model-facing deny reason for an indeterminate run (see resolveActiveRun()). */
export function indeterminateRunDenyReason(run) {
  const what = run.reason === 'pointer-unreadable' ? "this session's KRYLO run pointer" : "this session's KRYLO run state";
  const code = typeof run.code === 'string' && /^[A-Z]{2,12}$/.test(run.code) ? ` (${run.code})` : '';
  return `KRYLO could not read ${what}${code}, so it cannot tell whether this action is allowed in the run, and denied it as a fail-safe. `
    + 'This is usually another process holding the file for a moment: retry the action. '
    + 'If it keeps happening, stop and ask the user: a human must restore read access to the file, or end KRYLO governance for this session.';
}
