import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLEANUP_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'runtime', 'cleanup.mjs');

function runCleanup(args, dataDir) {
  const res = spawnSync(process.execPath, [CLEANUP_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

function setUpRun(dataDir, runId, updatedAt) {
  const runDir = path.join(dataDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const state = {
    schemaVersion: '1.0.0',
    kryloVersion: '0.0.0',
    sessionId: 's',
    runId,
    project: { rootHash: 'a'.repeat(64) },
    goal: { normalized: 'x', lane: 'BUILD', risk: 'low' },
    acceptanceCriteria: [],
    agents: [],
    toolCounters: {},
    orbit: {
      budget: 3, cycle: 0, stopBlocks: 0, fingerprints: [],
      stagnation: { cyclesWithoutProgress: 0, lastProgressCycle: 0 },
      strategyChanges: 0, requiredStrategyChange: false,
    },
    questionGate: { budget: 1, used: 0, grants: [] },
    riskApprovals: [],
    findings: [],
    evidence: [],
    phase: 'INITIALIZING',
    terminalState: null,
    createdAt: updatedAt,
    updatedAt,
  };
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state), 'utf8');

  const telemetryDir = path.join(dataDir, 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  const telemetryFile = path.join(telemetryDir, `${runId}.jsonl`);
  fs.writeFileSync(telemetryFile, JSON.stringify({ ts: updatedAt, event: 'init' }) + '\n', 'utf8');
  const mtime = new Date(updatedAt);
  fs.utimesSync(telemetryFile, mtime, mtime);
}

function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-cleanup-'));
}

test('cleanup removes an old run and keeps a fresh one', () => {
  const dataDir = mkTempDataDir();
  try {
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date().toISOString();
    setUpRun(dataDir, 'run-old000001', oldIso);
    setUpRun(dataDir, 'run-fresh00001', freshIso);

    const res = runCleanup(['--retention-days', '14'], dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.removed.runs.includes('run-old000001'));
    assert.ok(!res.json.removed.runs.includes('run-fresh00001'));
    assert.ok(res.json.kept.runs.includes('run-fresh00001'));

    assert.equal(fs.existsSync(path.join(dataDir, 'runs', 'run-old000001')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'runs', 'run-fresh00001')), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cleanup --dry-run removes nothing', () => {
  const dataDir = mkTempDataDir();
  try {
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    setUpRun(dataDir, 'run-old000002', oldIso);

    const res = runCleanup(['--retention-days', '14', '--dry-run'], dataDir);
    assert.equal(res.status, 0);
    assert.ok(res.json.removed.runs.includes('run-old000002'));
    assert.equal(fs.existsSync(path.join(dataDir, 'runs', 'run-old000002')), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cleanup --all empties all runs and telemetry regardless of age', () => {
  const dataDir = mkTempDataDir();
  try {
    const freshIso = new Date().toISOString();
    setUpRun(dataDir, 'run-fresh00002', freshIso);

    const res = runCleanup(['--all'], dataDir);
    assert.equal(res.status, 0);
    assert.ok(res.json.removed.runs.includes('run-fresh00002'));
    assert.equal(fs.existsSync(path.join(dataDir, 'runs', 'run-fresh00002')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'telemetry', 'run-fresh00002.jsonl')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
