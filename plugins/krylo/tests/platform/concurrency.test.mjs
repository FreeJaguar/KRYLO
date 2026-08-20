import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeProjectRootHash,
  readActiveRunPointer,
  writeActiveRunPointer,
  pruneStaleActiveRunPointers,
} from '../../scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');
const INIT_RUN = path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs');
const UPDATE_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'update-state.mjs');
const READ_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'read-state.mjs');
const CLEANUP = path.join(SCRIPTS_ROOT, 'runtime', 'cleanup.mjs');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRun({ dataDir, projectDir, session, goal = 'concurrency fixture' }) {
  const res = spawnSync(process.execPath, [
    INIT_RUN,
    '--goal', goal,
    '--session', session,
    '--project-dir', projectDir,
    '--lane', 'PATCH',
    '--risk', 'low',
  ], { encoding: 'utf8', env: { ...process.env, KRYLO_DATA_ROOT: dataDir } });
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.ok, true, res.stderr);
  return json.runId;
}

function updateState({ dataDir, runId, args }) {
  const res = spawnSync(process.execPath, [UPDATE_STATE, '--run', runId, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

function readStateCli({ dataDir, projectDir, session }) {
  const res = spawnSync(process.execPath, [READ_STATE, '--project-dir', projectDir, '--session', session], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

test('concurrency: two projects never overwrite each other\'s pointer', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectA = mkTempDir('krylo-conc-a-');
  const projectB = mkTempDir('krylo-conc-b-');
  try {
    const runA = initRun({ dataDir, projectDir: projectA, session: 'session-a' });
    const runB = initRun({ dataDir, projectDir: projectB, session: 'session-b' });

    const readA = readStateCli({ dataDir, projectDir: projectA, session: 'session-a' });
    const readB = readStateCli({ dataDir, projectDir: projectB, session: 'session-b' });

    assert.equal(readA.json.runId, runA);
    assert.equal(readB.json.runId, runB);
    assert.notEqual(runA, runB);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test('concurrency: two sessions in the same project get independent pointers', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const runX = initRun({ dataDir, projectDir, session: 'session-x' });
    const runY = initRun({ dataDir, projectDir, session: 'session-y' });
    assert.notEqual(runX, runY);

    const readX = readStateCli({ dataDir, projectDir, session: 'session-x' });
    const readY = readStateCli({ dataDir, projectDir, session: 'session-y' });
    assert.equal(readX.json.runId, runX);
    assert.equal(readY.json.runId, runY);

    const projectRootHash = computeProjectRootHash(projectDir);
    const dir = path.join(dataDir, 'active-runs', projectRootHash, 'claude');
    assert.ok(fs.existsSync(path.join(dir, 'session-x.json')));
    assert.ok(fs.existsSync(path.join(dir, 'session-y.json')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: one run finishing leaves the other session\'s pointer intact', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const runX = initRun({ dataDir, projectDir, session: 'session-x' });
    const runY = initRun({ dataDir, projectDir, session: 'session-y' });

    const finish = updateState({ dataDir, runId: runX, args: ['--terminal', 'CANCELLED_BY_USER'] });
    assert.equal(finish.json.ok, true);

    const projectRootHash = computeProjectRootHash(projectDir);
    const dir = path.join(dataDir, 'active-runs', projectRootHash, 'claude');
    assert.equal(fs.existsSync(path.join(dir, 'session-x.json')), false, 'finished run\'s pointer must be cleared');
    assert.equal(fs.existsSync(path.join(dir, 'session-y.json')), true, 'unrelated active run must remain untouched');

    const readY = readStateCli({ dataDir, projectDir, session: 'session-y' });
    assert.equal(readY.json.runId, runY);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: parallel init-run for distinct sessions in one project never corrupts pointers', async () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const sessions = Array.from({ length: 8 }, (_, i) => `session-parallel-${i}`);
    const runs = await Promise.all(sessions.map((session) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        INIT_RUN,
        '--goal', 'parallel init fixture',
        '--session', session,
        '--project-dir', projectDir,
        '--lane', 'PATCH',
        '--risk', 'low',
      ], { env: { ...process.env, KRYLO_DATA_ROOT: dataDir } });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out.trim()));
        } catch (err) {
          reject(err);
        }
      });
    })));

    assert.equal(runs.length, sessions.length);
    for (const r of runs) assert.equal(r.ok, true);

    const projectRootHash = computeProjectRootHash(projectDir);
    const dir = path.join(dataDir, 'active-runs', projectRootHash, 'claude');
    for (const session of sessions) {
      const pointerRaw = fs.readFileSync(path.join(dir, `${session}.json`), 'utf8');
      const pointer = JSON.parse(pointerRaw); // must not throw: no torn/partial write
      assert.equal(typeof pointer.runId, 'string');
    }
    // 8 distinct sessions -> 8 distinct pointer files, no cross-talk.
    const runIds = new Set(runs.map((r) => r.runId));
    assert.equal(runIds.size, sessions.length);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: cleanup prunes stale pointers but keeps active ones', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const activeRun = initRun({ dataDir, projectDir, session: 'session-active' });
    const finishedRun = initRun({ dataDir, projectDir, session: 'session-finished' });
    updateState({ dataDir, runId: finishedRun, args: ['--terminal', 'CANCELLED_BY_USER'] });

    // Orphaned pointer: names a runId whose state directory never existed.
    // writeActiveRunPointer()/readActiveRunPointer() resolve the data root
    // from KRYLO_DATA_ROOT, so this in-process call must be scoped to the
    // fixture's dataDir exactly like the spawned CLIs above, or it would
    // touch the real host KRYLO data directory instead.
    const projectRootHash = computeProjectRootHash(projectDir);
    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    let stillThere;
    try {
      writeActiveRunPointer({ runId: 'run-doesnotexist', projectRootHash, host: 'claude', hostSessionId: 'session-orphan' });
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }

    const res = spawnSync(process.execPath, [CLEANUP], {
      encoding: 'utf8',
      env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
    });
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.ok, true);

    const dir = path.join(dataDir, 'active-runs', projectRootHash, 'claude');
    assert.ok(fs.existsSync(path.join(dir, 'session-active.json')), 'active run pointer must survive cleanup');
    assert.equal(fs.existsSync(path.join(dir, 'session-finished.json')), false, 'terminal run pointer must be pruned');
    assert.equal(fs.existsSync(path.join(dir, 'session-orphan.json')), false, 'orphaned pointer must be pruned');

    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      stillThere = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-active' });
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
    assert.equal(stillThere.ok, true);
    assert.equal(stillThere.value.runId, activeRun);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: a corrupted pointer file is skipped, not thrown', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const projectRootHash = computeProjectRootHash(projectDir);
    const dir = path.join(dataDir, 'active-runs', projectRootHash, 'claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-broken.json'), '{ not valid json', 'utf8');

    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-broken' });
      assert.equal(result.ok, false);
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: legacy single current-run.json is migrated into the new per-host per-session layout', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      const projectRootHash = computeProjectRootHash(projectDir);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'current-run.json'), JSON.stringify({
        runId: 'run-legacy000001',
        projectRootHash,
        sessionId: 'legacy-session',
        updatedAt: new Date().toISOString(),
      }), 'utf8');

      const result = readActiveRunPointer({ projectRootHash, host: 'claude' });
      assert.equal(result.ok, true);
      assert.equal(result.value.runId, 'run-legacy000001');

      // Migrated into the new claude host layout and the legacy file removed.
      assert.equal(fs.existsSync(path.join(dataDir, 'current-run.json')), false);
      assert.ok(fs.existsSync(path.join(dataDir, 'active-runs', projectRootHash, 'claude', 'legacy-session.json')));
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: a still-active pre-0.2.0 flat pointer is migrated into the claude host layout, not discarded', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      const runId = initRun({ dataDir, projectDir, session: 'session-flat' });
      const projectRootHash = computeProjectRootHash(projectDir);
      const flatDir = path.join(dataDir, 'active-runs', projectRootHash);
      const hostDir = path.join(flatDir, 'claude');

      // Simulate a pre-0.2.0 install: the pointer sits flat under the
      // project directory (no host segment), not in the new claude/ layout.
      const flatPointer = JSON.parse(fs.readFileSync(path.join(hostDir, 'session-flat.json'), 'utf8'));
      fs.rmSync(path.join(hostDir, 'session-flat.json'), { force: true });
      fs.writeFileSync(path.join(flatDir, 'session-flat.json'), JSON.stringify(flatPointer), 'utf8');

      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-flat' });
      assert.equal(result.ok, true);
      assert.equal(result.value.runId, runId);
      assert.equal(fs.existsSync(path.join(flatDir, 'session-flat.json')), false, 'flat legacy pointer must be removed once migrated');
      assert.ok(fs.existsSync(path.join(hostDir, 'session-flat.json')), 'migrated pointer must exist under the claude host directory');
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: two host names with the same session string never collide', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      const projectRootHash = computeProjectRootHash(projectDir);
      writeActiveRunPointer({ runId: 'run-claudeaaaaaa', projectRootHash, host: 'claude', hostSessionId: 'shared-session' });
      writeActiveRunPointer({ runId: 'run-codexbbbbbbb', projectRootHash, host: 'codex', hostSessionId: 'shared-session' });

      const claudePointer = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'shared-session' });
      const codexPointer = readActiveRunPointer({ projectRootHash, host: 'codex', hostSessionId: 'shared-session' });

      assert.equal(claudePointer.ok, true);
      assert.equal(codexPointer.ok, true);
      assert.equal(claudePointer.value.runId, 'run-claudeaaaaaa');
      assert.equal(codexPointer.value.runId, 'run-codexbbbbbbb');
      assert.notEqual(claudePointer.value.runId, codexPointer.value.runId);
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// Regression: one host's stale-pointer pruning must never be able to remove
// another host's active pointer. Both hosts share the same project and the
// same session string; only the codex pointer's run is stale (terminal).
test('concurrency: pruning one host\'s stale pointers cannot remove another host\'s active pointer', () => {
  const dataDir = mkTempDir('krylo-conc-data-');
  const projectDir = mkTempDir('krylo-conc-proj-');
  try {
    const prevDataRoot = process.env.KRYLO_DATA_ROOT;
    process.env.KRYLO_DATA_ROOT = dataDir;
    try {
      const projectRootHash = computeProjectRootHash(projectDir);

      const activeRun = initRun({ dataDir, projectDir, session: 'shared-session' });
      // Give codex a pointer to the SAME string session id, but to a run
      // that will be terminal (stale) so pruning must remove only this one.
      const staleRunResult = spawnSync(process.execPath, [
        INIT_RUN,
        '--goal', 'codex stale fixture',
        '--session', 'codex-init-session',
        '--project-dir', projectDir,
        '--lane', 'PATCH',
        '--risk', 'low',
      ], { encoding: 'utf8', env: { ...process.env, KRYLO_DATA_ROOT: dataDir } });
      const staleRunId = JSON.parse(staleRunResult.stdout.trim()).runId;
      writeActiveRunPointer({ runId: staleRunId, projectRootHash, host: 'codex', hostSessionId: 'shared-session' });
      updateState({ dataDir, runId: staleRunId, args: ['--terminal', 'CANCELLED_BY_USER'] });

      const removed = pruneStaleActiveRunPointers(path.join(dataDir, 'active-runs'));

      const claudePointerPath = path.join(dataDir, 'active-runs', projectRootHash, 'claude', 'shared-session.json');
      const codexPointerPath = path.join(dataDir, 'active-runs', projectRootHash, 'codex', 'shared-session.json');
      assert.ok(fs.existsSync(claudePointerPath), 'claude\'s active pointer must survive pruning of codex\'s stale pointer');
      assert.equal(fs.existsSync(codexPointerPath), false, 'codex\'s stale pointer must be pruned');
      assert.ok(removed.some((r) => r.includes(path.join('codex', 'shared-session.json'))));

      const stillActive = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'shared-session' });
      assert.equal(stillActive.ok, true);
      assert.equal(stillActive.value.runId, activeRun);
    } finally {
      if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
      else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('concurrency: project root hash is identical for Windows- and POSIX-style separators', () => {
  const winStyle = 'C:\\Users\\dev\\Projects\\demo';
  const posixStyle = 'C:/Users/dev/Projects/demo';
  assert.equal(computeProjectRootHash(winStyle), computeProjectRootHash(posixStyle));
});

// Regression for an independent-review finding (v0.1.1 hardening): update-state.mjs
// used to load-modify-save a run's state.json without the same exclusive lock
// scripts/security/risk-gate.mjs holds while consuming a risk approval, so two
// concurrent mutations (or a mutation racing an approval consumption) could
// both read the same "before" state and one write would silently overwrite the
// other's change (e.g. a resolved approval reverting to pending). Both callers
// now serialize through the same per-run lock file.
test('concurrency: many concurrent update-state.mjs mutations on one run lose no increments', async () => {
  const dataDir = mkTempDir('krylo-conc-lock-data-');
  const projectDir = mkTempDir('krylo-conc-lock-proj-');
  try {
    const runId = initRun({ dataDir, projectDir, session: 'session-lock-race' });

    const runOnce = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [UPDATE_STATE, '--run', runId, '--orbit-cycle'], {
        env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });

    const CONCURRENT = 12;
    const results = await Promise.all(Array.from({ length: CONCURRENT }, runOnce));
    for (const r of results) assert.equal(r.code, 0, r.out);

    const final = readStateCli({ dataDir, projectDir, session: 'session-lock-race' });
    assert.equal(final.json.orbit.cycle, CONCURRENT, 'every concurrent --orbit-cycle increment must be preserved, none lost to a lock-free race');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
