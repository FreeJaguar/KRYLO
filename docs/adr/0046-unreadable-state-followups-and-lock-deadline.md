# ADR-0046: Unreadable run state in the question gate and telemetry hooks, and a wall-clock lock deadline

## Status

Accepted

## Context

`docs/adr/0045-transient-state-io-retry.md` made "could not read" a distinct outcome of run-state I/O. `loadState()` returns `{ ok: false, error: 'unreadable', transient, code }`, and `saveState()` refuses with `state-unreadable` when the file on disk exists but cannot be read. Run resolution reports such a run as indeterminate, and both risk gates deny on it. ADR-0045 left three follow-ups, all in code that runs after a hook has already resolved its run:

1. **The question gate denied when it could not read.** `scripts/security/question-gate.mjs` reloads the run state under the run lock to consume a one-use question token. When the reload failed, or `saveState()` refused with `state-unreadable`, the gate fell through to its policy denial. That denial tells the model to grant a new token with `update-state.mjs --grant-question <category>`. The gate already rejects this outcome for a lock failure: its own comment says denying there would burn a scarce, human-reviewed grant "for a reason that has nothing to do with policy", and it allows instead (`allowed-lock-contention`). Its documented fail mode is fail-open, because asking a human is always safe. An unreadable state is the same kind of failure as a lock failure, and it got the opposite treatment.
2. **Two telemetry hooks dropped a failed reload silently.** `scripts/orbit/fingerprint.mjs` (PostToolUseFailure) and `scripts/status/agent-events.mjs` (SubagentStart/SubagentStop) correctly record nothing positive for a mutation they did not persist. But they also recorded nothing at all when the reload or the save failed, or the lock could not be taken. The fingerprint or agent record was lost without trace. ADR-0045 had already fixed the same gap in `posttool-telemetry.mjs`, which records `counter-not-persisted`.
3. **The lock had no wall-clock budget.** `scripts/lib/lock.mjs` retried acquisition 600 times with a nominal 10ms pause. A count has no wall-clock meaning: the pause is a timer wait, and Windows timer granularity stretches it. The independent review for ADR-0045 measured a waiter on a held lock giving up after 10.7-10.8s on Windows. For this ADR the same code gave up after 9538ms and 9543ms. The two measurements differ, and neither is the nominal 6s. The tightest lock users are 15s hooks, so the margin to the hook timeout was not a fixed number.

### Measurements for the lock budget

All on the development machine (Windows 11, Node 24.17.0).

- **Hook startup.** A `posttool-telemetry.mjs` process with no active run (Node startup, imports, and the run lookup) took 63ms at the median and 74ms at most, over 30 runs on an idle machine. With a full `npm test` running alongside, it took 143ms at the median, 245ms at p90, and 431ms at most, over 60 runs.
- **Lock give-up, before.** `lock.mjs` from `main` (859552a), with the lock file held by a file that never goes away: 9538ms and 9543ms. The independent review for ADR-0045 measured 10.7-10.8s.
- **Lock give-up, after.** The same harness with this change: 8000ms, 8005ms, and 8001ms.
- **Lock waits under load (from ADR-0045).** The slowest lock acquisition measured under the heaviest stress load was 2.4s, and none timed out. An earlier budget of 200 x 10ms (nominally 2s, more on Windows) failed on a shared Windows CI runner with 12 processes racing for one run's lock (comment history in `lock.mjs`).

### Alternatives considered

- **Question gate: keep denying, with a different message.** A deny without the grant hint still blocks the question for a reason that is not policy, and the model can still ask in plain text. Rejected: it contradicts the gate's documented fail-open stance, and the lock-failure case already chose allow.
- **Telemetry hooks: write a stderr diagnostic.** Both hooks promise no output, and stderr from a hook is not kept anywhere KRYLO can read later. Rejected in favor of a local telemetry event, which is where `counter-not-persisted` already goes.
- **Telemetry hooks: reuse the positive event names with a failure status.** Existing tests pin that no `failure`, `agent-start`, or `agent-stop` event is recorded for an unpersisted mutation, and any later reader that counts those events would count a mutation that never happened. Rejected in favor of distinct event names.
- **Telemetry hooks: add the fs error `code` and `transient` to the telemetry whitelist.** Not needed to make the failure visible, and widening the whitelist is a privacy-document change of its own. The `status` value carries the cause instead. Not chosen.
- **Lock: keep the attempt count and only correct the comment.** It leaves the budget machine-dependent. Rejected, for the same reason ADR-0045 rejected a count for the rename retry.
- **Lock: 6000ms**, the original nominal intent. It would shorten the Windows wait from about 10.8s to 6s, under 2.5x the slowest measured wait and not far above the budget that failed on CI. Not chosen. **10000ms** or more would keep Windows near today's behavior but leave about 3s of margin to a 15s hook timeout. Not chosen.

