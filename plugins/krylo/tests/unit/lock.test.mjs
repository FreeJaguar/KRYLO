import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock } from '../../scripts/lib/lock.mjs';

function withTempLockPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-lock-test-'));
  try {
    return fn(path.join(dir, '.state.lock'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('withFileLock acquires normally when the lock file does not exist', () => {
  withTempLockPath((lockPath) => {
    const result = withFileLock(lockPath, () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(fs.existsSync(lockPath), false, 'the lock file must be removed after release');
  });
});

test('withFileLock retries on EEXIST (genuine contention) until the lock is released', () => {
  // sleepSync() blocks the event loop synchronously (Atomics.wait), so a
  // real setTimeout-based release could never fire during the retry loop
  // in this single-threaded test process -- mock the transient contention
  // instead, the same way the EPERM/EACCES/EBUSY test below does.
  withTempLockPath((lockPath) => {
    const realOpenSync = fs.openSync;
    let attempts = 0;
    mock.method(fs, 'openSync', (target, ...rest) => {
      if (target === lockPath && attempts < 3) {
        attempts += 1;
        const err = new Error('simulated EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return realOpenSync.call(fs, target, ...rest);
    });

    try {
      const result = withFileLock(lockPath, () => 'ok');
      assert.equal(result, 'ok');
      assert.equal(attempts, 3);
    } finally {
      mock.restoreAll();
    }
  });
});

test('withFileLock retries on EPERM/EACCES/EBUSY, not just EEXIST -- a real Windows delete-pending race', () => {
  // Two independent security reviews of this checkpoint reproduced a real
  // bug: on Windows, opening a lock file whose previous holder's fs.rmSync
  // has just marked it delete-pending can fail with EPERM (not EEXIST).
  // The retry loop previously rethrew immediately on any code other than
  // EEXIST, so a waiter arriving in that narrow window threw a
  // lock-timeout-shaped error instead of retrying -- and every caller that
  // wraps withFileLock in a fail-open `catch {}` (posttool-telemetry.mjs,
  // fingerprint.mjs, agent-events.mjs) silently dropped its mutation.
  withTempLockPath((lockPath) => {
    const realOpenSync = fs.openSync;
    let attempts = 0;
    mock.method(fs, 'openSync', (target, ...rest) => {
      if (target === lockPath && attempts < 3) {
        attempts += 1;
        const codes = ['EPERM', 'EACCES', 'EBUSY'];
        const err = new Error(`simulated ${codes[attempts - 1]}`);
        err.code = codes[attempts - 1];
        throw err;
      }
      return realOpenSync.call(fs, target, ...rest);
    });

    try {
      const result = withFileLock(lockPath, () => 'ok');
      assert.equal(result, 'ok');
      assert.equal(attempts, 3, 'expected exactly the three simulated transient errors before a real acquire');
    } finally {
      mock.restoreAll();
    }
  });
});

test('withFileLock still throws immediately on a genuinely unexpected error code', () => {
  withTempLockPath((lockPath) => {
    const realOpenSync = fs.openSync;
    mock.method(fs, 'openSync', (target, ...rest) => {
      if (target === lockPath) {
        const err = new Error('simulated unexpected failure');
        err.code = 'ENOSPC';
        throw err;
      }
      return realOpenSync.call(fs, target, ...rest);
    });

    try {
      assert.throws(() => withFileLock(lockPath, () => 'ok'), /ENOSPC|simulated unexpected failure/);
    } finally {
      mock.restoreAll();
    }
  });
});
