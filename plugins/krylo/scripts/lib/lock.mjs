// Cross-process mutual exclusion for one run's state, built on the same
// exclusive-create primitive as a Unix/Windows-portable file lock: opening a
// file with the 'wx' flag fails atomically if the file already exists.
//
// Used to make risk-approval consumption safe under concurrent PreToolUse
// invocations for the same run (two tool calls racing to spend the same
// single-use approval must never both succeed).

import fs from 'node:fs';
import path from 'node:path';

// 600 attempts x 10ms nominal. Observed a real failure at the prior
// 200*10ms budget under heavier contention on a shared CI Windows runner
// (12 processes racing for one run's lock) that never reproduced on a local
// dev machine -- adequate for a lightly-loaded box but not for a
// slower/noisier shared runner.
//
// The nominal 6s is not the wall-clock budget on Windows: the timer behind
// sleepSync() stretches each 10ms pause to ~16ms there, and an independent
// review measured a waiter on a held lock giving up after 10.7-10.8s
// (docs/adr/0045-transient-state-io-retry.md). The tightest callers are the
// 15s PostToolUse, PostToolUseFailure, and SubagentStart/SubagentStop hooks
// (posttool-telemetry, fingerprint, agent-events): Node startup, their
// lock-free run lookup, this wait, and their own hold of up to ~1.5s
// (ADR-0045) come to roughly 13s in the worst case. The question gate (30s)
// and the Stop gates (60s) have more room; the risk gate takes no lock.
const LOCK_RETRY_ATTEMPTS = 600;
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
 * until the lock is acquired or the retry budget is exhausted, then throws.
 * The lock file is always removed afterward, success or failure.
 */
export function withFileLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let fd;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (!err || !TRANSIENT_LOCK_ERROR_CODES.has(err.code)) throw err;
      sleepSync(LOCK_RETRY_DELAY_MS);
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
      // the full LOCK_RETRY_ATTEMPTS budget is exhausted and throws
      // lock-timeout -- not a harmless "recreate on next acquire" (an
      // earlier version of this comment claimed that; it was wrong, and a
      // fresh independent Security Reviewer live-reproduced the real
      // consequence: a subsequent caller blocked for the full ~6s retry
      // window and then failed). This is an accepted, disclosed residual
      // for this specific narrow best-effort cleanup path, not a claim
      // that an orphaned lock is safe.
    }
  }
}
