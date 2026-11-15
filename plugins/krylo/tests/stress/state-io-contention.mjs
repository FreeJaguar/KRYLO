#!/usr/bin/env node
// Opt-in stress reproduction for lost run-state updates under concurrent
// hook load (docs/adr/0044-transient-state-io-retry.md). Not part of
// `npm test` (the file name deliberately does not match *.test.mjs): it
// takes minutes, and its signal is statistical, not a single assertion.
//
// Each round creates `copies` independent runs in parallel and fires `n`
// concurrent posttool-telemetry.mjs processes at each one. A round is lost
// when the run's tool counter ends below `n`. On Windows before ADR-0044 the
// rename of state.json lost the race against the other hooks' lock-free
// reads often enough to show here; run it alongside `npm test` for the
// heavier load the intermittent CI failures came from.
//
// Usage:
//   node plugins/krylo/tests/stress/state-io-contention.mjs [rounds=40] [copies=6] [n=15]
// Exits 1 if any increment was lost or any corrupt-state sidecar appeared.
// Uses only fresh temp data roots; never touches a real KRYLO data root.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const HOOK = path.join(SCRIPTS_ROOT, 'runtime', 'posttool-telemetry.mjs');
const INIT_RUN = path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs');

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const rounds = positiveInt(process.argv[2], 40);
const copies = positiveInt(process.argv[3], 6);
const n = positiveInt(process.argv[4], 15);

function isolatedEnv(dataDir, extra = {}) {
  return { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, KRYLO_LOCAL_TELEMETRY: 'true', ...extra };
}

function createRun() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-stress-'));
  const res = spawnSync(process.execPath, [INIT_RUN, '--goal', 'stress', '--session', 'hook-session',
    '--project-dir', dataDir, '--lane', 'PATCH', '--risk', 'low'], { encoding: 'utf8', cwd: dataDir, env: isolatedEnv(dataDir) });
  const json = JSON.parse(res.stdout.trim());
  if (!json.ok) throw new Error(`init-run failed: ${res.stdout} ${res.stderr}`);
  return { dataDir, runId: json.runId, statePath: path.join(dataDir, 'runs', json.runId, 'state.json') };
}

function fireHook(env, dataDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env });
    child.stdout.resume();
    child.stderr.resume();
    child.on('close', (code) => resolve(code));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Grep', duration_ms: 1, cwd: dataDir }));
  });
}

async function oneRun() {
  const { dataDir, runId, statePath } = createRun();
  try {
    const env = isolatedEnv(dataDir, { CLAUDE_SESSION_ID: 'hook-session' });
    const codes = await Promise.all(Array.from({ length: n }, () => fireHook(env, dataDir)));
    const counter = JSON.parse(fs.readFileSync(statePath, 'utf8')).toolCounters.Grep ?? 0;
    const corrupt = fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')).length;
    const telemetryFile = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
    const notPersisted = fs.existsSync(telemetryFile)
      ? fs.readFileSync(telemetryFile, 'utf8').split('\n').filter((l) => l.includes('"counter-not-persisted"')).length
      : 0;
    return { lost: n - counter, corrupt, notPersisted, nonZeroExit: codes.filter((c) => c !== 0).length };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const totals = { runs: 0, lostRuns: 0, lostIncrements: 0, counterNotPersisted: 0, corruptSidecars: 0, nonZeroExit: 0 };
const started = Date.now();
for (let r = 0; r < rounds; r++) {
  for (const res of await Promise.all(Array.from({ length: copies }, oneRun))) {
    totals.runs++;
    if (res.lost > 0) totals.lostRuns++;
    totals.lostIncrements += Math.max(0, res.lost);
    totals.counterNotPersisted += res.notPersisted;
    totals.corruptSidecars += res.corrupt;
    totals.nonZeroExit += res.nonZeroExit;
  }
}
console.log(JSON.stringify({ platform: process.platform, rounds, copies, n, ...totals, seconds: Math.round((Date.now() - started) / 1000) }));
process.exit(totals.lostIncrements > 0 || totals.corruptSidecars > 0 || totals.nonZeroExit > 0 ? 1 : 0);
