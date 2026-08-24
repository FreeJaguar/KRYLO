// Regression coverage for SECURITY BLOCKER 3 (security-hardening checkpoint,
// prompt.md): an explicitly named session/host identity must resolve ONLY
// its own exact active-run pointer. If that exact pointer is missing or
// corrupt, resolution must fail safely -- it must never silently fall back
// to a sibling session's pointer and let a caller who named session A read
// or mutate session B's run.
//
// Found: readActiveRunPointer() fell through to listHostPointers()'s
// "most recently updated pointer" fallback whenever the exact
// activeRunPointerPath() lookup failed, even when hostSessionId was known.
// Fixed in scripts/lib/state.mjs: the fallback now applies ONLY when
// hostSessionId itself is falsy/undefined (ADR-0020's documented
// convenience case for callers that genuinely do not know a session id).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeProjectRootHash,
  readActiveRunPointer,
  writeActiveRunPointer,
} from '../../scripts/lib/state.mjs';
import { activeRunPointerPath } from '../../scripts/lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');
const INIT_RUN = path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs');
const UPDATE_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'update-state.mjs');
const READ_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'read-state.mjs');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Direct (non-subprocess) library calls read/write through getDataRoot(),
 * which resolves KRYLO_DATA_ROOT from process.env. Every direct test MUST
 * point that at an isolated temp dir for its duration and restore the prior
 * value afterward -- never leave it unset, or these calls fall through to
 * the real ~/.krylo/data on this machine.
 */
function withDataRoot(dataDir, fn) {
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dataDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
  }
}

function initRun({ dataDir, projectDir, session, goal = 'session isolation fixture' }) {
  const res = spawnSync(process.execPath, [
    INIT_RUN, '--goal', goal, '--session', session, '--project-dir', projectDir, '--lane', 'PATCH', '--risk', 'low',
  ], { encoding: 'utf8', env: { ...process.env, KRYLO_DATA_ROOT: dataDir } });
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.ok, true, res.stderr);
  return json.runId;
}

