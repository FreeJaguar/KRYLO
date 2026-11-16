// Transient Windows sharing errors on run-state I/O (docs/adr/0045-transient-state-io-retry.md).
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
import {
  createInitialState,
  saveState,
  loadState,
  writeActiveRunPointer,
  pruneStaleActiveRunPointers,
  computeProjectRootHash,
  locateActiveRunPointer,
} from '../../scripts/lib/state.mjs';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-transient-io-'));
}

function fsError(code) {
  const err = new Error(`${code}: injected`);
  err.code = code;
  return err;
}

function withTempDataRoot(fn) {
  // Real path: state.mjs builds run paths from the realpath of the data root
  // (paths.mjs safeJoin), so on macOS (/var -> /private/var) a fault keyed
  // on the unresolved temp path would never match.
  const dir = fs.realpathSync(mkTempDir());
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

// ------------------------------------------------------- pointer pruning

function activePointerFor(dir, state) {
  const projectRootHash = computeProjectRootHash(dir);
  writeActiveRunPointer({ runId: state.runId, projectRootHash, host: 'claude', hostSessionId: 's' });
  const root = path.join(dir, 'active-runs');
  const pointerPath = path.join(root, projectRootHash, 'claude', 's.json');
  assert.ok(fs.existsSync(pointerPath), 'fixture pointer written');
  return { root, pointerPath };
}

test('pruning keeps the pointer of a live run whose state.json is only transiently unreadable', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    failReadsOf(statePath, 'EBUSY', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath), 'a live run must not be switched off by a sharing error');
  });
});

test('pruning keeps a pointer file that is itself only transiently unreadable', () => {
  withTempDataRoot((dir) => {
    const { state } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    failReadsOf(pointerPath, 'EPERM', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath));
  });
});

test('pruning still removes the pointer of a run that is genuinely gone', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    fs.rmSync(statePath);
    const removed = pruneStaleActiveRunPointers(root);
    assert.equal(removed.length, 1);
    assert.ok(!fs.existsSync(pointerPath));
  });
});

// Pruning deletes only on positive evidence that the run is over.

test('pruning keeps the pointer of a live run whose state.json fails with a non-transient read error', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    failReadsOf(statePath, 'EISDIR', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath), '"could not read the state" is not evidence that the run is over');
  });
});

test('pruning keeps a pointer file that fails with a non-transient read error', () => {
  withTempDataRoot((dir) => {
    const { state } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    failReadsOf(pointerPath, 'EISDIR', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath));
  });
});

test('pruning keeps the pointer of a run whose state uses a schema version this build cannot load', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    const doc = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.writeFileSync(statePath, JSON.stringify({ ...doc, schemaVersion: '99.0.0' }), 'utf8');
    const loaded = loadState(state.runId);
    assert.equal(loaded.ok, false);
    assert.ok(!['corrupted', 'not-found', 'unreadable'].includes(loaded.error), `fixture must hit the unsupported-schema path, got ${loaded.error}`);

    const removed = pruneStaleActiveRunPointers(root);
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath), 'a newer build may still own this run');
  });
});

test('pruning still removes a pointer file that is not valid JSON', () => {
  withTempDataRoot((dir) => {
    const { state } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, state);
    fs.writeFileSync(pointerPath, '{ not json', 'utf8');
    const removed = pruneStaleActiveRunPointers(root);
    assert.equal(removed.length, 1);
    assert.ok(!fs.existsSync(pointerPath));
  });
});

test('pruning does not delete a pointer that was rewritten for a new run after it was judged stale', () => {
  withTempDataRoot((dir) => {
    const { state: oldRun, statePath: oldStatePath } = newSavedRun(dir);
    const { root, pointerPath } = activePointerFor(dir, oldRun);
    fs.rmSync(oldStatePath); // the run the pointer names is gone: stale
    const { state: newRun } = newSavedRun(dir);
    const rewritten = JSON.stringify({ runId: newRun.runId, projectRootHash: computeProjectRootHash(dir), host: 'claude', hostSessionId: 's', updatedAt: new Date().toISOString() });

    // Between the first read (stale verdict) and the delete, the session
    // starts a new run and its pointer is rewritten.
    const real = fs.readFileSync;
    let pointerReads = 0;
    mock.method(fs, 'readFileSync', function (p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(pointerPath)) {
        pointerReads++;
        if (pointerReads === 2) fs.writeFileSync(pointerPath, rewritten, 'utf8');
      }
      return real.call(fs, p, ...rest);
    });
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();

    assert.ok(pointerReads >= 2, 'the pointer must be re-read before it is deleted');
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(pointerPath), 'the new run\'s pointer must survive');
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).runId, newRun.runId);
  });
});

