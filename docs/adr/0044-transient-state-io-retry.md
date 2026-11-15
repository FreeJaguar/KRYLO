# ADR-0044: Retry transient sharing errors on run-state I/O, and never record them as corruption

## Status

Accepted

## Context

KRYLO's Hooks share one run's state through `runs/<id>/state.json`. Writers use temp-file-plus-rename (`scripts/lib/atomic.mjs`) inside the run's exclusive lock (`scripts/lib/lock.mjs`); readers are deliberately lock-free, and every Hook reads `state.json` once at startup to resolve its run (`resolveActiveRun()` in `scripts/lib/hook-utils.mjs`).

Two weaknesses were reported together. First, under parallel hook load on Windows, `posttool-telemetry.mjs` occasionally lost a tool-counter increment and recorded `counter-not-persisted`, and the concurrency tests in `tests/hooks/concurrent-mutation.test.mjs` failed intermittently under full-suite load. Second, `readJson()` did not retry a transient sharing error, and `loadState()` then reported a live run as `corrupted` and copied it aside.

### Root cause, measured

All measurements are on the development machine (Windows 11, Node 24.17.0), with temporary measurement-only instrumentation that was never committed.

1. **Mechanism.** On Windows, renaming a file over an existing target (`MoveFileEx` with replace, which is what `fs.renameSync` uses) fails with `EPERM` while any other process holds the target open, even though Node opens every file with full sharing (`FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`). A micro-benchmark with one writer and no readers saw 42 `EPERM` rename failures in 2008 renames (antivirus or indexer opening the new file); with a single reader process looping on the target, the writer's renames failed 289 times in 4 seconds, and with 4 or more readers it starved for over 4 seconds. Readers never saw an error in any configuration.
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

1. `writeJsonAtomic()` retries a rename that fails with `EPERM` or `EBUSY` until a **1500ms wall-clock deadline**, with jittered exponential backoff (4ms doubling, capped at 50ms, each pause drawn from the upper half of its interval). Each attempt is still a single rename, so atomicity is unchanged. Any other error code fails immediately, and the temp file is always removed on failure.
2. Every state read (`readJson()`, and `saveState()`'s pre-write read through the new `readFileWithRetry()`) retries `EPERM` or `EBUSY` until a **250ms deadline** with the same backoff. `ENOENT` and every other code fail immediately. The read budget is short because some callers read many small files in a loop (active-run pointer scans).
3. `readJson()` reports a sharing error that outlasts its budget as `{ ok: false, error: 'busy', code }`, distinct from `read-error` (a non-transient fs failure) and `parse-error` (bytes were read and are not JSON).
4. **Corruption is a property of bytes that were actually read.** `loadState()` reports `busy` and `read-error` as `{ ok: false, error: 'unreadable', transient, code }` and never copies the file aside. Only `parse-error` and a schema-invalid document are `corrupted` and preserved as `state.corrupt-<epoch>.json`.
5. `saveState()` treats only `ENOENT` as "no prior file". A present-but-unreadable file refuses the save with `{ ok: false, error: 'state-unreadable' }`.
6. `posttool-telemetry.mjs` and its Codex counterpart `posttool-telemetry-codex.mjs` record `counter-not-persisted` when their reload under the lock fails, instead of returning as if the increment had been saved.

The budgets are sized from the measurements above: 1500ms is roughly seven times the slowest contended rename that succeeded, and 250ms covers a scanner's brief hold. The two budgets are deliberately independent of `lock.mjs`, whose retry budget was not the cause and is unchanged.

## Consequences

- The lost-update failure is removed at its cause for every mutator, not only `posttool-telemetry.mjs`, because all of them persist through `writeJsonAtomic()`. Evidence is recorded in the verification section below.
- **Lock hold time.** A writer can now hold the run lock for up to 1.5s longer in the worst case while retrying its rename. Measured contended renames finish in tens of milliseconds, and the lock waiters' 6s budget and the 15s `PostToolUse`/`SubagentStart` hook timeouts both leave room. A rename that keeps failing for the full deadline still fails and is surfaced exactly as before (`counter-not-persisted` for telemetry, an error for a CLI mutator).
- **No caller behavior changes for a failed load.** No caller in `scripts/` branches on `error === 'corrupted'`, `recovered`, or `corruptPath`; all of them branch on `ok`. A failure that used to say `corrupted` now says `unreadable`, and every security gate takes the same fail-safe path it took before.
- **Security.** No gate is weakened: an unreadable state is still never trusted, never fabricated, and never overwritten. What changes is that an I/O failure no longer leaves a misleading `state.corrupt-*` artifact or a false corruption report. The retry adds no new input surface and reads no new paths.
- **Cross-platform.** On macOS and Linux `rename(2)` replaces an open target, so the rename retry is normally never exercised there. `EPERM` on a POSIX read is a real permission error; it costs at most the 250ms read budget before being reported as `unreadable`.
- **Residual.** A process that holds `state.json` open without sharing for longer than the budgets still makes the write or the read fail, now reported accurately instead of as corruption. The reader-side fix is verified by deterministic fault injection only, because no reader error was reproduced live on this machine.

## Verification

- `plugins/krylo/tests/unit/state-io-transient.test.mjs` injects `EPERM`/`EBUSY` through the shared `node:fs` module object. Nine of its thirteen tests fail against the previous code: the reader retries, the persistent-busy classification, the `unreadable`-not-`corrupted` contract, the `saveState()` refusal, a 400ms rename window that the old budget lost, and the bounded rename deadline. The other four pin invariants that already held and must keep holding: non-transient errors and `ENOENT` are not retried, and genuinely corrupt bytes are still preserved.
- `plugins/krylo/tests/stress/state-io-contention.mjs` is the opt-in reproduction (not part of `npm test`). Results before and after this change:

| Code | Load | Runs (each 15 concurrent hooks) | Runs that lost an increment | `counter-not-persisted` | Corrupt sidecars |
| --- | --- | --- | --- | --- | --- |
| `main` (8729ed7) | stress script, 40 rounds x 6 parallel runs, `npm test` looping alongside | 240 | 8 (3.3%) | 8 | 0 |
| This change | same | 240 | 0 | 0 | 0 |
| This change | development repro, 60 rounds x 6 parallel runs, three full `npm test` runs alongside | 360 | 0 | 0 | 0 |

  At the measured before-rate, 600 consecutive clean runs would occur by chance with probability below 10^-8.
- Lock waits under the heaviest load above: with the fix, 197 lock acquisitions took longer than 1s (median 1.2s, slowest 2.4s), against 5 (slowest 1.2s) before. The increase is expected, since writes that previously failed fast now succeed after retrying while holding the lock. No acquisition timed out, and the slowest stayed under half of the lock's 6s budget.

## Supersedes

None.

## Superseded by

None.
