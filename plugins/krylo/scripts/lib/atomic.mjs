// Atomic JSON persistence helpers.
//
// Writes go to a temp file in the same directory, are fsynced when the
// platform supports it, then renamed over the target. Readers never receive
// a raw fs error; failures are reported as a discriminated result object.
//
// Transient sharing errors (docs/adr/0045-transient-state-io-retry.md).
// On Windows, replacing a file by rename fails with EPERM while ANY other
// process holds the target open, even briefly -- including a plain Node
// fs.readFileSync in another process (measured, ADR-0045). Antivirus,
// indexers, and -- most often -- KRYLO's own lock-free readers (every Hook
// reads state.json at startup to resolve its run) all open it. A sharing violation from a holder that
// denies sharing surfaces as EBUSY. Both are retried here against a
// wall-clock deadline with jittered exponential backoff; every other error
// code is a real failure and is surfaced immediately.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY']);

// Rename budget. Measured under 15-way concurrent posttool-telemetry load,
// six runs in parallel, with the full test suite running alongside
// (ADR-0045): a contended rename that eventually succeeded needed a median
// of ~40ms, a p99 of ~160ms and at most 204ms, and the old fixed budget (5
// attempts x 20ms, 113-151ms of wall clock in practice) gave up on that
// tail, losing the write. An independent re-run with every fs error traced
// saw a longer tail: from first to last EPERM within one hook, p99 384ms and
// at most 597ms. So 1000ms leaves well under 2x headroom over the slowest
// rename seen, not a wide margin.
//
// The budget is spent while HOLDING the run lock, so it cannot grow freely.
// A state mutation holds the lock for up to three bounded operations
// (loadState's read, saveState's pre-read, this rename: ~1.5s); a terminal
// transition adds clearActiveRunPointer()'s pointer read (~1.75s), but runs
// only from update-state.mjs and the 60s Stop gates. lock.mjs's wait is
// bounded by an 8000ms wall-clock deadline (ADR-0046), so a 15s
// PostToolUse/SubagentStart hook's worst case (startup, lock-free lookup,
// lock wait, hold) is roughly 11s.
//
// On POSIX, rename(2) replaces an open target, so this retry is normally
// never exercised there; an EPERM/EBUSY that does occur there (a permission
// or mount problem) is persistent and costs at most this budget before it
// is surfaced. The same holds for a Windows read-only or ACL-denied file,
// which also reports EPERM and cannot be told apart from a sharing error.
const RENAME_RETRY_BUDGET_MS = 1000;

// Read budget. Readers share access with each other, so only a holder that
// denies sharing (or a delete-pending file) can block one; keep this short
// because some callers read many small files in a loop (pointer scans).
const READ_RETRY_BUDGET_MS = 250;

const RETRY_BASE_DELAY_MS = 4;
const RETRY_MAX_DELAY_MS = 50;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable (e.g. on the main thread in some embedders);
    // skip the pause rather than fail the retry loop.
  }
}

// Exponential backoff with jitter in [ceiling/2, ceiling]: contending
// writers that collided once do not retry in lockstep again.
function retryDelayMs(attempt) {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * Run a synchronous fs operation, retrying only a transient sharing error
 * (EPERM/EBUSY) until `budgetMs` of wall-clock time has elapsed. Any other
 * error, or the last transient error once the budget is spent, is thrown
 * unchanged.
 */
function withTransientRetry(op, budgetMs) {
  // performance.now() is monotonic: a wall-clock adjustment mid-retry can
  // neither extend nor cut short the budget.
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!err || !TRANSIENT_FS_CODES.has(err.code)) throw err;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw err;
      sleepSync(Math.min(retryDelayMs(attempt), remaining));
    }
  }
}

/** True for an fs error code this module treats as a transient sharing error. */
export function isTransientFsError(err) {
  return Boolean(err && TRANSIENT_FS_CODES.has(err.code));
}

/**
 * True when the error proves the file does not exist: ENOENT, or ENOTDIR (a
 * path component is a file, so nothing can exist below it -- what POSIX
 * reports where Windows reports ENOENT). Never a read failure of a file that
 * is there (ADR-0045).
 */
export function isAbsentFsError(err) {
  return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
}

/**
 * Read a file as UTF-8, riding out a transient sharing error within the
 * read budget. Throws the underlying fs error otherwise (ENOENT included),
 * so a caller can tell "absent" (isAbsentFsError) from "present but
 * unreadable".
 */
export function readFileWithRetry(filePath) {
  return withTransientRetry(() => fs.readFileSync(filePath, 'utf8'), READ_RETRY_BUDGET_MS);
}

/**
 * Write `obj` as JSON to `filePath` atomically.
 * Creates the parent directory if needed. Throws only if the write/rename
 * itself fails after cleanup of the temp file; callers that need a
 * non-throwing variant should wrap this call.
 */
export function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString('hex')}`,
  );
  const json = JSON.stringify(obj, null, 2);

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync unsupported on this platform/filesystem; best effort only.
      }
    } finally {
      fs.closeSync(fd);
    }
    // Each attempt is still a single rename call, so atomicity is
    // unaffected by retrying: readers see the old file or the new one.
    withTransientRetry(() => fs.renameSync(tmpPath, filePath), RENAME_RETRY_BUDGET_MS);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort temp-file cleanup
    }
    throw err;
  }

  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } catch {
      // directory fsync unsupported (e.g. Windows)
    }
    fs.closeSync(dirFd);
  } catch {
    // opening the directory for fsync is not always possible; ignore.
  }

  return filePath;
}

/**
 * Read and parse a JSON file without throwing.
 * Returns { ok: true, value } on success, or
 * { ok: false, error: 'not-found' | 'busy' | 'read-error' | 'parse-error', code?, raw? }.
 *
 * 'busy' means a transient sharing error outlasted the read budget: the
 * file exists and nothing is known to be wrong with its contents. It is
 * deliberately distinct from 'read-error' (a non-transient fs failure) and
 * from 'parse-error' (bytes were read and are not JSON) -- only the last is
 * evidence about the file's contents.
 */
export function readJson(filePath) {
  let raw;
  try {
    raw = readFileWithRetry(filePath);
  } catch (err) {
    if (isAbsentFsError(err)) {
      return { ok: false, error: 'not-found' };
    }
    return { ok: false, error: isTransientFsError(err) ? 'busy' : 'read-error', code: err?.code ?? null };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'parse-error', raw };
  }
}
