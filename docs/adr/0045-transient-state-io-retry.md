# ADR-0045: Retry transient sharing errors on run-state I/O, and never record them as corruption

## Status

Accepted

## Context

KRYLO's Hooks share one run's state through `runs/<id>/state.json`. Writers use temp-file-plus-rename (`scripts/lib/atomic.mjs`) inside the run's exclusive lock (`scripts/lib/lock.mjs`); readers are deliberately lock-free, and every Hook reads `state.json` once at startup to resolve its run (`resolveActiveRun()` in `scripts/lib/hook-utils.mjs`).

Two weaknesses were reported together. First, under parallel hook load on Windows, `posttool-telemetry.mjs` occasionally lost a tool-counter increment and recorded `counter-not-persisted`, and the concurrency tests in `tests/hooks/concurrent-mutation.test.mjs` failed intermittently under full-suite load. Second, `readJson()` did not retry a transient sharing error, and `loadState()` then reported a live run as `corrupted` and copied it aside.

### Root cause, measured

All measurements are on the development machine (Windows 11, Node 24.17.0), with temporary measurement-only instrumentation that was never committed.

1. **Mechanism.** On Windows, `fs.renameSync` over an existing target fails with `EPERM` while another process holds the target open, even when that holder is a plain Node `fs.readFileSync` (observed directly below). That libuv implements the rename with `MoveFileEx` and opens files with full share flags is our understanding of its implementation, not something verified here; the conclusions rest only on the observed behavior. A micro-benchmark with one writer and no readers saw 42 `EPERM` rename failures in 2008 renames (antivirus or indexer opening the new file); with a single reader process looping on the target, the writer's renames failed 289 times in 4 seconds, and with 4 or more readers it starved for over 4 seconds. Readers never saw an error in any configuration.
2. **Which code path loses the update.** With every exit path of `posttool-telemetry.mjs` instrumented, 15 concurrent hooks against each of six parallel runs: the only failure was `EPERM` from `rename` thrown out of `saveState()` inside the lock. No lock timeout, no failed reload, no not-active resolution, and no corrupt-state sidecar occurred.
3. **Why the retry did not cover it.** `renameWithRetry()` allowed 5 attempts with a 20ms pause, 113 to 151ms of wall clock in practice. Of the contended renames that eventually succeeded, the median needed about 40ms, the p90 about 106ms, the p99 about 158ms, and the slowest 204ms (with the full test suite running alongside). Every lost update was a rename that hit its fifth attempt between 113 and 151ms. The budget sat inside the contention distribution rather than beyond it.
4. **Who holds the file open.** KRYLO's own lock-free readers (the other hooks' startup `resolveActiveRun()`), plus the operating system's scanners. Lock waiters are not a factor: they spin on the lock file and never open `state.json`.

The lock retry budget was not the cause: slow lock acquisitions (just over 1 second) occurred, but none timed out.

### Loss rate before the change (unmodified `main`)

| Load | Runs (each 15 concurrent hooks) | Runs that lost an increment |
| --- | --- | --- |
| Repro alone, 3 runs in parallel | 150 | 2 (1.3%) |
| Repro alone, 6 runs in parallel | 240 | 1 |
| Repro alongside a full `npm test`, 6 runs in parallel | 180 | 8 (4.4%) |

Every loss was recorded in telemetry as `counter-not-persisted`.

### The reader side

No reader error was observed in any live configuration. Reads share access with each other and with the writer, so a reader can be blocked only by a holder that denies sharing (some backup and antivirus products) or by a delete-pending file. The defect is in the classification, not in its frequency: when it does happen, `loadState()` treated an unreadable file as corrupt content, reported a live run as `corrupted`, and tried to copy it aside. `saveState()` had the mirror-image defect: any failure to read the existing file was treated as "no prior file" and fell through to the write, deciding the pre-migration backup question on a false premise.

### Governance while the run cannot be read (independent review)

