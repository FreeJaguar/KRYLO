// Atomic JSON persistence helpers.
//
// Writes go to a temp file in the same directory, are fsynced when the
// platform supports it, then renamed over the target. Readers never receive
// a raw fs error; failures are reported as a discriminated result object.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Windows can transiently deny a rename onto an existing file (EPERM/EBUSY)
// when antivirus or an indexer briefly holds the target open. Retrying a
// handful of times with a short synchronous pause makes the atomic write
// robust to that without weakening atomicity (each attempt is still a
// single rename call).
const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 20;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable (e.g. on the main thread in some embedders);
    // skip the pause rather than fail the retry loop.
  }
}

function renameWithRetry(tmpPath, filePath) {
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY');
      if (!transient || attempt === RENAME_RETRY_ATTEMPTS) throw err;
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
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
    renameWithRetry(tmpPath, filePath);
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
 * { ok: false, error: 'not-found' | 'read-error' | 'parse-error', raw? }.
 */
export function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, error: 'not-found' };
    }
    return { ok: false, error: 'read-error' };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'parse-error', raw };
  }
}
