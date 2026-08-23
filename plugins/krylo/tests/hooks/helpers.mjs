// Shared helpers for hook fixture tests: create an isolated data dir with an
// active run, patch its state for scenarios, and pipe hook payloads into the
// gate scripts exactly the way Claude Code does (stdin JSON).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');

export function mkTempDataDir(prefix = 'krylo-hook-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Spawn a runtime CLI (init-run, update-state, ...) against a data dir.
 * Runs with cwd = dataDir so a call that omits --run/--project-dir resolves
 * the active-run pointer the same way createActiveRun()'s default project
 * dir (also dataDir) was recorded.
 */
export function runCli(scriptRelPath, args, dataDir) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    cwd: dataDir,
    // Both are set deliberately: CLAUDE_PLUGIN_DATA is what the Claude host
    // adapter bootstrap reads (and, once bootstrapped, KRYLO_DATA_ROOT is
    // derived from it and overwritten to the SAME dataDir); KRYLO_DATA_ROOT
    // is also set directly so an entrypoint that has not yet been wired to
    // the Claude adapter still resolves to this isolated temp dir instead of
    // falling back to a real, non-isolated data root.
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir },
  });
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/**
 * Pipe a hook payload into a hook script. Returns status/stdout/parsed JSON.
 *
 * CLAUDE_SESSION_ID defaults to 'hook-session' so a fixture payload that
 * (like real Claude PreToolUse/Stop/PostToolUse payloads normally do not)
 * omits `session_id` still normalizes to the same host session that
 * createActiveRun() below always registers via `--session hook-session`.
 * Pass `env: { CLAUDE_SESSION_ID: ... }` (or unset it) to exercise a
 * different or missing session explicitly.
 */
export function runHook(scriptRelPath, payload, dataDir, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath)], {
    encoding: 'utf8',
    input,
    // See runCli() above for why CLAUDE_PLUGIN_DATA/KRYLO_DATA_ROOT are both
    // set to the same isolated temp dataDir.
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, CLAUDE_SESSION_ID: 'hook-session', ...env },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/**
 * Create an active run whose project root is `projectDir` (defaults to the
 * data dir itself). Returns { runId, statePath }.
 */
export function createActiveRun(dataDir, { projectDir = dataDir, goal = 'hook fixture run', lane = 'PATCH', risk = 'low' } = {}) {
  const res = runCli('runtime/init-run.mjs', [
    '--goal', goal,
    '--session', 'hook-session',
    '--project-dir', projectDir,
    '--lane', lane,
    '--risk', risk,
  ], dataDir);
  if (res.status !== 0 || !res.json?.ok) {
    throw new Error(`fixture init-run failed: ${res.stdout} ${res.stderr}`);
  }
  return {
    runId: res.json.runId,
    statePath: path.join(dataDir, 'runs', res.json.runId, 'state.json'),
  };
}

/** Read, patch, and write a run's state.json directly (fixture surgery). */
export function patchState(statePath, mutator) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  mutator(state);
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  return state;
}

export function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

/** All persisted bytes for leak assertions: state + telemetry. */
export function persistedBytes(dataDir) {
  let out = '';
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out += fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(dataDir, 'runs'));
  walk(path.join(dataDir, 'telemetry'));
  return out;
}

export function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