An independent review of the first version of this change found that the same "could not read" condition also switched governance off, in three places that predate this ADR:

- **Risk gates fail open.** Run resolution turned an unreadable pointer, or an unreadable `state.json`, into "no active run". `risk-gate.mjs` then allowed every tool call silently, and `risk-gate-codex.mjs` did the same unless a bootstrap-failure marker existed. With a fault-injection preload making every `state.json` read fail with `EBUSY`, `git push --force origin main` went from `ask` (Claude) and `deny` (Codex) to a silent allow on both hosts, before and after the first version of this change.
- **Codex re-invocation replaces a live run.** `user-prompt-submit-codex.mjs` treated any failed `loadState()` of the session's existing run as "no existing run". A second `$krylo-run` while the state was unreadable created a fresh run and overwrote the session pointer, dropping the live run's grants, approvals, and Orbit budget.
- **Cleanup deletes on missing evidence.** The pruning sweep counted any non-transient read failure, and a state written by a newer schema, as "stale". It also deleted a pointer without checking that it still named the same run, so a pointer rewritten for a new run between the check and the delete could be removed.

### Alternatives considered

- **Readers take the run lock.** Removes the contention, but serializes every Hook's startup check behind every writer. That adds latency to the risk gate on every tool call and widens the lock's blast radius to processes that never mutate anything. Rejected.
- **Rename the old file away first, then rename the new one in.** A file open with `FILE_SHARE_DELETE` can be renamed, but the target is then briefly absent, so readers see `not-found` and resolve no active run. That is worse than the problem. Rejected.
- **POSIX rename semantics** (`FILE_RENAME_FLAG_POSIX_SEMANTICS`) would replace an open target, but Node exposes no API for it, and adding a native dependency for it violates the minimal-dependency rule. Not available.
- **Raise the attempt count.** A fixed count has no wall-clock meaning: Windows sleep granularity makes the same count take very different times on different machines. A deadline expresses the actual constraint. Rejected in favor of a deadline.
- **Risk gate on an unreadable run: classify as if the run were active.** The risk classifier needs no run state (only the run id, for telemetry), so it could run normally while the run is unreadable. Its security outcome equals that of an active run, and a state that stays unreadable would not block routine tools such as `Read` and `Grep`. Not chosen here: an allowed call is silent, so the model would keep working without being told that the run cannot be read, while every run-state write it attempts fails. A deny states the condition on the first gated call. This trade-off is open to revisit (see Consequences).

## Decision

