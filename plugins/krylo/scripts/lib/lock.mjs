// Cross-process mutual exclusion for one run's state, built on the same
// exclusive-create primitive as a Unix/Windows-portable file lock: opening a
// file with the 'wx' flag fails atomically if the file already exists.
//
// Used to make risk-approval consumption safe under concurrent PreToolUse
// invocations for the same run (two tool calls racing to spend the same
// single-use approval must never both succeed).

import fs from 'node:fs';
import path from 'node:path';

// The lock wait is bounded by a monotonic wall-clock deadline
// (docs/adr/0046-unreadable-state-followups-and-lock-deadline.md), the same
// way atomic.mjs's withTransientRetry() bounds its retries. It used to be a
// fixed 600 attempts of a nominal 10ms pause: about 6s on POSIX, but
// 10.7-10.8s measured on Windows, where the timer stretches each pause to
// ~16ms (docs/adr/0045-transient-state-io-retry.md). A count has no
// wall-clock meaning; a deadline does.
//
// Why 8000ms. Upper bound: the tightest lock users are the 15s PostToolUse,
// PostToolUseFailure, and SubagentStart/SubagentStop hooks
// (posttool-telemetry, fingerprint, agent-events). Their worst case is Node
// startup and run lookup (measured on Windows under the heaviest stress
// load: p99 834ms, max 1029ms), blocked reads in that lookup (up to ~500ms
// more), this wait, and their own hold of up to ~1.5s (ADR-0045): about 11s.
// A hook that waits the full budget still finishes its hold with about 4s to
// spare, so it is not killed while holding the lock (which would orphan it,
// see below). Lower bound: the slowest lock acquisition measured under the
// heaviest load was 3.25s of 14,400 (ADR-0046), and an earlier budget of 200 x 10ms
// (nominally 2s, more on Windows) failed on a shared Windows CI runner with
// 12 processes racing for one run's lock. 8000ms is about 2.5x the slowest
// measured wait. This shortens the effective wait on Windows (~10.8s -> 8s)
// and lengthens it on POSIX (~6s -> 8s). The question gate (30s) and the
// Stop gates (60s) have more room; the risk gate takes no lock.
const LOCK_WAIT_BUDGET_MS = 8000;
const LOCK_RETRY_DELAY_MS = 10;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable in this embedder; proceed without the pause
    // rather than fail the retry loop (worst case: a busier spin).
  }
}

// EEXIST is the expected, documented contention signal (another holder's
// lock file is still there). On Windows, two independent security reviews
// of a security-hardening checkpoint reproduced a second, real contention
// shape: opening a lock path whose previous holder's fs.rmSync (below) has
// just marked it delete-pending can fail with EPERM instead of EEXIST --
// and, more rarely, EACCES/EBUSY from the same underlying delete-pending
// window. Before this fix, any of those three codes rethrew immediately
// instead of retrying, so a waiter arriving in that narrow window threw a
// lock-acquisition error -- and every caller that wraps withFileLock in a
// fail-open `catch {}` (posttool-telemetry.mjs, orbit/fingerprint.mjs,
// status/agent-events.mjs) silently discarded its mutation with exit 0,
// observed as an intermittent lost-increment failure under real 15-way
// concurrent load. atomic.mjs's writeJsonAtomic() already treats this same
// EPERM/EBUSY pair as transient for the analogous rename case; this applies
// the identical, already-established reasoning to lock acquisition.
const TRANSIENT_LOCK_ERROR_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * Run `fn` while holding an exclusive lock at `lockPath`. Blocks (busy-wait)
 * until the lock is acquired or LOCK_WAIT_BUDGET_MS of monotonic wall-clock
 * time has passed, then throws lock-timeout. The last attempt is made at the
 * deadline. The lock file is always removed afterward, success or failure.
 */
export function withFileLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // performance.now() is monotonic: a wall-clock adjustment mid-wait can
  // neither extend nor cut short the budget.
  const deadline = performance.now() + LOCK_WAIT_BUDGET_MS;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (!err || !TRANSIENT_LOCK_ERROR_CODES.has(err.code)) throw err;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      sleepSync(Math.min(LOCK_RETRY_DELAY_MS, remaining));
    }
  }
  if (fd === undefined) {
    throw new Error(`lock-timeout: ${lockPath}`);
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed; ignore
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // This module has NO staleness/PID/mtime recovery: if this cleanup
      // removal itself fails (or this process is killed before reaching
      // here at all), the lock file is left behind, and every LATER
      // fs.openSync(lockPath, 'wx') above will keep hitting EEXIST until
      // the full LOCK_WAIT_BUDGET_MS budget is exhausted and throws
      // lock-timeout -- not a harmless "recreate on next acquire" (an
      // earlier version of this comment claimed that; it was wrong, and a
      // fresh independent Security Reviewer live-reproduced the real
      // consequence: a subsequent caller blocked for the full retry window,
      // then about 6s, and then failed). This is an accepted, disclosed residual
      // for this specific narrow best-effort cleanup path, not a claim
      // that an orphaned lock is safe.
    }
  }
}
