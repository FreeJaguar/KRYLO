# ADR-0020: Support concurrent KRYLO runs via per-project, per-session pointers

## Status

Accepted

## Context

0.1.0 tracked the active run with a single global `current-run.json` pointer under the KRYLO data root. A second `/krylo:run` in a different project, or a second concurrent Claude Code session in the same project, would overwrite that one pointer, so hooks and CLIs would resolve the wrong run (or none) for whichever session did not write it last.

## Decision

Replace the single pointer with `active-runs/<projectRootHash>/<sessionSegment>.json`, where `sessionSegment` is the session id verbatim when it is filesystem-safe (`^[A-Za-z0-9_-]{1,128}$`, true for Claude Code's UUID session ids) or its SHA-256 hash otherwise (defense against a malformed or adversarial id). All reads and writes go through `safeJoin`, unchanged.

- `scripts/lib/state.mjs` exposes `writeActiveRunPointer`, `readActiveRunPointer`, `clearActiveRunPointer`/`clearActiveRunPointerForState`, and `pruneStaleActiveRunPointers`, replacing the old `*CurrentRunPointer` functions.
- Hooks resolve the pointer from `payload.cwd` (project) and `payload.session_id` (session), both fields Claude Code already includes in hook payloads; when a session id is unknown, resolution falls back to the most recently updated pointer for the project (pre-concurrency behavior, and a safe default for legacy callers).
- CLIs (`update-state.mjs`, `read-state.mjs`) accept `--session`/`--project-dir`; the `run` skill now passes `--session "${CLAUDE_SESSION_ID}"` on every call so two sessions in the same project directory never resolve each other's run.
- Terminal completion clears only the pointer whose `runId`/`projectRootHash`/`sessionId` match the run's own recorded identity (`clearActiveRunPointerForState`), never a sibling session's or project's pointer.
- `cleanup.mjs` prunes pointer files whose run has reached a terminal state or no longer exists, leaving active pointers untouched.
- A pre-0.1.1 `current-run.json` is read once, adopted into the new layout for the matching project, and removed (`migrateLegacyPointer`); a pointer file that fails to parse is simply skipped, not trusted.

## Consequences

- Two projects, or two sessions in one project, run independently; `tests/platform/concurrency.test.mjs` covers two projects, two sessions in one project, one run finishing while another remains active, parallel initialization, stale-pointer cleanup, corrupted-pointer recovery, legacy migration, and Windows/POSIX path equivalence (`computeProjectRootHash` already normalizes separators and case).
- Callers that omit `--session` still work when at most one run is active per project (single-session convenience preserved), but concurrent multi-session use requires the session id, which the shipped `run` skill now always supplies.
