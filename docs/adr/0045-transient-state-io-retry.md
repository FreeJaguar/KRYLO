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

### Alternatives considered

- **Readers take the run lock.** Removes the contention, but serializes every Hook's startup check behind every writer. That adds latency to the risk gate on every tool call and widens the lock's blast radius to processes that never mutate anything. Rejected.
- **Rename the old file away first, then rename the new one in.** A file open with `FILE_SHARE_DELETE` can be renamed, but the target is then briefly absent, so readers see `not-found` and resolve no active run. That is worse than the problem. Rejected.
- **POSIX rename semantics** (`FILE_RENAME_FLAG_POSIX_SEMANTICS`) would replace an open target, but Node exposes no API for it, and adding a native dependency for it violates the minimal-dependency rule. Not available.
- **Raise the attempt count.** A fixed count has no wall-clock meaning: Windows sleep granularity makes the same count take very different times on different machines. A deadline expresses the actual constraint. Rejected in favor of a deadline.

## Decision

1. `writeJsonAtomic()` retries a rename that fails with `EPERM` or `EBUSY` until a **1000ms deadline** on a monotonic clock (`performance.now()`), with jittered exponential backoff (4ms doubling, capped at 50ms, each pause drawn from the upper half of its interval). Each attempt is still a single rename, so atomicity is unchanged. Any other error code fails immediately, and the temp file is always removed on failure.
2. Every state read (`readJson()`, and `saveState()`'s pre-write read through the new `readFileWithRetry()`) retries `EPERM` or `EBUSY` until a **250ms deadline** with the same backoff. `ENOENT` and every other code fail immediately. The read budget is short because some callers read many small files in a loop (active-run pointer scans).
3. `readJson()` reports a sharing error that outlasts its budget as `{ ok: false, error: 'busy', code }`, distinct from `read-error` (a non-transient fs failure) and `parse-error` (bytes were read and are not JSON).
4. **Corruption is a property of bytes that were actually read.** `loadState()` reports `busy` and `read-error` as `{ ok: false, error: 'unreadable', transient, code }` and never copies the file aside. Only `parse-error` and a schema-invalid document are `corrupted` and preserved as `state.corrupt-<epoch>.json`.
5. `saveState()` treats only `ENOENT` as "no prior file". A present-but-unreadable file refuses the save with `{ ok: false, error: 'state-unreadable' }`.
6. `posttool-telemetry.mjs` and its Codex counterpart `posttool-telemetry-codex.mjs` record `counter-not-persisted` when their reload under the lock fails, instead of returning as if the increment had been saved.
7. `pruneStaleActiveRunPointers()` (the `cleanup.mjs` pointer sweep) leaves a pointer untouched when the pointer file is `busy` or the state it names is transiently `unreadable`. Before this change any failed read counted as "stale", so a cleanup run while another session's `state.json` was briefly held deleted that live run's pointer and silently switched off its gates.

The rename budget is about five times the slowest contended rename that succeeded (204ms), and 250ms covers a scanner's brief hold. Both are spent inside the run lock, which bounds them from above (see "Lock hold time" below). `lock.mjs` is unchanged: its retry budget was not the cause.

## Consequences

- The lost-update failure is removed at its cause for every mutator, not only `posttool-telemetry.mjs`, because all of them persist through `writeJsonAtomic()`. Evidence is in the Verification section below.
- **Lock hold time and hook timeouts.** A writer that hits contention now holds the run lock longer while it retries: at most 1.5s per mutation (two bounded reads plus the rename budget), against about 150ms before. `lock.mjs`'s budget is 600 attempts of 10ms. That is about 10s of wall clock on Windows, not 6s, because each 10ms pause measures about 16.6ms on this machine. A hook's worst case is therefore that 10s lock wait plus its own hold, about 11.5-12s, inside the 15s `PostToolUse`/`SubagentStart` timeouts. The margin is smaller than before. Normal contention does not come near it (see the measured lock waits below).
- **Convoy under a persistent holder.** Suppose something holds `state.json` open without sharing for longer than the budgets (backup or antivirus software), or the file is read-only (Windows reports `EPERM`, which cannot be told apart from a sharing error). Then every mutator holds the lock for its full budget and fails. About seven such holders exhaust a waiter's lock budget, so parallel hooks wait up to 10s and then time out, where before each holder cost about 150ms. The outcome for the data is unchanged, since those mutations fail either way. What gets worse is latency in a situation that is already broken.
- **Orphaned lock (pre-existing, unchanged).** `lock.mjs` has no stale-lock recovery. If the host kills a hook inside the critical section, the lock file is left behind, and every later mutator for that run spends the full lock budget and fails. A longer hold makes being killed inside the critical section somewhat more likely. This ADR does not change that disclosed residual.
- **Caller behavior for a failed load.** No caller in `scripts/` branches on `error === 'corrupted'`, `recovered`, or `corruptPath`; all of them branch on `ok`. A failure that used to say `corrupted` now says `unreadable` (CLIs echo the new string), and every caller takes the same path it took before. The one behavior change is the pruning sweep (decision 7).
- **Security.** An unreadable state is still never trusted, never fabricated, and never overwritten. The retry adds no input surface and reads no new paths. Two governance consequences must be stated:
  - Taking the same path is not always taking the fail-safe path. If `state.json` stays unreadable past the 250ms read budget, `resolveActiveRun()` reports no active run. `risk-gate.mjs` then allows the tool call silently, and so does `risk-gate-codex.mjs` unless a bootstrap-failure marker exists. This is pre-existing behavior, and the retry makes it less likely, not more. It is still a fail-open window for governance while the file is held.
  - Decision 7 closes a related pre-existing fail-open: cleanup could delete a live run's pointer on a transient read failure.
- **Cross-platform.** On macOS and Linux `rename(2)` replaces an open target, so the rename retry is normally never exercised there. `EPERM` and `EBUSY` there are persistent (permissions, macOS privacy controls, mounts). They are still classified as `busy`/`transient: true`, and cost at most 250ms per read and 1000ms per rename before being surfaced. Retrying only on Windows was considered and not chosen, for two reasons. The classification would become platform-dependent, and the fault-injection tests could no longer pin it on every CI platform.
- **Residual.**
  - A holder that keeps `state.json` open without sharing for longer than the budgets still makes the write or the read fail. That failure is now reported accurately instead of as corruption.
  - The reader-side fix is verified by deterministic fault injection only, because no reader error was reproduced live on this machine.
  - Since ADR-0043, run resolution can read `state.json` more than once on its fallback path, and each blocked read can cost up to 250ms. The tightest hook budget, Codex `SessionEnd` (3s), takes no lock and writes no state, so it pays only for reads that are actually blocked.
- **Not changed here (follow-ups).**
  - `question-gate.mjs` treats a failed reload or a `state-unreadable` save as a denial that asks for a human-reviewed grant, rather than taking its lock-failure path.
  - `orbit/fingerprint.mjs` and `status/agent-events.mjs` still drop a failed reload silently.
  - The new `transient`/`code` fields have no consumers yet beyond the pruning sweep.

## Verification

- `plugins/krylo/tests/unit/state-io-transient.test.mjs` injects `EPERM`/`EBUSY` through the shared `node:fs` module object. Eleven of its sixteen tests fail against the previous code. They cover the reader retries, the persistent-busy classification, the `unreadable`-not-`corrupted` contract, the `saveState()` refusal, a 400ms rename window that the old budget lost, the bounded rename deadline, and the two pruning cases. The other five pin invariants that already held and must keep holding: non-transient errors and `ENOENT` are not retried, genuinely corrupt bytes are still preserved, and a genuinely gone run's pointer is still pruned.
- `plugins/krylo/tests/hooks/posttool-reload-failure.test.mjs` covers decision 6 on both hosts. It uses a test-only `--import` preload (`tests/fixtures/state-io/fail-state-rereads.mjs`) that fails every read of `state.json` after the hook's first. Both fault cases fail against the previous code; a control case without the fault passes on both.
- `plugins/krylo/tests/stress/state-io-contention.mjs` is the opt-in reproduction (not part of `npm test`). Unless noted, each row is 40 rounds x 6 parallel runs x 15 concurrent hooks with `npm test` looping alongside:

| Code | Runs | Runs that lost an increment | `counter-not-persisted` | Corrupt sidecars |
| --- | --- | --- | --- | --- |
| `main` at 8729ed7 | 240 | 8 (3.3%) | 8 | 0 |
| First version (1500ms rename budget) on 8729ed7 | 240 | 0 | 0 | 0 |
| First version, development repro, 60 rounds, three full `npm test` runs alongside | 360 | 0 | 0 | 0 |
| `main` at 17779f0 (includes ADR-0043) | 240 | 22 (9.2%) | 25 | 0 |
| This change (1000ms) on 17779f0 | 240 | 0 | 0 | 0 |

  Current `main` loses more often than 8729ed7 did. That is consistent with ADR-0043's run resolution reading `state.json` more often, which means more lock-free readers holding the file during a rename; this explanation was not measured separately. At the before-rates measured, the 840 consecutive clean runs across the three post-change rows would occur by chance with probability below 10^-10.

- `tests/hooks/concurrent-mutation.test.mjs` (posttool counters and SubagentStart ids) was run 50 times on each side with `npm test` looping alongside. It passed 50 of 50 times on `main` (8729ed7) and 50 of 50 on the first version of this change. That test fires 15 hooks at a single run, which is less contention than the stress script's six parallel runs. It did not reproduce the loss on this machine at this load, so it cannot by itself show the fix. The evidence for the fix is the stress script. The evidence for stability is that plus repeated clean full `npm test` runs: seven consecutive on the first version (923 passed, 0 failed, 1 skipped each) and three consecutive on a clean checkout of the final tree rebased on 17779f0 (961 passed, 0 failed, 1 skipped each).
- Lock waits were measured on the first version (1500ms rename budget) under the heaviest load. 197 lock acquisitions took longer than 1s (median 1.2s, slowest 2.4s), against 5 (slowest 1.2s) before. The increase is expected, because writes that previously failed fast now succeed after retrying while holding the lock. None timed out.
- An independent code review of the first version found no blocker. Its findings on the lock-budget arithmetic, the security wording, persistent `EPERM`, and the pruning sweep are folded into this record.

## Supersedes

None.

## Superseded by

None.
