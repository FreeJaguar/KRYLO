import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CURRENT_STATE_SCHEMA_VERSION, migrateStateDocument } from '../../scripts/lib/state-migrations.mjs';

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

// --- loadState-level migration safety (backup-then-persist), exercised only
// against isolated temp fixtures, never a live KRYLO data directory. ---

test('loadState migrates a real 1.0.0 file on disk, creates one pre-migration backup, and persists valid 1.1.0 state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const loaded = loadState(legacy.runId);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.schemaVersion, '1.1.0');
    assert.equal(loaded.value.host.name, 'claude');
    assert.equal(loaded.value.host.sessionId, 'legacy-session');
    assert.equal('sessionId' in loaded.value, false);

    const entries = fs.readdirSync(runDir);
    const backups = entries.filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1);
    const backupRaw = JSON.parse(fs.readFileSync(path.join(runDir, backups[0]), 'utf8'));
    assert.equal(backupRaw.schemaVersion, '1.0.0');
    assert.equal(backupRaw.sessionId, 'legacy-session');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-loading already-migrated state does not create a second backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const first = loadState(legacy.runId);
    assert.equal(first.ok, true);
    const second = loadState(legacy.runId);
    assert.equal(second.ok, true);

    const backups = fs.readdirSync(runDir).filter((f) => /^state\.pre-migration-1\.0\.0-\d+\.json$/.test(f));
    assert.equal(backups.length, 1);
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

test('concurrent loads of one legacy 1.0.0 fixture finish with one valid 1.1.0 state and no corrupted state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-migrations-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    const { loadState } = await import('../../scripts/lib/state.mjs');
    const legacy = validLegacyFixture();
    const runDir = path.join(dir, 'runs', legacy.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy), 'utf8');

    const results = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve(loadState(legacy.runId))));
    for (const r of results) {
      assert.equal(r.ok, true);
      assert.equal(r.value.schemaVersion, '1.1.0');
    }

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.1.0');

    const corrupt = fs.readdirSync(runDir).filter((f) => f.startsWith('state.corrupt-'));
    assert.equal(corrupt.length, 0);
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