## Decision

1. **The question gate fails open when it cannot read the run state.** When its reload under the lock fails (any `loadState()` failure), or `saveState()` refuses with `state-unreadable`, the gate allows the question, records a `question-gate` event with status `allowed-state-unreadable`, and tells the model not to grant a new token. This is the same path as a lock failure, with its own status and reason text, because the condition is not contention. Nothing is persisted, so an available grant stays available. Other `saveState()` refusals (`invalid`, `backup-failed`) are unchanged and still deny.
2. **The fingerprint and agent-event hooks record a mutation they did not persist.** `recordFailureFingerprint()` records `failure-not-persisted` with the redacted `category` and `hash`. `recordAgentEvent()` records `agent-start-not-persisted` or `agent-stop-not-persisted` with the `agentType`. The `status` field names the cause:
   - `state-unreadable`: the reload returned `unreadable`, or the save was refused with `state-unreadable`.
   - `reload-failed`: any other reload failure.
   - `save-failed`: any other save refusal.
   - `save-failed`: also a throw from inside the held lock, such as a rename that outlasted its retry budget (ADR-0045).
   - `lock-failed`: the lock could not be taken.

   Both hooks stay fail-open: exit 0, no output, never a decision. No positive event (`failure`, `agent-start`, `agent-stop`) is recorded for an unpersisted mutation, as before. A SubagentStop that reads the state and finds no running agent mutates nothing and records nothing. One that cannot read the state records `agent-stop-not-persisted`, because it cannot tell. All fields used are already in the telemetry whitelist (`docs/22-privacy-and-telemetry.md`).
3. **The lock wait has a monotonic wall-clock deadline of 8000ms.** `withFileLock()` computes a deadline with `performance.now()` and retries until it passes, the same way `withTransientRetry()` in `lib/atomic.mjs` does. Each pause is the smaller of 10ms and the time left, and the last attempt comes at the deadline. The set of retried error codes, the `lock-timeout` error, and the release path are unchanged. `lock.mjs` still has no stale-lock recovery.

The 8000ms budget comes from both ends:

- **Upper bound.** The worst case for a 15s hook (`PostToolUse`, `PostToolUseFailure`, `SubagentStart`/`SubagentStop`) is the sum of:
  - Node startup, under 0.5s at the measured maximum under load.
  - The lock-free run lookup, up to about 0.5s of blocked reads (ADR-0045).
  - The full 8s lock wait.
  - The hook's own hold, up to about 1.5s (ADR-0045).

  That comes to about 10.5s, leaving over 4s to the timeout. That margin matters most for the hold: a hook killed while holding the lock orphans it.
- **Lower bound.** 8000ms is over 3x the slowest measured lock wait (2.4s), and it is well above the old budget that failed on a shared CI runner.

The effective wait moves from about 10.8s (9.5s on this machine) to 8s on Windows, and from about 6s to 8s on POSIX.

## Consequences

