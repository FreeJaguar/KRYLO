# Codex Lifecycle Enforcement Design (Stop, SessionStart, SessionEnd)

- Design date: 2026-09-02
- Repository: `FreeJaguar/KRYLO`
- Baseline branch: isolated `feat/codex-lifecycle-enforcement`, created from `feat/codex-vscode-enforcement` @ `84de91d8fdd03ca87c4dfc635769d90eb9b56f21`
- Governing ADR: `docs/adr/0033-codex-lifecycle-enforcement.md` (full platform re-verification evidence lives there; this document covers behavior design and edge cases)
- Governing prior ADRs: `docs/adr/0023` (Shared Core), `docs/adr/0029` (Codex approval boundary), `docs/adr/0032` (project-scoped hooks)

## 1. Problem

Three Codex lifecycle events remain deliberately deferred per `docs/codex-capability-matrix.md`: `Stop`, `SessionStart`, `SessionEnd`. Without `Stop`, a Codex `$krylo-run` session has no deterministic mechanism forcing continuation while Orbit budget/completion criteria remain unmet -- the model or user can simply end the session at any point, unlike the Claude host where `scripts/orbit/stop-gate.mjs` already enforces this. `SessionStart`/`SessionEnd` are pure lifecycle gaps: no session-boundary telemetry, no informational continuity across a resumed session.

## 2. Non-goals

- `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`: out of scope unless evidence proves one is strictly required for the three events above (none was found).
- Any change to `require-approval` semantics or the `PreToolUse` approval boundary (ADR-0029 unchanged).
- Any change to ADR-0032's project-hook ownership/merge/write-protection design -- this checkpoint only adds three more entries to the already-established mechanism.
- A new completion or Orbit policy. Every decision below is Shared Core's existing, already-tested logic, reused verbatim.
- Claiming SessionEnd as a crash-recovery guarantee (the released runtime does not support that claim -- see ADR-0033).

## 3. Stop hook behavior

### 3.1 Decision table