1. `writeJsonAtomic()` retries a rename that fails with `EPERM` or `EBUSY` until a **1000ms deadline** on a monotonic clock (`performance.now()`), with jittered exponential backoff (4ms doubling, capped at 50ms, each pause drawn from the upper half of its interval). Each attempt is still a single rename, so atomicity is unchanged. Any other error code fails immediately, and the temp file is always removed on failure.
2. Every state read (`readJson()`, and `saveState()`'s pre-write read through the new `readFileWithRetry()`) retries `EPERM` or `EBUSY` until a **250ms deadline** with the same backoff. `ENOENT` and every other code fail immediately. The read budget is short because some callers read many small files in a loop (active-run pointer scans).
3. `readJson()` reports a sharing error that outlasts its budget as `{ ok: false, error: 'busy', code }`, distinct from `read-error` (a non-transient fs failure) and `parse-error` (bytes were read and are not JSON).
4. **Corruption is a property of bytes that were actually read.** `loadState()` reports `busy` and `read-error` as `{ ok: false, error: 'unreadable', transient, code }` and never copies the file aside. Only `parse-error` and a schema-invalid document are `corrupted` and preserved as `state.corrupt-<epoch>.json`.
5. `saveState()` treats only an absent file as "no prior file": `ENOENT`, or `ENOTDIR` (a path component is a regular file, which POSIX reports where Windows reports `ENOENT`); `readJson()` reports both as `not-found`. A present-but-unreadable file refuses the save with `{ ok: false, error: 'state-unreadable' }`.
6. `posttool-telemetry.mjs` and its Codex counterpart `posttool-telemetry-codex.mjs` record `counter-not-persisted` when their reload under the lock fails, instead of returning as if the increment had been saved.
7. `pruneStaleActiveRunPointers()` (the `cleanup.mjs` pointer sweep) deletes a pointer only on positive evidence that its run is over: the pointer file is not valid JSON or names no run, or the run it names is missing, `corrupted`, or terminal. An unreadable pointer or state (transient or not), a state from a schema this build cannot load, or any other unknown result leaves the pointer in place. Just before deleting, the sweep re-reads the pointer and deletes it only if it still names the same run (or is still the same unparseable file). Before this change any failed read counted as "stale", so a cleanup run while another session's `state.json` was briefly held deleted that live run's pointer and silently switched off its gates.
8. **"Could not read" is not "no run".** When this session's own pointer, or the run state a pointer leads to, exists but cannot be read, `readActiveRunPointer()` returns `pointer-unreadable`, and `locateActiveRunPointer()` returns `{ ok: false, error: 'run-state-unreadable', indeterminate: true, reason, runId, transient, code }`. It stops at the first such result on the exact and ancestor lookups. On the session-wide scan it wins when no readable live run was found, and always for the state-mutating CLIs (`ambiguity: 'fail'`), so they never pick one run while another of the session's pointers is unreadable. `resolveActiveRun()` passes it on as `{ active: false, indeterminate: true, ... }`.
9. **Both risk gates deny on an indeterminate run**, on the normal path and on the unreadable-payload fail-safe path, with a message that names the condition, says to retry, and says how a human recovers. They record a `run-state-unreadable` telemetry event when the run id is known. A session with no KRYLO pointer of its own is still a silent allow: KRYLO is not the default agent.
10. **Codex `$krylo-run` re-invocation keeps the live run.** When the session's existing pointer or its state is unreadable, `user-prompt-submit-codex.mjs` starts no new run and tells the model to retry. It writes no bootstrap-failure marker, because the session is still governed and decision 9 already denies risk-gated actions meanwhile.
11. `update-state.mjs`, `read-state.mjs`, and `cross-harness-run.mjs` report `run-state-unreadable` instead of `no-current-run`, so a model is not told to start over while a live run exists.

The rename budget was set at about five times the slowest contended rename that succeeded in the first measurement (204ms). The independent review's traced run saw a longer tail (up to 597ms from first to last `EPERM` within one hook; see Verification), so the real headroom is under 2x. The budget is not raised here, because the one loss the review saw on this change could not be attributed to it (see Verification), and a longer budget lengthens the lock hold for every contended writer. 250ms covers a scanner's brief hold; no read-side `EPERM`/`EBUSY` was observed in either measurement. Both budgets are spent inside the run lock, which bounds them from above (see "Lock hold time" below). `lock.mjs` is unchanged: its retry budget was not the cause.

## Consequences

- The lost-update failure is greatly reduced at its cause for every mutator, not only `posttool-telemetry.mjs`, because all of them persist through `writeJsonAtomic()`. It is not shown to be eliminated: the independent A/B run saw one loss in 240 runs on this change. Evidence is in the Verification section below.
- **Lock hold time and hook timeouts.** A writer that hits contention now holds the run lock longer while it retries. An ordinary mutation holds it for up to three bounded operations (`loadState()`'s read, `saveState()`'s pre-read, the rename): about 1.5s, against about 150ms before. A terminal transition adds a fourth, the pointer read in `clearActiveRunPointer()`, for about 1.75s. Terminal transitions run only from `update-state.mjs` (a CLI with no hook timeout) and the Stop gates (60s timeout). `lock.mjs`'s budget is 600 attempts of 10ms, nominally 6s, but each 10ms pause measures about 16.6ms on Windows. The independent review measured a waiter on a held lock giving up after 10.7-10.8s. The tightest lock users are the 15s `PostToolUse`, `PostToolUseFailure`, and `SubagentStart`/`SubagentStop` hooks. Their realistic worst case is about 13s: Node startup, their lock-free run lookup (up to about 500ms of blocked reads), the full lock wait, and their own hold of up to 1.5s. The margin is smaller than before. Normal contention does not come near it (see the measured lock waits below).
- **Convoy under a persistent holder.** Suppose something holds `state.json` open without sharing for longer than the budgets (backup or antivirus software), or the file is read-only (Windows reports `EPERM`, which cannot be told apart from a sharing error). Then every mutator holds the lock for its full budget and fails. About seven such holders exhaust a waiter's lock budget, so parallel hooks wait about 10.8s and then time out, where before each holder cost about 150ms. The outcome for the data is unchanged, since those mutations fail either way. What gets worse is latency in a situation that is already broken.
- **Orphaned lock (pre-existing, unchanged).** `lock.mjs` has no stale-lock recovery. If the host kills a hook inside the critical section, the lock file is left behind, and every later mutator for that run spends the full lock budget and fails. A longer hold makes being killed inside the critical section somewhat more likely. This ADR does not change that disclosed residual.
- **Caller behavior for a failed load.** No caller in `scripts/` branches on `error === 'corrupted'`, `recovered`, or `corruptPath`; all of them branch on `ok`. A failure that used to say `corrupted` now says `unreadable` (CLIs echo the new string). The behavior changes are the pruning sweep (decision 7), the risk gates and Codex re-invocation (decisions 9 and 10), and the CLI error text (decision 11).
- **Other hooks on an indeterminate run keep their inactive-run behavior.** None of them is a security boundary: the telemetry hooks (`posttool-telemetry`, `fingerprint`, `agent-events`, Codex `SessionEnd`) record nothing, the Stop gates let the stop through, the question gate allows the question (its documented fail-open: asking a human is always safe), Codex `SessionStart` adds no context, and `permission-request-codex.mjs` returns no decision, which leaves Codex's own prompt in place. Because PreToolUse runs first, a risk-gated action never reaches those later hooks without the risk gate's deny.
- **Security.** An unreadable state is still never trusted, never fabricated, and never overwritten. The retry adds no input surface and reads no new paths. Governance consequences:
  - Decision 9 closes a pre-existing fail-open: while this session's pointer or state could not be read, both risk gates allowed every tool call silently.
  - Decision 10 closes a pre-existing loss of governance state: a Codex re-invocation could replace a live run that was only unreadable.
  - Decision 7 closes a related pre-existing fail-open: cleanup could delete a live run's pointer on a failed read.
  - **A state that stays unreadable wedges the session, by design.** While this session's pointer or state cannot be read, the risk gate denies every gated tool call (including `Read`, `Grep`, and `Edit`), and cleanup never removes the pointer. A transient hold clears on its own. A persistent one (a read-only or ACL-denied file, a backup product holding it) needs a human: restore read access to the file, or end KRYLO governance for the session by removing that session's active-run pointer. The deny message says so. The alternative of classifying as if the run were active (see Alternatives) would avoid the wedge with the same security outcome, and remains open to revisit.
- **Cross-platform.** On macOS and Linux `rename(2)` replaces an open target, so the rename retry is normally never exercised there. `EPERM` and `EBUSY` there are persistent (permissions, macOS privacy controls, mounts). They are still classified as `busy`/`transient: true`, and cost at most 250ms per read and 1000ms per rename before being surfaced. Retrying only on Windows was considered and not chosen, for two reasons. The classification would become platform-dependent, and the fault-injection tests could no longer pin it on every CI platform.
- **Residual.**
  - A holder that keeps `state.json` open without sharing for longer than the budgets still makes the write or the read fail. That failure is now reported accurately instead of as corruption.
  - The reader-side fix is verified by deterministic fault injection only, because no reader error was reproduced live on this machine.
  - Since ADR-0043, run resolution can read `state.json` more than once on its fallback path, and each blocked read can cost up to 250ms. An indeterminate result now stops the exact and ancestor lookups at once, so the same unreadable state is not read again. The tightest hook budget, Codex `SessionEnd` (3s), takes no lock and writes no state, so it pays only for reads that are actually blocked.
  - An unreadable pointer *file* makes a run indeterminate only when it is this session's own session-keyed pointer. A pointer file that the session-less fallback scan (ADR-0020) cannot read cannot be attributed to the caller and is skipped as before, and an unreadable legacy flat pointer for this session or legacy global `current-run.json` still resolves as "not found". Otherwise an ordinary session could be denied because of another session's file. An unreadable *state* behind a pointer the lookup did pick is always indeterminate, including the newest pointer that the session-less fallback picks, so that fallback keeps gating while the state cannot be read.
  - A pointer whose file stays unreadable is never pruned. That leaves a file behind; it does not leak governance.
  - The re-read before a pruning delete narrows the window in which a pointer rewritten for a new run could be deleted. It does not close it, because pointer writes take no lock.
  - A `corrupted` or schema-refused state still resolves as "no run" (a silent allow outside a run). That is pre-existing and unchanged here: its bytes were read, and the corrupt copy is preserved for diagnosis.
- **Not changed here (follow-ups).**
  - `question-gate.mjs` treats a failed reload or a `state-unreadable` save as a denial that asks for a human-reviewed grant, rather than taking its lock-failure path.
  - `orbit/fingerprint.mjs` and `status/agent-events.mjs` still drop a failed reload silently.
  - `lock.mjs` has no wall-clock deadline; its effective budget depends on the platform's timer granularity.

## Verification

- `plugins/krylo/tests/unit/state-io-transient.test.mjs` injects `EPERM`/`EBUSY` through the shared `node:fs` module object. Of its first sixteen tests, eleven fail against the code before this change. They cover the reader retries, the persistent-busy classification, the `unreadable`-not-`corrupted` contract, the `saveState()` refusal, a 400ms rename window that the old budget lost, the bounded rename deadline, and the two transient pruning cases. The other five pin invariants that already held: non-transient errors and `ENOENT` are not retried, genuinely corrupt bytes are still preserved, and a genuinely gone run's pointer is still pruned.
- The same file has twelve more tests for decisions 7 and 8, added after the independent review. Eight fail against 13adf3d, the head before they were added: pruning keeps a pointer on a non-transient read error of the pointer or of its state (flat and legacy layouts) and on an unsupported schema, pruning does not delete a pointer rewritten for a new run, and run resolution reports an unreadable state or pointer as indeterminate (including the session-scan rule). Four pass on both and pin what must keep holding: a corrupt pointer file is still pruned, a transiently unreadable legacy flat pointer is left alone, a readable live legacy pointer is still migrated, and a session with no pointer of its own is still "no run".
- `plugins/krylo/tests/hooks/posttool-reload-failure.test.mjs` covers decision 6 on both hosts. It uses a test-only `--import` preload (`tests/fixtures/state-io/fail-state-rereads.mjs`) that fails every read of `state.json` after the hook's first. Both fault cases fail against the previous code; a control case without the fault passes on both.
- `plugins/krylo/tests/hooks/unreadable-run-state.test.mjs` covers decisions 9 and 10 on both hosts. Its preload (`tests/fixtures/state-io/fail-reads-of-path.mjs`) fails every read of one exact file and logs each injected failure, and every fault test asserts that the fault fired. Nine tests fail against 13adf3d: an unreadable state (`EBUSY`) and an unreadable pointer (`EPERM` on Claude, `EBUSY` on Codex) each deny on both gates with the specific reason; the unparseable-payload fail-safe path denies for the same reason on both hosts, and on Claude also with no session id at all (the ADR-0020 fallback); and a Codex re-invocation with an unreadable state or pointer keeps exactly one run, the same pointer, and unchanged state bytes. On 13adf3d the gates allowed silently and the re-invocation created a second run. Four are guards that pass on both: per host, a readable run still gets its normal decision, and a session with no pointer of its own stays a silent allow while another session's run is unreadable.
- `plugins/krylo/tests/stress/state-io-contention.mjs` is the opt-in reproduction (not part of `npm test`). Unless noted, each row is 40 rounds x 6 parallel runs x 15 concurrent hooks with `npm test` looping alongside:

| Code | Measured by | Runs | Runs that lost an increment | `counter-not-persisted` | Corrupt sidecars |
| --- | --- | --- | --- | --- | --- |
| `main` at 8729ed7 | author | 240 | 8 (3.3%) | 8 | 0 |
| First version (1500ms rename budget) on 8729ed7 | author | 240 | 0 | 0 | 0 |
| First version, development repro, 60 rounds, three full `npm test` runs alongside | author | 360 | 0 | 0 | 0 |
| `main` at 17779f0 (includes ADR-0043) | author | 240 | 22 (9.2%) | 25 | 0 |
| This change (1000ms) on 17779f0 | author | 240 | 0 | 0 | 0 |
| `origin/main` (stress script copied in) | independent review | 240 | 13 (5.4%) | 14 | 0 |
| This change at 13adf3d | independent review | 240 | 1 (0.4%) | 1 | 0 |
| This change at 13adf3d, 80 rounds, fs-error tracing preload | independent review | 480 | 0 | 0 | 0 |

  No run in any row exited non-zero. Current `main` loses more often than 8729ed7 did. That is consistent with ADR-0043's run resolution reading `state.json` more often, which means more lock-free readers holding the file during a rename; this explanation was not measured separately.

  The one loss on this change in the independent A/B run was recorded only as `counter-not-persisted`, without the per-error tracing, so its cause is not attributed: it may be a rename that outlasted the 1000ms budget, a lock timeout, or a failed reload. The change therefore greatly reduces the loss rate (13 of 240 to 1 of 240 on the same machine and load) but is not shown to eliminate it.

  The traced run logged every thrown `renameSync`, `readFileSync`, and `openSync` error. 388 of 7680 hooks hit a contended `state.json` rename. The span from the first to the last `EPERM` within one hook was 21ms at the median, 384ms at p99, and 597ms at most (up to 12 attempts), so the time to success was at least that. No read-side `EPERM` or `EBUSY` was observed. Hook wall time was 2.5s at the median, 7.7s at p99, and 10.2s at most at this load; there is no base figure at the same load to compare with.

- `tests/hooks/concurrent-mutation.test.mjs` (posttool counters and SubagentStart ids) was run 50 times on each side with `npm test` looping alongside. It passed 50 of 50 times on `main` (8729ed7) and 50 of 50 on the first version of this change. That test fires 15 hooks at a single run, which is less contention than the stress script's six parallel runs. It did not reproduce the loss on this machine at this load, so it cannot by itself show the fix. The evidence for the fix is the stress script. The evidence for stability is that plus repeated clean full `npm test` runs: seven consecutive on the first version (923 passed, 0 failed, 1 skipped each) and three consecutive on a clean checkout of the final tree rebased on 17779f0 (961 passed, 0 failed, 1 skipped each).
- Lock waits were measured on the first version (1500ms rename budget) under the heaviest load. 197 lock acquisitions took longer than 1s (median 1.2s, slowest 2.4s), against 5 (slowest 1.2s) before. The increase is expected, because writes that previously failed fast now succeed after retrying while holding the lock. None timed out.
- An independent code review of the first version found no blocker. Its findings on the lock-budget arithmetic, the security wording, persistent `EPERM`, and the pruning sweep are folded into this record.
- A second independent review of 13adf3d found no blocker either. It re-ran the stress A/B (the review rows above), measured the lock give-up time, and found the governance gaps that decisions 7 to 11 close. Its findings are folded into this record.

## Supersedes

None.

## Superseded by

None.