function legacyFlatPointerFor(dir, state) {
  const projectRootHash = computeProjectRootHash(dir);
  const root = path.join(dir, 'active-runs');
  const legacyPath = path.join(root, projectRootHash, 's.json');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ runId: state.runId, projectRootHash, sessionId: 's', updatedAt: new Date().toISOString() }), 'utf8');
  return { root, legacyPath, migratedPath: path.join(root, projectRootHash, 'claude', 's.json') };
}

test('pruning leaves a legacy flat pointer alone while the state it names is transiently unreadable', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, legacyPath, migratedPath } = legacyFlatPointerFor(dir, state);
    failReadsOf(statePath, 'EBUSY', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(legacyPath), 'neither deleted nor migrated on an unreadable state');
    assert.ok(!fs.existsSync(migratedPath));
  });
});

test('pruning leaves a legacy flat pointer alone while the state it names fails with a non-transient read error', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    const { root, legacyPath } = legacyFlatPointerFor(dir, state);
    failReadsOf(statePath, 'EISDIR', Infinity);
    const removed = pruneStaleActiveRunPointers(root);
    mock.restoreAll();
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(legacyPath));
  });
});

test('control: pruning still migrates a readable live legacy flat pointer into the claude host directory', () => {
  withTempDataRoot((dir) => {
    const { state } = newSavedRun(dir);
    const { root, legacyPath, migratedPath } = legacyFlatPointerFor(dir, state);
    const removed = pruneStaleActiveRunPointers(root);
    assert.deepEqual(removed, []);
    assert.ok(!fs.existsSync(legacyPath));
    assert.equal(JSON.parse(fs.readFileSync(migratedPath, 'utf8')).runId, state.runId);
  });
});

// ------------------------------------------------- run resolution (gates)

test('locateActiveRunPointer reports an unreadable state as indeterminate, never as "no run"', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    activePointerFor(dir, state);
    failReadsOf(statePath, 'EBUSY', Infinity);
    const found = locateActiveRunPointer({ projectRoot: dir, host: 'claude', hostSessionId: 's', requireActive: true });
    mock.restoreAll();
    assert.equal(found.ok, false);
    assert.equal(found.error, 'run-state-unreadable');
    assert.equal(found.indeterminate, true);
    assert.equal(found.reason, 'state-unreadable');
    assert.equal(found.runId, state.runId);
    assert.equal(found.transient, true);
  });
});

test('locateActiveRunPointer reports this session\'s unreadable pointer as indeterminate', () => {
  withTempDataRoot((dir) => {
    const { state } = newSavedRun(dir);
    const { pointerPath } = activePointerFor(dir, state);
    failReadsOf(pointerPath, 'EPERM', Infinity);
    const found = locateActiveRunPointer({ projectRoot: dir, host: 'claude', hostSessionId: 's', requireActive: true });
    mock.restoreAll();
    assert.equal(found.error, 'run-state-unreadable');
    assert.equal(found.reason, 'pointer-unreadable');
    assert.equal(found.runId, null);
  });
});

test('locateActiveRunPointer session scan: a hook still gates on a readable live run, a mutating CLI refuses to guess', () => {
  withTempDataRoot((dir) => {
    const projectA = fs.realpathSync(mkTempDir());
    const projectB = fs.realpathSync(mkTempDir());
    const elsewhere = fs.realpathSync(mkTempDir());
    try {
      const runFor = (projectDir) => {
        const s = createInitialState({ goalText: 'x', hostIdentity: { host: 'claude', hostSessionId: 's' }, projectDir, lane: 'BUILD', risk: 'low' });
        assert.equal(saveState(s).ok, true);
        writeActiveRunPointer({ runId: s.runId, projectRootHash: computeProjectRootHash(projectDir), host: 'claude', hostSessionId: 's' });
        return s;
      };
      const readable = runFor(projectA);
      const unreadable = runFor(projectB);
      failReadsOf(path.join(dir, 'runs', unreadable.runId, 'state.json'), 'EBUSY', Infinity);

      const hook = locateActiveRunPointer({ projectRoot: elsewhere, host: 'claude', hostSessionId: 's', requireActive: true });
      assert.equal(hook.ok, true);
      assert.equal(hook.state.runId, readable.runId);

      const cli = locateActiveRunPointer({ projectRoot: elsewhere, host: 'claude', hostSessionId: 's', requireActive: true, ambiguity: 'fail' });
      assert.equal(cli.ok, false);
      assert.equal(cli.error, 'run-state-unreadable');
    } finally {
      mock.restoreAll();
      for (const d of [projectA, projectB, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

test('control: a session with no pointer of its own is still "no run", not indeterminate', () => {
  withTempDataRoot((dir) => {
    const { state, statePath } = newSavedRun(dir);
    activePointerFor(dir, state); // session 's'
    failReadsOf(statePath, 'EBUSY', Infinity);
    const found = locateActiveRunPointer({ projectRoot: dir, host: 'claude', hostSessionId: 'another-session', requireActive: true });
    mock.restoreAll();
    assert.deepEqual(found, { ok: false, error: 'not-found' });
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
