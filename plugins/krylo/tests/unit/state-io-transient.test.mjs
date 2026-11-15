// Transient Windows sharing errors on run-state I/O (docs/adr/0044-transient-state-io-retry.md).
//
// Writer side: on Windows, renaming a temp file over state.json fails with
// EPERM while ANY other process has state.json open, and every Hook reads
// state.json lock-free at startup (resolveActiveRun). The old rename retry
// budget (5 attempts x 20ms) was shorter than that contention lasts under
// parallel hook load, so a locked mutator's saveState() threw and its update
// was lost (posttool-telemetry recorded counter-not-persisted).
//
// Reader side: readJson() mapped a transient EPERM/EBUSY to 'read-error',
// and loadState() then reported a live run as 'corrupted' and copied it
// aside as state.corrupt-<epoch>.json.
//
// Real timing cannot be forced deterministically, so these tests inject the
// fault through the shared `node:fs` module object that atomic.mjs and
// state.mjs call into.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomic, readJson } from '../../scripts/lib/atomic.mjs';
import { createInitialState, saveState, loadState } from '../../scripts/lib/state.mjs';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-transient-io-'));
}

function fsError(code) {
  const err = new Error(`${code}: injected`);
  err.code = code;
  return err;
}

function withTempDataRoot(fn) {
  const dir = mkTempDir();
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    return fn(dir);
  } finally {
    mock.restoreAll();
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fail reads of `target` with `code` for the first `times` calls, then
// delegate to the real implementation. Other paths are never affected.
function failReadsOf(target, code, times) {
  const real = fs.readFileSync;
  let calls = 0;
  mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(target)) {
      calls++;
      if (calls <= times) throw fsError(code);
    }
    return real.call(fs, p, ...rest);
  });
  return () => calls;
}

function newSavedRun(dir) {
  const state = createInitialState({ goalText: 'x', hostIdentity: { host: 'claude', hostSessionId: 's' }, projectDir: dir, lane: 'BUILD', risk: 'low' });
  assert.equal(saveState(state).ok, true);
  return { state, statePath: path.join(dir, 'runs', state.runId, 'state.json') };
}

// ---------------------------------------------------------------- reader

test('readJson retries a transient EPERM and returns the value once the file is readable', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({ a: 1 }));
    const calls = failReadsOf(filePath, 'EPERM', 3);
    const result = readJson(filePath);
    assert.deepEqual(result, { ok: true, value: { a: 1 } });
    assert.equal(calls(), 4);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson retries a transient EBUSY and returns the value once the file is readable', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({ b: 2 }));
    failReadsOf(filePath, 'EBUSY', 2);
    assert.deepEqual(readJson(filePath), { ok: true, value: { b: 2 } });
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson gives up on a persistent sharing error within its bounded budget and reports it as busy, not read-error', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({ c: 3 }));
    const calls = failReadsOf(filePath, 'EBUSY', Infinity);
    const t0 = Date.now();
    const result = readJson(filePath);
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'busy');
    assert.equal(result.code, 'EBUSY');
    assert.ok(calls() > 1, 'a transient error must be retried at least once');
    assert.ok(elapsed < 2000, `bounded retry must give up promptly, took ${elapsed}ms`);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson does not retry a non-transient read error', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({ d: 4 }));
    const calls = failReadsOf(filePath, 'EISDIR', Infinity);
    const result = readJson(filePath);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'read-error');
    assert.equal(calls(), 1);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson does not retry ENOENT', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'missing.json');
    const calls = failReadsOf(filePath, 'ENOENT', Infinity);
    assert.deepEqual(readJson(filePath), { ok: false, error: 'not-found' });
    assert.equal(calls(), 1);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState rides out a transient sharing error on state.json and returns the live run', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    failReadsOf(statePath, 'EPERM', 2);
    const loaded = loadState(state.runId);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.runId, state.runId);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')), []);
  });
});