function readStateCli({ dataDir, projectDir, session }) {
  const res = spawnSync(process.execPath, [READ_STATE, '--project-dir', projectDir, '--session', session], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

function updateStateCli({ dataDir, projectDir, session, args }) {
  const res = spawnSync(process.execPath, [UPDATE_STATE, '--project-dir', projectDir, '--session', session, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_DATA_ROOT: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

test('direct: exact session A resolves its own pointer when both A and B are active', () => {
  const dataDir = mkTempDir('krylo-iso-direct-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      writeActiveRunPointer({ runId: 'run-aaaaaaaaaaaa', projectRootHash, host: 'claude', hostSessionId: 'session-a' });
      writeActiveRunPointer({ runId: 'run-bbbbbbbbbbbb', projectRootHash, host: 'claude', hostSessionId: 'session-b' });

      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-a' });
      assert.equal(result.ok, true);
      assert.equal(result.value.runId, 'run-aaaaaaaaaaaa');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('direct: exact session A absent, B active -> safe failure, B is never returned', () => {
  const dataDir = mkTempDir('krylo-iso-direct-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      // Only B has a pointer; A was never created.
      writeActiveRunPointer({ runId: 'run-bbbbbbbbbbbb', projectRootHash, host: 'claude', hostSessionId: 'session-b' });

      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-a' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'not-found');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('direct: exact session A corrupt, B active -> safe failure, B is never returned', () => {
  const dataDir = mkTempDir('krylo-iso-direct-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      writeActiveRunPointer({ runId: 'run-bbbbbbbbbbbb', projectRootHash, host: 'claude', hostSessionId: 'session-b' });
      // A's pointer file exists but is not valid JSON.
      const pointerPathA = activeRunPointerPath(projectRootHash, 'claude', 'session-a');
      fs.mkdirSync(path.dirname(pointerPathA), { recursive: true });
      fs.writeFileSync(pointerPathA, 'not valid json {{{', 'utf8');

      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-a' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'not-found');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('direct: no session supplied and exactly one active run exists -> documented fallback resolves it', () => {
  const dataDir = mkTempDir('krylo-iso-direct-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      writeActiveRunPointer({ runId: 'run-cccccccccccc', projectRootHash, host: 'claude', hostSessionId: 'session-c' });

      const result = readActiveRunPointer({ projectRootHash, host: 'claude' });
      assert.equal(result.ok, true);
      assert.equal(result.value.runId, 'run-cccccccccccc');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('direct: host isolation remains intact even with the exact-session fix', () => {
  const dataDir = mkTempDir('krylo-iso-direct-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      writeActiveRunPointer({ runId: 'run-codexrun0001', projectRootHash, host: 'codex', hostSessionId: 'same-session-string' });

      // Same session string, different host: must not cross.
      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'same-session-string' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'not-found');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('CLI: read-state.mjs with exact session A absent (B active) reports no-current-run, never B\'s state', () => {
  const dataDir = mkTempDir('krylo-iso-cli-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    const runIdB = initRun({ dataDir, projectDir, session: 'session-b' });

    const resA = readStateCli({ dataDir, projectDir, session: 'session-a' });
    assert.equal(resA.json.ok, false);
    assert.equal(resA.json.error, 'no-current-run');
    assert.notEqual(resA.json.runId, runIdB);

    // B remains independently readable and unaffected. (read-state.mjs
    // prints the raw state document on success, not an {ok:true} wrapper.)
    const resB = readStateCli({ dataDir, projectDir, session: 'session-b' });
    assert.equal(resB.json.runId, runIdB);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('CLI: read-state.mjs with exact session A pointer corrupted (B active) reports no-current-run, never mutates/reads B', () => {
  const dataDir = mkTempDir('krylo-iso-cli-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    const runIdB = initRun({ dataDir, projectDir, session: 'session-b' });
    // activeRunPointerPath() itself reads getDataRoot() from
    // KRYLO_DATA_ROOT at call time, so it must be computed (not just used)
    // inside withDataRoot -- computing it outside would resolve against
    // whatever KRYLO_DATA_ROOT happens to be set to at that moment instead.
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      const pointerPathA = activeRunPointerPath(projectRootHash, 'claude', 'session-a');
      fs.mkdirSync(path.dirname(pointerPathA), { recursive: true });
      fs.writeFileSync(pointerPathA, '{ this is not json', 'utf8');
    });

    const resA = readStateCli({ dataDir, projectDir, session: 'session-a' });
    assert.equal(resA.json.ok, false);
    assert.equal(resA.json.error, 'no-current-run');

    const resB = readStateCli({ dataDir, projectDir, session: 'session-b' });
    assert.equal(resB.json.runId, runIdB);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('CLI: update-state.mjs with exact session A absent (B active) refuses safely and never mutates B\'s state', () => {
  const dataDir = mkTempDir('krylo-iso-cli-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    const runIdB = initRun({ dataDir, projectDir, session: 'session-b' });

    const resA = updateStateCli({
      dataDir, projectDir, session: 'session-a', args: ['--add-criterion', 'should never land on B'],
    });
    assert.equal(resA.json.ok, false);
    assert.equal(resA.json.error, 'no-current-run');

    const resB = readStateCli({ dataDir, projectDir, session: 'session-b' });
    assert.equal(resB.json.runId, runIdB);
    const stateB = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdB, 'state.json'), 'utf8'));
    assert.equal(stateB.acceptanceCriteria.length, 0, 'session A\'s mutation must never have reached session B\'s state');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('legacy GLOBAL pointer migration refuses adopting a different session\'s run under an explicit caller session', () => {
  const dataDir = mkTempDir('krylo-iso-legacy-global-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      // Pre-0.1.1 global pointer, recorded as belonging to a specific session.
      const legacyPath = path.join(dataDir, 'current-run.json');
      fs.writeFileSync(legacyPath, JSON.stringify({
        runId: 'run-legacyglobal01', projectRootHash, sessionId: 'session-owner', updatedAt: new Date().toISOString(),
      }));

      // A caller with a DIFFERENT explicit session must never adopt it.
      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-intruder' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'not-found');

      // The legacy pointer must be left exactly as it was: not deleted, not
      // adopted under the intruder's session.
      assert.ok(fs.existsSync(legacyPath), 'a refused migration must not delete the legacy pointer');
      const stillLegacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      assert.equal(stillLegacy.runId, 'run-legacyglobal01');
      assert.ok(!fs.existsSync(path.join(dataDir, 'active-runs', projectRootHash, 'claude', 'session-intruder.json')));

      // The rightful owner's own session can still legitimately migrate it.
      const owned = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'session-owner' });
      assert.equal(owned.ok, true);
      assert.equal(owned.value.runId, 'run-legacyglobal01');
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('legacy migration remains safe: a genuinely unknown session still adopts the single legacy pointer', () => {
  const dataDir = mkTempDir('krylo-iso-legacy-');
  const projectDir = mkTempDir('krylo-iso-proj-');
  try {
    withDataRoot(dataDir, () => {
      const projectRootHash = computeProjectRootHash(projectDir);
      // Simulate a pre-0.2.0 flat pointer (no host segment) for this exact session.
      const flatDir = path.join(dataDir, 'active-runs', projectRootHash);
      fs.mkdirSync(flatDir, { recursive: true });
      fs.writeFileSync(path.join(flatDir, 'legacy-session.json'), JSON.stringify({
        runId: 'run-legacyflat0001', projectRootHash, updatedAt: new Date().toISOString(),
      }));

      const result = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId: 'legacy-session' });
      assert.equal(result.ok, true);
      assert.equal(result.value.runId, 'run-legacyflat0001');
      // Migrated into the new host-scoped layout.
      assert.ok(fs.existsSync(path.join(dataDir, 'active-runs', projectRootHash, 'claude', 'legacy-session.json')));
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
