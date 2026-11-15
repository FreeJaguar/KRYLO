# ADR-0043: Resolve the active run by host session, not only by the payload's working directory

## Status

Accepted

## Context

Every KRYLO hook decides whether it is inside a governed run by calling `resolveActiveRun()` (`scripts/lib/hook-utils.mjs`). It located the run only through `active-runs/<projectRootHash>/<host>/<session>.json`, where `projectRootHash` was computed from the hook payload's `cwd` (`scripts/host/claude/hook-transport.mjs` and `scripts/host/codex/hook-transport.mjs` both take `projectRoot` from `payload.cwd`). A miss returned `{ active: false }`, and every gate treats that as an ordinary, ungoverned session: the risk gates allow silently, the Stop gates release, telemetry and fingerprinting do nothing.

That `cwd` is not a stable key:

- **Claude Code.** The official tools reference says that when Claude runs `cd` in the main session, the new working directory carries over to later Bash commands as long as it stays inside the project or an added working directory, unless `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is set; and the hooks guide defines a hook's `cwd` as the working directory when the event fired. A headless `claude -p` probe on 2.1.318 did not reproduce the carry-over (the shell was reset to the project directory after `cd sub`), so the carry-over itself was not observed live here; the desktop-app session this was found in did move its working directory into a subdirectory after a `cd`.
- **Codex.** From 0.166.0 (#57198) `PreToolUse` input reports the command's local working directory (`tool_cwd`) instead of the session's, while the hook process itself still runs in the session directory (read in `codex-rs` source at `rust-v0.167.2`; at `rust-v0.154.0` both were the session directory). Codex 0.167.2 is not in the reviewed runtime contract, so it is `SAFE_BLOCKED` today and was never exposed.

A direct probe of the released `risk-gate.mjs`, with a run bound to session S at root R, gave `ask` for `git push origin main` with `cwd` R, and a silent allow with `cwd` R/sub or an unrelated directory. Live on Claude Code 2.1.318, with the gate wired through `--settings`, a push allow rule, a run bound to R, and a headless session started in R/sub (so the real payload carried `cwd` R/sub): `main`'s gate emitted no decision and **the push reached the remote**; this ADR's gate emitted `ask` and nothing was pushed. That run started the session in the subdirectory rather than reaching it by `cd`, so it proves the gate's behavior for a real moved `cwd`, not the carry-over itself. The Codex bootstrap-failure marker (`bootstrap-failures/<projectRootHash>/codex/<session>.json`), which makes a recognized-but-failed `$krylo-run` fail closed, had the same weakness.

## Decision

The host session id is the key that identifies a governed session, because the session cannot change it; a path is a hint.

1. One resolver, `locateActiveRunPointer()` in `scripts/lib/state.mjs`, serves both the hooks (through `resolveActiveRun()`) and the runtime CLIs (`update-state.mjs`, `read-state.mjs`, `cross-harness-run.mjs`). In order:
   1. The exact path-keyed pointer for the reported directory, with the existing semantics, including the ADR-0020 most-recent fallback when no session id is known. For hooks it is used only if it leads to this session's non-terminal run; if it does not (a stale pointer, or a state read that failed transiently), resolution continues to the next steps instead of concluding "no run".
   2. Only for a known session: this session's own pointer under the **nearest ancestor** of that directory, so a subdirectory resolves to the project it is inside.
   3. Only for a known session: this session's pointer under any project. If several lead to active runs, hooks take the most recently updated (at worst they gate against the wrong one of the session's own runs), while the runtime CLIs refuse with `ambiguous-session-run` rather than guess which run to change.
   Steps 2 and 3 accept a pointer only if its `runId` is a string and it leads to a non-terminal run of exactly this host and session. A recorded `projectRootHash` that disagrees with the pointer's directory is deliberately not a reason to skip it there: the run itself is validated, and rejecting a pointer to the session's own live run could only fail open. Each step runs in its own error boundary and each candidate is validated separately, so neither an exception nor a malformed pointer skips the remaining lookups. No new storage is written.
   The CLIs call the resolver with `requireActive`, so a stale pointer at the exact directory never receives a mutation; reading or changing a finished run takes an explicit `--run`.
2. Both risk gates' fail-safe paths (payload parsed but identity validation failed) resolve the session through the host adapter's own resolver (the payload's `session_id`, then `CLAUDE_SESSION_ID` or `CODEX_THREAD_ID`) and pass it into the same resolver. It is used only to find a run to deny under, never to allow anything.
3. The Codex bootstrap-failure marker falls back to the same session's marker under any project through `readBootstrapFailureMarkerForSession()`, on the normal path and on the fail-safe path, with or without a `cwd`.
4. Without any session id nothing changes: the ADR-0020 path-keyed fallback remains the only resolution, since nothing else identifies the session.
5. The payload's `cwd` keeps its other role untouched: the risk policy still receives it to resolve relative paths in the command being classified. `cross-harness-run.mjs` now passes the run's own recorded project hash, not the caller's directory, into the worker request.

## Consequences

- A `cd` into a project subdirectory, a Codex `workdir`, or an absent `cwd` no longer switches the gates off for a governed session, and a session with runs in two projects is attributed to the project its directory is inside (from an unrelated directory, hooks take the most recent and the CLIs refuse). `tests/security/run-resolution-cwd.test.mjs` enforces this for both hosts' risk and Stop gates, both fail-safe paths, the Codex marker, and `update-state.mjs`/`read-state.mjs` (`cross-harness-run.mjs` shares the resolver call but has no dedicated test), from the project root, subdirectories, an unrelated directory, and no `cwd`, with three controls: a different session still passes through, a terminal run is not revived, and malformed pointers elsewhere change nothing. Five of the eight base cases fail on the code before this ADR (the three controls pass there by design), and each review case fails on the revision it was written against. A second review round used mutation testing: removing the terminal, session or host check, the recorded-hash tolerance, the ancestor walk, the ambiguity refusal, or either fail-safe's session id each makes a specific test fail.
- Every hook that calls `resolveActiveRun()` benefits: the Stop gates, telemetry, fingerprinting, the question gate, and the Codex SessionStart/SessionEnd/PermissionRequest hooks.
- `user-prompt-submit-codex.mjs` keeps its own path-keyed idempotency check (`readActiveRunPointer()` plus a project-hash match), so a second `$krylo-run` from a different project in the same session still bootstraps a separate run there; the hooks then attribute each directory to its nearest project as above.
- Cost: every hook call from a known session that misses the exact path pays the ancestor walk (one small file read per directory level) and, if that also misses, one listing of `active-runs/` plus one read per project hash. That includes ordinary sessions after a run. Measured on Windows for an ordinary session with 30 project hashes present, two passes of 20 runs each: `risk-gate.mjs` median 95 and 100 ms on this branch against 78 and 87 ms on `main`, i.e. roughly 13 to 17 ms added per hook call. Project-hash directories are never pruned, so the listing grows with the number of projects that ever had a run in this data root.
- Theoretical, accepted: a bootstrap-failure marker left under project A keeps denying that session for up to its 15-minute TTL even after a successful run starts in project B, which clears only B's marker. This fails closed.
- A second revision briefly made a pointer at the exact path final, on the theory that re-reading `state.json` during concurrent replacement caused lost updates. The reproduction below refuted that theory, and an automated security review flagged the rule as fail-open (a stale exact pointer would hide the live run), so it was reverted; a test now covers the stale-pointer case.
- Pre-existing, not caused or fixed here: under parallel load on Windows, a concurrent `posttool-telemetry` increment is occasionally lost because the save under the run lock fails (`counter-not-persisted`), while every hook still resolves the run. A reproduction of 15 concurrent hooks, three copies in parallel, lost an increment in 4 of 75 rounds on `main` and 7 of 75 on this branch, with the same failure classification in every case. Recorded as a separate follow-up, together with the reader side: `readJson()` does not retry a transient sharing error, and `loadState()` then reports the state as corrupted (copying it aside) instead of retrying, so a hook can momentarily see a live run as unreadable.
- This is a fix to the released Claude host, not only a precondition for Codex 0.167.2. The live checks recorded in ADR-0042 each ran from the project root and remain valid for that case.

## Supersedes

None. Narrows ADR-0020's run resolution: a path-keyed miss for a known session is no longer final.

## Superseded by

None.
