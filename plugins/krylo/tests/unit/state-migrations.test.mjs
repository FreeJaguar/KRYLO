import test from 'node:test';
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

test('real concurrency: migration racing approval consumption never resurrects a consumed approval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-proj-'));
  try {
    // A legacy 1.0.0 fixture with one ALREADY-APPROVED, unconsumed approval
    // -- the exact shape reported as risky: Process A could migrate this in
    // memory from a stale pre-consumption read and persist it after Process
    // B has already consumed the approval under lock, silently un-consuming
    // it.
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
        summary: 'pre-approved push',
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

    // 12 bare reads racing the real risk-gate Hook consuming the approval.
    const reads = Array.from({ length: 12 }, () => spawnAsync(READ_STATE, ['--run', legacy.runId], { env }));
    const consumption = new Promise((resolve) => {
      const child = spawn(process.execPath, [RISK_GATE], { env });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => resolve({ status: code, stdout }));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }, cwd: projectDir,
      }));
    });

    const [consumeResult] = await Promise.all([consumption, ...reads]);

    let decision = null;
    try { decision = JSON.parse(consumeResult.stdout.trim()); } catch { /* silent allow prints nothing */ }
    assert.ok(decision, 'the risk gate must have produced a decision (the approval should have been consumed)');
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');
    assert.equal(onDisk.riskApprovals[0].status, 'consumed', 'a consumed approval must never be reverted to approved by a racing migration');
    assert.ok(onDisk.riskApprovals[0].consumedAt);

    const backups = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1);

    // A second, independent attempt to consume the same (now-consumed)
    // approval must be refused -- single-use survives the race too.
    const secondAttempt = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RISK_GATE], { env });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }, cwd: projectDir,
      }));
    });
    let secondDecision = null;
    try { secondDecision = JSON.parse(secondAttempt.trim()); } catch { /* ignore */ }
    assert.ok(secondDecision, 'a second attempt against a consumed approval must not silently allow');
    assert.equal(secondDecision.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
