# ADR-0043: Resolve the active run by host session, not only by the payload's working directory

## Status

Accepted

## Context

Every KRYLO hook decides whether it is inside a governed run by calling `resolveActiveRun()` (`scripts/lib/hook-utils.mjs`). It located the run only through `active-runs/<projectRootHash>/<host>/<session>.json`, where `projectRootHash` was computed from the hook payload's `cwd` (`scripts/host/claude/hook-transport.mjs` and `scripts/host/codex/hook-transport.mjs` both take `projectRoot` from `payload.cwd`). A miss returned `{ active: false }`, and every gate treats that as an ordinary, ungoverned session: the risk gates allow silently, the Stop gates release, telemetry and fingerprinting do nothing.

That `cwd` is not a stable key:

- **Claude Code.** The official tools reference says that when Claude runs `cd` in the main session, the new working directory carries over to later Bash commands as long as it stays inside the project or an added working directory, unless `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is set; and the hooks guide defines a hook's `cwd` as the working directory when the event fired. A headless `claude -p` probe on 2.1.318 did not reproduce the carry-over (the shell was reset to the project directory after `cd sub`), so the carry-over itself was not observed live here; the desktop-app session this was found in did move its working directory into a subdirectory after a `cd`.
- **Codex.** From 0.166.0 (#57198) `PreToolUse` input reports the command's local working directory (`tool_cwd`) instead of the session's, while the hook process itself still runs in the session directory (read in `codex-rs` source at `rust-v0.167.2`; at `rust-v0.154.0` both were the session directory). Codex 0.167.2 is not in the reviewed runtime contract, so it is `SAFE_BLOCKED` today and was never exposed.

A direct probe of the released `risk-gate.mjs`, with a run bound to session S at root R, gave `ask` for `git push origin main` with `cwd` R, and a silent allow with `cwd` R/sub or an unrelated directory. The Codex bootstrap-failure marker (`bootstrap-failures/<projectRootHash>/codex/<session>.json`), which makes a recognized-but-failed `$krylo-run` fail closed, had the same weakness.

## Decision

The host session id is the key that identifies a governed session, because the session cannot change it; a path is a hint.

1. `resolveActiveRun()` keeps its path-keyed lookup first, unchanged. When that misses and the caller has a host session id, it then looks the session up by id alone: `listActiveRunPointersForSession()` (`scripts/lib/state.mjs`) enumerates the project-root hashes already present under `active-runs/` and reads `<hash>/<host>/<session>.json` in each, ignoring a pointer whose recorded `projectRootHash` disagrees with its directory. Each candidate must still load, be non-terminal, and match the host and the session id; the most recently updated one wins. No new storage is written.
2. `risk-gate-codex.mjs` applies the same fallback to the bootstrap-failure marker through `readBootstrapFailureMarkerForSession()`.
3. Without a host session id nothing changes: the ADR-0020 fallback to the most recent pointer for the host and project remains the only resolution, since nothing else identifies the session.
4. The payload's `cwd` keeps its other role untouched: the risk policy still receives it to resolve relative paths in the command being classified.

## Consequences

- A `cd` into a project subdirectory, a Codex `workdir`, or an absent `cwd` no longer switches the gates off for a governed session. `tests/security/run-resolution-cwd.test.mjs` enforces this for both hosts' risk gates and Stop gates and for the Codex marker, across the project root, a subdirectory, a nested subdirectory, an unrelated directory, and no `cwd`, with two controls: a different session in an unrelated directory still passes through, and a terminal run is not revived.
- Every hook that calls `resolveActiveRun()` benefits, including the Stop gates, telemetry, fingerprinting, the question gate, and the Codex SessionStart/SessionEnd/UserPromptSubmit/PermissionRequest hooks. One deliberate side effect: `user-prompt-submit-codex.mjs`'s idempotency check now also sees a session's active run under another project, so a second `$krylo-run` in the same session does not start a parallel run elsewhere.
- Cost: on a path miss with a known session, one directory listing of `active-runs/` plus one small file read per project hash. After a run ends, an ordinary session pays this on every hook call; it is bounded by the number of projects that ever had a run in this data root.
- This is a fix to the released Claude host, not only a precondition for Codex 0.167.2. The live checks recorded in ADR-0042 each ran from the project root and remain valid for that case.
- Not addressed: the runtime CLIs `read-state.mjs` and `update-state.mjs` still find the run through `readActiveRunPointer()` keyed by their own working directory (or `--project-dir`) when the model invokes them; a miss there fails the call visibly with `no-current-run` rather than bypassing a gate.

## Supersedes

None. Narrows ADR-0020's run resolution: a path-keyed miss for a known session is no longer final.

## Superseded by

None.
