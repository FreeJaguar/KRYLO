// Cross-process mutual exclusion for one run's state, built on the same
// exclusive-create primitive as a Unix/Windows-portable file lock: opening a
// file with the 'wx' flag fails atomically if the file already exists.
//
// Used to make risk-approval consumption safe under concurrent PreToolUse
// invocations for the same run (two tool calls racing to spend the same
// single-use approval must never both succeed).

import fs from 'node:fs';
import path from 'node:path';

// 600 * 10ms = 6s worst-case wait. Observed a real failure at the prior
// 200*10ms (2s) budget under heavier contention on a shared CI Windows
// runner (12 processes racing for one run's lock) that never reproduced on
// a local dev machine -- 2s was adequate for a lightly-loaded box but not
// for a slower/noisier shared runner. 6s stays comfortably under the 30s
// PreToolUse hook timeout (skills/run/SKILL.md) that scripts/security/
// risk-gate.mjs's own use of this lock must fit inside.
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
// concurrent load. atomic.mjs's renameWithRetry() already treats this same
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
      // best-effort: a stale lock file is harmless (next acquire recreates it)
    }
  }
}