| Condition (checked in order) | Action |
|---|---|
| Payload unreadable/malformed | Silent allow (no output) |
| `stop_hook_active === true` (Codex's own recursion guard) | Silent allow |
| No active KRYLO run for this exact `host` + `hostSessionId` + project | Silent allow |
| Active run, but `state.terminalState !== null` (already in ANY terminal state) | Silent allow -- single check covers all six terminal states uniformly, no per-state branching |
| Active, non-terminal run; `completionEval(state).complete === true` | Silent allow (model remains responsible for setting `VERIFIED_COMPLETE` explicitly via `update-state.mjs`, exactly as on Claude) |
| Active, non-terminal, incomplete run; Orbit budget exhausted (`cycle >= budget` or `stopBlocks >= budget`) | Finalize `ITERATION_LIMIT_REACHED`, silent allow (the stop itself is never blocked -- only the run's own state is finalized first) |
| Active, non-terminal, incomplete, budgeted run; `assessStagnation(state).recommendation === 'isolate-or-stop'` | Finalize `SAFE_BLOCKED`, silent allow |
| None of the above | Increment `stopBlocks`/`cycle`, persist, emit `{"decision":"block","reason":<Orbit delta>}` |
| Any internal exception during the decide-then-mutate sequence | Silent allow (fail toward ending the session, the confirmed-safe direction for this event -- never toward trapping the user) |

This is `scripts/orbit/stop-gate.mjs`'s existing decision table, unchanged, transported through a Codex-shaped adapter. See ADR-0033 for the direct-source evidence that this fail-direction (malformed/unexpected output lets the session end, never blocks it) is what the real Codex `rust-v0.152.1` handler itself guarantees.

### 3.2 Why no new Orbit/completion policy is introduced

`completionEval`, `assessStagnation`, and the budget fields (`state.orbit.cycle`, `state.orbit.budget`, `state.orbit.stopBlocks`) are already host-neutral (`scripts/lib/state.mjs`, `scripts/orbit/stagnation.mjs`) and already exercised end to end by the existing Claude Stop-gate test suite. The Codex adapter (`scripts/orbit/stop-gate-codex.mjs`) differs from `stop-gate.mjs` only in: which `hook-transport.mjs` it imports from, and therefore which payload-normalization and output-emission functions it calls. The locked-decide-then-mutate sequence, the `finalize()` helper shape, and every state-mutation call are identical logic, not merely similar-looking -- a parity test (Section 6) proves this directly rather than asserting it.

### 3.3 Bounded-loop proof

Every `block` outcome increments `state.orbit.stopBlocks` and `state.orbit.cycle` before returning, under the run's exclusive file lock. The very next Stop hook firing (after the model's continuation) re-reads the freshly-persisted budget and re-evaluates the SAME exhaustion/stagnation checks -- so the number of consecutive blocks is bounded by `state.orbit.budget` (3/5/7 cycles depending on risk, per `docs/03-orbit-loop.md`), identically to the Claude host. `stop_hook_active` additionally prevents Codex's own hook-recursion-within-one-block-round from ever re-entering the gate. No new loop-prevention mechanism was invented; the existing one was reused.

## 4. SessionStart hook behavior

| Condition | Action |
|---|---|
| Payload unreadable/malformed | Silent allow |
| No active KRYLO run for this exact session+project | Silent allow (the overwhelmingly common case: ordinary Codex sessions never touch KRYLO state) |
| An active, non-terminal run IS already bound to this exact session+project (e.g. `source: "resume"`) | Emit `hookSpecificOutput.additionalContext` with a short factual reminder; never create, mutate, or finalize anything |

SessionStart never calls any state-creating function. It reuses the same `resolveActiveRun` read-only lookup every other inactive-run-checking hook already uses. `source` (`startup\|resume\|clear\|compact`) is available as a matcher input but is not used to differentiate behavior in this checkpoint -- the same narrow rule applies regardless of why the session started.

## 5. SessionEnd hook behavior

Given the confirmed ~1-3 second platform teardown budget (ADR-0033), this handler does at most one locked read and, conditionally, one telemetry write -- never a scan, never a bulk operation, never a call into `scripts/runtime/cleanup.mjs` (wrong scope: sessionless, retention-based, operates across every run in the data root).

| Condition | Action |
|---|---|
| Payload unreadable/malformed session identity | No-op |
| No active run bound to this exact session+project | No-op |
| Active run already terminal | No-op (it already ended correctly through its own path) |
| Active, non-terminal run | One `recordEvent()` telemetry write: "session ended while run was still active". `terminalState` is left untouched -- never fabricated, never auto-finalized. Evidence/history is never deleted. |
| Concurrent KRYLO sessions in the same project | `resolveActiveRun` is already keyed by the exact `{host, hostSessionId, projectRootHash}` tuple -- SessionEnd for session A can never resolve or touch session B's run, proven by the existing session-isolation test pattern reused here |
| Abrupt/forced termination | May simply never fire (graceful-teardown-only, per ADR-0033) -- not claimed as guaranteed, and no KRYLO correctness property depends on it firing |

## 6. Test strategy (TDD, per task)

- `plugins/krylo/tests/hooks/stop-gate-codex.test.mjs`: every row of Section 3.1's table, plus a **parity test** asserting the Codex and Claude Stop gates reach the identical `{terminalState, orbit.cycle, orbit.stopBlocks}` outcome for the same starting state and the same completion/budget/stagnation condition -- proving no policy drift between the two adapters.
- `plugins/krylo/tests/hooks/session-start-codex.test.mjs`: inert-by-default, adopts-and-informs-only-when-active-and-matching, never creates a run, `$krylo-runner`-style prefix collisions remain irrelevant to this event (it never parses `prompt` at all).
- `plugins/krylo/tests/hooks/session-end-codex.test.mjs`: every row of Section 5's table, plus a concurrent-session isolation test and an evidence-preservation test (state file byte-for-byte unchanged except the new telemetry line).
- Extend `plugins/krylo/tests/setup/install-codex-hooks.test.mjs` and `plugins/krylo/tests/hooks/codex-project-hook-launcher.test.mjs`: the three new events are installed/launched correctly, `commandWindows` present, foreign-entry preservation still holds with a 6-event file (not just 3).
- Extend `plugins/krylo/tests/unit/risk-policy.test.mjs`: the three new filenames are covered by `HOOK_ENTRYPOINT_FILENAMES`.
- Full existing Claude and Codex suites must remain green, unmodified in behavior.

## 7. Explicitly deferred

`SubagentStart`/`SubagentStop` for Codex (Claude already has these via `scripts/status/agent-events.mjs`; no released-runtime evidence gathered this checkpoint proves they are required for Stop/SessionStart/SessionEnd specifically, and adding them is a separate, reviewable scope). `PreCompact`/`PostCompact` (no current KRYLO Core event needs them, matching the existing Claude-side non-decision). Live authenticated Codex session testing (environment/authorization-blocked, per the task's own live-testing constraint).
