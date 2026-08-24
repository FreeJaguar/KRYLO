import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CURRENT_STATE_SCHEMA_VERSION, migrateStateDocument } from '../../scripts/lib/state-migrations.mjs';
import { computeProjectRootHash } from '../../scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');
const UPDATE_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'update-state.mjs');
const READ_STATE = path.join(SCRIPTS_ROOT, 'runtime', 'read-state.mjs');
const RISK_GATE = path.join(SCRIPTS_ROOT, 'security', 'risk-gate.mjs');

/** Real concurrency: spawn (not spawnSync) each process, then await all of
 * them together, so they genuinely overlap rather than running one after
 * another with only microtask-level interleaving. */
function spawnAsync(scriptPath, args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { encoding: 'utf8', ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}


function validLegacyFixture() {
  return {
    schemaVersion: '1.0.0',
    kryloVersion: '0.1.1',
    sessionId: 'legacy-session',
    runId: 'run-legacy1234',
    project: { rootHash: 'a'.repeat(64) },
    goal: { normalized: 'ship the feature', lane: 'BUILD', risk: 'low' },
    acceptanceCriteria: [],
    agents: [],
    toolCounters: {},
    orbit: {
      budget: 3,
      cycle: 0,
      stopBlocks: 0,
      fingerprints: [],
      stagnation: { cyclesWithoutProgress: 0, lastProgressCycle: 0 },
      strategyChanges: 0,
      requiredStrategyChange: false,
    },
    questionGate: { budget: 1, used: 0, grants: [] },
    riskApprovals: [],
    findings: [],
    evidence: [],
    phase: 'INITIALIZING',
    terminalState: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('migrateStateDocument upgrades a real 1.0.0 fixture to exactly 1.1.0', () => {
  const legacy = validLegacyFixture();
  const result = migrateStateDocument(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, '1.0.0');
  assert.equal(result.value.schemaVersion, '1.1.0');
  assert.equal(result.value.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  assert.equal(result.value.host.name, 'claude');
  assert.equal(result.value.host.sessionId, 'legacy-session');
  assert.equal(result.value.delegation.externalWorker, false);
  assert.equal(result.value.delegation.depth, 0);
  assert.equal('sessionId' in result.value, false);
  assert.equal(result.value.runId, legacy.runId);
});

test('1.1.0 input returns unchanged with migrated=false', () => {
  const legacy = validLegacyFixture();
  const already = migrateStateDocument(legacy).value;
  const result = migrateStateDocument(already);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.value, already);
});

test('an unknown/unsupported schema version is refused, not guessed', () => {
  const future = { ...validLegacyFixture(), schemaVersion: '9.9.9' };
  delete future.sessionId;
  const result = migrateStateDocument(future);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported-schema-version');
  assert.equal(result.fromVersion, '9.9.9');
});

test('migration does not mutate the input object', () => {
  const legacy = validLegacyFixture();
  const before = JSON.parse(JSON.stringify(legacy));
  migrateStateDocument(legacy);
  assert.deepEqual(legacy, before);
});

test('migration never adds secret/redaction-only fields', () => {
  const legacy = validLegacyFixture();
  const result = migrateStateDocument(legacy);
  const allowedTop = new Set([
    'schemaVersion', 'kryloVersion', 'host', 'delegation', 'runId', 'project', 'goal',
    'acceptanceCriteria', 'agents', 'toolCounters', 'orbit', 'questionGate', 'riskApprovals',
    'findings', 'evidence', 'phase', 'terminalState', 'createdAt', 'updatedAt',
  ]);
  for (const key of Object.keys(result.value)) {
    assert.ok(allowedTop.has(key), `unexpected top-level field introduced by migration: ${key}`);
  }
});

test('invalid input document is rejected safely', () => {
  assert.equal(migrateStateDocument(null).ok, false);
  assert.equal(migrateStateDocument('not-an-object').ok, false);
  assert.equal(migrateStateDocument([]).ok, false);
});

test('a legacy 1.0.0 document missing sessionId is refused, not guessed', () => {
  const broken = validLegacyFixture();
  delete broken.sessionId;
  const result = migrateStateDocument(broken);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'legacy-session-id-missing');
  assert.equal(result.fromVersion, '1.0.0');
});

// --- loadState/saveState-level migration safety, exercised only against
// isolated temp fixtures, never a live KRYLO data directory. ---
//
// SECURITY BLOCKER 2 (security-hardening checkpoint): loadState() no longer
// writes to disk at all -- see its updated header comment in
// scripts/lib/state.mjs. A migration is committed to disk only inside
// saveState(), which every real mutator already calls from within the run's
// exclusive lock. These tests were rewritten accordingly: a bare loadState()
// call must leave disk untouched, and only an actual save (representing a
// real mutation) performs the one-time backup-then-persist. The final block
// below replaces the old `Promise.resolve(loadState(...))` fake-concurrency
// test with real, separate `node` child processes.

test('loadState migrates a real 1.0.0 file in memory only -- disk is untouched by a bare read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    const originalRaw = JSON.stringify(legacy);
    fs.writeFileSync(statePath, originalRaw, 'utf8');

    const loaded = loadState(legacy.runId);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.schemaVersion, '1.1.0');
    assert.equal(loaded.value.host.name, 'claude');
    assert.equal(loaded.value.host.sessionId, 'legacy-session');
    assert.equal('sessionId' in loaded.value, false);

    // Disk is exactly as it was before the read: no backup, no rewrite.
    assert.equal(fs.readFileSync(statePath, 'utf8'), originalRaw);
    assert.equal(fs.readdirSync(runDir).filter((f) => f.startsWith('state.pre-migration-')).length, 0);
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState(loadState(...).value) performs the one-time backup-then-persist, and a second save never duplicates it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState, saveState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const loaded = loadState(legacy.runId);
    assert.equal(loaded.ok, true);
    const saved = saveState(loaded.value);
    assert.equal(saved.ok, true);

    const backups = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1);
    const backupRaw = JSON.parse(fs.readFileSync(path.join(runDir, backups[0]), 'utf8'));
    assert.equal(backupRaw.schemaVersion, '1.0.0');
    assert.equal(backupRaw.sessionId, 'legacy-session');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');

    // Load + save again: now both sides agree on schemaVersion, so no
    // second backup is created.
    const secondLoad = loadState(legacy.runId);
    assert.equal(secondLoad.ok, true);
    saveState(secondLoad.value);
    const backupsAfter = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backupsAfter.length, 1, 're-saving an already-migrated state must never create a second backup');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState fails safely and preserves the original file when the pre-migration backup write itself fails', async () => {
  // Migration backup safety: "file does not exist" (a brand-new run -- fine,
  // nothing to back up) and "backup write failed" (a real I/O error) must
  // not be treated as the same condition. A failed backup write must refuse
  // the save entirely rather than silently proceeding to overwrite the
  // original -- the whole point of the backup is to preserve a recoverable
  // copy of the pre-migration document, and overwriting the original after
  // failing to create that copy would destroy the only trace of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState, saveState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    const originalRaw = JSON.stringify(legacy);
    fs.writeFileSync(statePath, originalRaw, 'utf8');

    const loaded = loadState(legacy.runId);
    assert.equal(loaded.ok, true);

    const realWriteFileSync = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      // Only the pre-migration backup write (a plain path string) is made to
      // fail; writeJsonAtomic's own internal writeFileSync call (which
      // always writes through an open file descriptor, a number, never a
      // path string) must be left completely alone.
      if (typeof target === 'string' && target.includes('state.pre-migration-')) {
        throw new Error('simulated disk failure writing the pre-migration backup');
      }
      return realWriteFileSync.call(fs, target, ...rest);
    });

    try {
      const saved = saveState(loaded.value);
      assert.equal(saved.ok, false);
      assert.equal(saved.error, 'backup-failed');
    } finally {
      mock.restoreAll();
    }

    // The original file must be completely untouched: same exact bytes as
    // before the failed save attempt.
    assert.equal(fs.readFileSync(statePath, 'utf8'), originalRaw);
    assert.equal(fs.readdirSync(runDir).filter((f) => f.startsWith('state.pre-migration-')).length, 0);
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState treats "no prior file" (a brand-new run) as distinct from "backup failed": no backup attempted, save succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { createInitialState, saveState } = await import('../../scripts/lib/state.mjs');
    const state = createInitialState({
      goalText: 'brand new run, nothing to back up',
      hostIdentity: { host: 'claude', hostSessionId: 'session-new' },
      projectDir: dir,
      lane: 'PATCH',
      risk: 'low',
      complexity: 'trivial',
      runId: 'run-brandnew001',
    });
    const runDir = path.join(dir, 'runs', state.runId);

    const saved = saveState(state);
    assert.equal(saved.ok, true, 'a brand-new run with no prior file must save successfully, not be refused as a backup failure');
    assert.ok(fs.existsSync(path.join(runDir, 'state.json')));
    assert.equal(fs.readdirSync(runDir).filter((f) => f.startsWith('state.pre-migration-')).length, 0, 'no backup should ever be attempted when there was no prior file');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unsupported schema version on disk is refused without destructive overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState } = await import('../../scripts/lib/state.mjs');
    const future = { ...validLegacyFixture(), schemaVersion: '9.9.9' };
    delete future.sessionId;
    const runDir = path.join(dir, 'runs', future.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    const raw = JSON.stringify(future);
    fs.writeFileSync(statePath, raw, 'utf8');

    const loaded = loadState(future.runId);
    assert.equal(loaded.ok, false);

    // Original file must remain untouched, not deleted or corrupted-renamed
    // away silently.
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.readFileSync(statePath, 'utf8'), raw);
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Real multi-process concurrency (separate `node` child processes, not
// microtask-level Promise.resolve() fakery). These exercise the actual
// dangerous interleaving reported during independent review: an unlocked
// bare read racing a properly-locked mutation, both touching the same
// legacy 1.0.0 run. ---

test('real concurrency: many concurrent unlocked bare reads never corrupt or duplicate-migrate a legacy fixture racing a real mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-proj-'));
  try {
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const env = { ...process.env, KRYLO_DATA_ROOT: dir };

    // 12 bare reads (read-state.mjs calls loadState() directly, unlocked,
    // never writes under the fixed design) racing one real mutation
    // (update-state.mjs, which loads+migrates+mutates+saves under the run
    // lock) -- all fired together, not sequentially.
    const reads = Array.from({ length: 12 }, () => spawnAsync(READ_STATE, ['--run', legacy.runId], { env }));
    const mutation = spawnAsync(UPDATE_STATE, ['--run', legacy.runId, '--add-criterion', 'race condition check'], { env });

    const [mutationResult, ...readResults] = await Promise.all([mutation, ...reads]);

    assert.equal(mutationResult.status, 0, mutationResult.stderr);
    const mutationJson = JSON.parse(mutationResult.stdout.trim());
    assert.equal(mutationJson.ok, true);

    for (const r of readResults) {
      assert.equal(r.status, 0, r.stderr);
      const json = JSON.parse(r.stdout.trim());
      // Every read either saw the pre-migration document (not yet an error
      // case -- read-state.mjs prints the raw redacted state either way) or
      // the migrated one; none may ever report corruption.
      assert.notEqual(json.error, 'corrupted');
    }

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');
    assert.equal(onDisk.acceptanceCriteria.length, 1, 'the real mutation must not have been lost to a racing bare read');
    assert.equal(onDisk.acceptanceCriteria[0].description, 'race condition check');

    const backups = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1, 'exactly one backup, however many reads raced the single real mutation');

    const corrupt = fs.readdirSync(runDir).filter((f) => f.startsWith('state.corrupt-'));
    assert.equal(corrupt.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('real concurrency: migration racing the native-ask risk gate still migrates safely, and a persisted local approval record never authorizes execution', async () => {
  // Native permission approval (docs/adr/0025-native-permission-approval.md):
  // risk-gate.mjs no longer loads, consumes, or saves riskApprovals state at
  // all -- authorization is delegated to Claude Code's own permissionDecision:
  // "ask". This test keeps the valuable part of the original regression (a
  // real migration-persisting mutation racing many unlocked bare reads of a
  // legacy fixture must still migrate safely, exactly once) and replaces the
  // now-obsolete "approval consumption must survive the race" assertion with
  // the new invariant: even a legacy fixture carrying an already-'approved',
  // unconsumed riskApprovals record must still get 'ask' from the risk gate,
  // never 'allow' -- a local approval record can never, by itself, authorize
  // the action, race or no race.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-proj-'));
  try {
    const projectRootHash = computeProjectRootHash(projectDir);
    const legacy = {
      ...validLegacyFixture(),
      // Must match the active-run pointer's hostSessionId below: resolveActiveRun()
      // requires the migrated host.sessionId to equal the pointer's exact session.
      sessionId: 'hook-session',
      project: { rootHash: projectRootHash },
      riskApprovals: [{
        id: 'ra-1',
        actionClass: 'git-push',
        status: 'approved',
        requestedAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        projectRootHash,
        runId: 'run-legacy1234',
        environment: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        consumedAt: null,
        fingerprint: null,
        target: null,
        summary: 'a stale/historical local approval record',
      }],
    };
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    // A matching active-run pointer, so the real risk-gate.mjs Hook can
    // resolve this run exactly the way a live Claude session would.
    const pointerDir = path.join(dir, 'active-runs', projectRootHash, 'claude');
    fs.mkdirSync(pointerDir, { recursive: true });
    fs.writeFileSync(path.join(pointerDir, 'hook-session.json'), JSON.stringify({
      runId: legacy.runId, projectRootHash, host: 'claude', hostSessionId: 'hook-session', updatedAt: new Date().toISOString(),
    }));

    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir, KRYLO_DATA_ROOT: dir, CLAUDE_SESSION_ID: 'hook-session' };

    // 12 bare reads racing a real mutation (update-state.mjs) AND the
    // risk-gate Hook (which no longer mutates state at all), all fired
    // together.
    const reads = Array.from({ length: 12 }, () => spawnAsync(READ_STATE, ['--run', legacy.runId], { env }));
    const mutation = spawnAsync(UPDATE_STATE, ['--run', legacy.runId, '--add-criterion', 'race condition check'], { env });
    const gateAttempt = new Promise((resolve) => {
      const child = spawn(process.execPath, [RISK_GATE], { env });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => resolve({ status: code, stdout }));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }, cwd: projectDir, permission_mode: 'auto',
      }));
    });

    const [mutationResult, gateResult] = await Promise.all([mutation, gateAttempt, ...reads]);

    assert.equal(mutationResult.status, 0, mutationResult.stderr);
    let gateDecision = null;
    try { gateDecision = JSON.parse(gateResult.stdout.trim()); } catch { /* ignore */ }
    assert.ok(gateDecision, 'the risk gate must have produced a decision for a require-approval class');
    assert.equal(gateDecision.hookSpecificOutput.permissionDecision, 'ask', 'a persisted local approval record must never authorize execution, race or no race');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');
    assert.equal(onDisk.riskApprovals[0].status, 'approved', 'the risk gate must not have touched the local approval record at all');
    assert.equal(onDisk.acceptanceCriteria.length, 1, 'the real mutation must not have been lost to a racing bare read');

    const backups = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1, 'exactly one backup, however many reads raced the single real mutation');

    // A second, independent attempt gets exactly the same ask decision
    // (there is no single-use state left at this layer to exhaust).
    const secondAttempt = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RISK_GATE], { env });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }, cwd: projectDir, permission_mode: 'auto',
      }));
    });
    let secondDecision = null;
    try { secondDecision = JSON.parse(secondAttempt.trim()); } catch { /* ignore */ }
    assert.ok(secondDecision);
    assert.equal(secondDecision.hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
