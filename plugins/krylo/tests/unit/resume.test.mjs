import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadState, readActiveRunPointer, computeProjectRootHash } from '../../scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');

function runCli(scriptRelPath, args, dataDir) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

test('state resumes after a simulated process restart', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-resume-'));
  const prevDataRoot = process.env.KRYLO_DATA_ROOT;
  try {
    // Process A: spawn init-run.mjs as a fully separate process.
    const init = runCli('runtime/init-run.mjs', [
      '--goal', 'resume test goal',
      '--session', 'session-resume-1',
      '--project-dir', dataDir,
      '--lane', 'BUILD',
      '--risk', 'medium',
    ], dataDir);
    assert.equal(init.json.ok, true);
    const runId = init.json.runId;

    // In the current (test) process, point at the same data dir and read
    // the pointer + state that process A wrote.
    process.env.KRYLO_DATA_ROOT = dataDir;
    const projectRootHash = computeProjectRootHash(dataDir);
    const pointer = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-resume-1' });
    assert.equal(pointer.ok, true);
    assert.equal(pointer.value.runId, runId);

    const loaded = loadState(runId);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.phase, 'INITIALIZING');

    // Process B: a second spawned CLI call simulates the process restarting.
    const update = runCli('runtime/update-state.mjs', ['--run', runId, '--phase', 'EXECUTING'], dataDir);
    assert.equal(update.status, 0);
    assert.equal(update.json.ok, true);

    // Back in the test process: confirm the mutation persisted across the
    // simulated restart.
    const reloaded = loadState(runId);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.value.phase, 'EXECUTING');
    assert.equal(typeof reloaded.value.updatedAt, 'string');
  } finally {
    if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prevDataRoot;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