- **The question gate no longer burns a human-reviewed grant on a read failure.** The fail-open outcome is consistent with the rest of the gate: an indeterminate run at resolution already allowed silently (ADR-0045), and a lock failure already allowed. The cost: a question asked while the state cannot be read is effectively free, because the available grant is not consumed and the routine-question policy is not applied. The question gate is not a security boundary, and asking a human is always safe. A failed reload of a `corrupted` state is included, and is labelled `allowed-state-unreadable` like the others. Such a run resolves as no run on the next hook anyway (ADR-0045).
- **Lost fingerprints and agent records are now diagnosable.** Each one leaves a local telemetry line with its cause. Recording a fingerprint that was not persisted also means a repeated failure is not counted toward `requiredStrategyChange`, the Orbit stagnation signal. That was already true before this change; it is now visible.
- **Hook timing.** The worst case for the tightest lock users drops from about 13s (ADR-0045) to about 10.5s on Windows. On POSIX it rises from about 8.5s to about 10.5s, still under the 15s timeout. The question gate (30s) and the Stop gates (60s) have more room. The risk gate and Codex `SessionEnd` take no lock.
- **Convoy under a persistent holder (ADR-0045).** When every mutator holds the lock for its full 1.5s budget and fails, about five such holders now exhaust a waiter's budget, against about seven before. Waiters give up after 8s instead of about 10.8s. The data outcome is unchanged: those mutations fail either way.
- **Orphaned lock (pre-existing, unchanged).** An orphaned lock still makes every later mutator for that run wait the full budget and fail, now for 8s on every platform.
- **Fewer lock waits succeed on a slow Windows machine.** A wait that would have succeeded between 8s and about 10.8s now times out. No measured wait came near 8s. The telemetry hooks record the outcome (`counter-not-persisted`, `*-not-persisted` with `lock-failed`), and the question gate allows.
- **Security.** No gate becomes more permissive in a way that affects tool execution. The question gate allows a question it would have denied for a non-policy reason; that decision is about asking a human, never about running a tool. The telemetry events carry only whitelisted scalar fields: a redacted 16-hex hash, a fixed category, an agent type, and a fixed status string. No raw error text, path, or fs error code is recorded.
- **Residual.**
  - Only the question gate's `state-unreadable` save refusal fails open. `backup-failed` and `invalid` still deny with the grant hint (open question, below).
  - The question gate does not record the fs error code or whether the failure was transient.

### Open question

`saveState()` can refuse a question-token consumption with `backup-failed` (a pre-migration backup could not be written) or `invalid` (should not happen for this mutation). Both still deny with the hint to grant a new token, the outcome decision 1 avoids for an unreadable state. They were left unchanged because neither is an unreadable-state condition and the follow-up was scoped to that. Treating every failure to persist the consumption as fail-open would be the more uniform rule.

## Verification

- `plugins/krylo/tests/hooks/question-gate-unreadable-state.test.mjs` covers decision 1. Three fault tests fail against `main` (859552a), where the gate denied with the grant hint. A failed reload without a grant, a failed reload with a grant available, and a `state-unreadable` save refusal with a grant available now allow, with status `allowed-state-unreadable`, and leave the grant `available` on disk. A control test passes on both: with the preload loaded but no fault reached, the gate still consumes a grant and then denies.
- `plugins/krylo/tests/hooks/telemetry-mutation-not-persisted.test.mjs` covers decision 2. Seven fault tests fail against `main`, where nothing was recorded. Four run the hooks as processes under the fault preload:
  - The fingerprint hook with a failed reload, and with a refused save.
  - The agent-event hook with a failed reload on SubagentStart, and a refused save on SubagentStop.

  Each now records its `*-not-persisted` event with `status: 'state-unreadable'`, persists nothing, records no positive event, and exits 0 with no output. Three more drive the exported functions in-process. A `state.json` that is not JSON makes the reload fail as `corrupted`, recorded as `reload-failed`. A rename of `state.json` that throws inside the held lock is recorded as `save-failed`. A lock held by another process, with a fake monotonic clock so no real time passes, is recorded as `lock-failed`. The `save-failed` test also fails against the first version of this change, which labelled that case `lock-failed`. A control test passes on both, including a SubagentStop with no running agent that records nothing.
- Both files use the existing fault preload `plugins/krylo/tests/fixtures/state-io/fail-state-rereads.mjs`. It now takes the number of state reads that succeed before the fault starts (`KRYLO_TEST_STATE_READS_BEFORE_FAULT`, default 1, so its existing users are unchanged) and logs each injected failure (`KRYLO_TEST_FAIL_READ_LOG`). Every fault test asserts that the fault fired, and the save-refusal tests assert that it fired on the third read, which is `saveState()`'s pre-write read.
- `plugins/krylo/tests/unit/lock.test.mjs` covers decision 3 with two deterministic tests driving a fake monotonic clock (mocked `performance.now()` and `Atomics.wait()`). Both fail against `main`:
  - With 50ms pauses, `main` waited 30000ms of clock (600 attempts). The new code gives up at the 8000ms budget after about 161 attempts.
  - With 1ms pauses, `main` gave up after 600ms. The new code keeps waiting until the budget.
- The real give-up times are in Context.
- Full `npm test` and strict plugin validation results are recorded in the pull request.

## Supersedes

None. This ADR closes the follow-ups listed in `docs/adr/0045-transient-state-io-retry.md`; that ADR's decisions stand.

## Superseded by

None.