test('loadState never records a persistent sharing error as corruption', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const before = fs.readFileSync(statePath, 'utf8');
    failReadsOf(statePath, 'EBUSY', Infinity);
    const loaded = loadState(state.runId);
    mock.restoreAll();

    assert.equal(loaded.ok, false);
    assert.notEqual(loaded.error, 'corrupted');
    assert.equal(loaded.error, 'unreadable');
    assert.equal(loaded.transient, true);
    assert.equal(loaded.recovered, undefined);
    assert.equal(loaded.corruptPath, undefined);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')), []);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);

    // Once the holder lets go, the very same run loads normally.
    const again = loadState(state.runId);
    assert.equal(again.ok, true);
  });
});

test('loadState reports a non-transient read failure as unreadable, not corrupted, and copies nothing aside', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    failReadsOf(statePath, 'EISDIR', Infinity);
    const loaded = loadState(state.runId);
    mock.restoreAll();
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'unreadable');
    assert.equal(loaded.transient, false);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')), []);
  });
});

test('loadState still preserves genuinely corrupt bytes as state.corrupt-*', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    fs.writeFileSync(statePath, '{ not json', 'utf8');
    const loaded = loadState(state.runId);
    assert.equal(loaded.error, 'corrupted');
    assert.ok(fs.existsSync(loaded.corruptPath));
  });
});

test('saveState does not mistake a transient read of the existing state for "no prior file"', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    // Persistent sharing error on the pre-save read: the save must refuse
    // rather than proceed as if no file existed (which would skip the
    // pre-migration backup decision on a false premise).
    failReadsOf(statePath, 'EBUSY', Infinity);
    const saved = saveState(state);
    mock.restoreAll();
    assert.equal(saved.ok, false);
    assert.equal(saved.error, 'state-unreadable');

    // A short-lived one is ridden out and the save succeeds.
    failReadsOf(statePath, 'EPERM', 2);
    const savedAfter = saveState(state);
    mock.restoreAll();
    assert.equal(savedAfter.ok, true);
  });
});

// ---------------------------------------------------------------- writer

function failRenamesOnto(target, code, { forMs = Infinity, times = Infinity } = {}) {
  const real = fs.renameSync;
  const t0 = Date.now();
  let calls = 0;
  mock.method(fs, 'renameSync', function (from, to) {
    if (path.resolve(String(to)) === path.resolve(target)) {
      calls++;
      if (calls <= times && Date.now() - t0 < forMs) throw fsError(code);
    }
    return real.call(fs, from, to);
  });
  return () => calls;
}

test('writeJsonAtomic outlasts a sharing window longer than the old 5 x 20ms rename budget', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    writeJsonAtomic(filePath, { v: 1 });
    // A reader-held window of 400ms: the previous fixed budget gave up after
    // roughly 100ms and threw, losing the write.
    failRenamesOnto(filePath, 'EPERM', { forMs: 400 });
    writeJsonAtomic(filePath, { v: 2 });
    mock.restoreAll();
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { v: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic gives up on a persistent sharing error within a bounded deadline and cleans its temp file', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    writeJsonAtomic(filePath, { v: 1 });
    const calls = failRenamesOnto(filePath, 'EBUSY');
    const t0 = Date.now();
    assert.throws(() => writeJsonAtomic(filePath, { v: 2 }), (err) => err.code === 'EBUSY');
    const elapsed = Date.now() - t0;
    mock.restoreAll();
    assert.ok(calls() > 5, `expected more than the old 5 attempts, got ${calls()}`);
    assert.ok(elapsed < 5000, `rename retry must stay bounded, took ${elapsed}ms`);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { v: 1 });
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic does not retry a non-transient rename error', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    writeJsonAtomic(filePath, { v: 1 });
    const calls = failRenamesOnto(filePath, 'EXDEV');
    assert.throws(() => writeJsonAtomic(filePath, { v: 2 }), (err) => err.code === 'EXDEV');
    mock.restoreAll();
    assert.equal(calls(), 1);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
