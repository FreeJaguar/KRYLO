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
    // falling back to a real, non-isolated data root. KRYLO_LOCAL_TELEMETRY
    // is forced 'true' so a test asserting telemetry was recorded is never
    // environment-dependent on whatever the outer shell happens to have set
    // (regression found by a fresh independent Reviewer).
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, KRYLO_LOCAL_TELEMETRY: 'true' },
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
    // See runCli() above for why CLAUDE_PLUGIN_DATA/KRYLO_DATA_ROOT/
    // KRYLO_LOCAL_TELEMETRY are all set explicitly here.
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_DATA_ROOT: dataDir, CLAUDE_SESSION_ID: 'hook-session', KRYLO_LOCAL_TELEMETRY: 'true', ...env },
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

/**
 * Claude-only variants of runCli()/runHook()/createActiveRun() for the
 * multi-host-foundation regression requirement (docs/process/
 * MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md, Task 8, Step 1): set ONLY
 * CLAUDE_PLUGIN_DATA (never KRYLO_DATA_ROOT, explicitly deleted even if
 * inherited from the outer shell) so every write/read genuinely exercises
 * the Claude host adapter's own CLAUDE_PLUGIN_DATA -> KRYLO_DATA_ROOT
 * bootstrap instead of a directly-set host-neutral override.
 */
function claudeOnlyEnv(dataDir, extra = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_LOCAL_TELEMETRY: 'true', ...extra };
  delete env.KRYLO_DATA_ROOT;
  return env;
}

export function runCliClaudeOnly(scriptRelPath, args, dataDir) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    cwd: dataDir,
    env: claudeOnlyEnv(dataDir),
  });
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function runHookClaudeOnly(scriptRelPath, payload, dataDir, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath)], {
    encoding: 'utf8',
    input,
    env: claudeOnlyEnv(dataDir, { CLAUDE_SESSION_ID: 'hook-session', ...env }),
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function createActiveRunClaudeOnly(dataDir, { projectDir = dataDir, goal = 'hook fixture run', lane = 'PATCH', risk = 'low' } = {}) {
  const res = runCliClaudeOnly('runtime/init-run.mjs', [
    '--goal', goal,
    '--session', 'hook-session',
    '--project-dir', projectDir,
    '--lane', lane,
    '--risk', risk,
  ], dataDir);
  if (res.status !== 0 || !res.json?.ok) {
    throw new Error(`fixture init-run (Claude-only env) failed: ${res.stdout} ${res.stderr}`);
  }
  return {
    runId: res.json.runId,
    statePath: path.join(dataDir, 'runs', res.json.runId, 'state.json'),
  };
}

/**
 * Codex-only variants of runCli()/runHook()/createActiveRun(): set ONLY
 * PLUGIN_DATA and PLUGIN_ROOT (never KRYLO_DATA_ROOT, never a
 * CLAUDE_SESSION_ID-style env fallback for Claude) plus KRYLO_HOST=codex so
 * host-dispatch.mjs's detection is exercised the same way a real Codex
 * plugin invocation would set it, and every write/read genuinely exercises
 * the Codex host adapter's own PLUGIN_DATA -> KRYLO_DATA_ROOT bootstrap
 * instead of a directly-set host-neutral override. Any CODEX_THREAD_ID
 * inherited from the real outer shell is stripped BEFORE `extra` is
 * applied, so a test that does not care about it never accidentally
 * exercises resolveCodexSessionId()'s CODEX_THREAD_ID fallback via ambient
 * process.env leakage, while a test that explicitly wants to exercise that
 * fallback can still pass `{ env: { CODEX_THREAD_ID: '...' } }` and have it
 * take effect.
 */
function codexOnlyEnv(dataDir, extra = {}) {
  const env = { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: dataDir, KRYLO_HOST: 'codex', KRYLO_LOCAL_TELEMETRY: 'true' };
  delete env.KRYLO_DATA_ROOT;
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return { ...env, ...extra };
}

export function runCliCodexOnly(scriptRelPath, args, dataDir, { env } = {}) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath), ...args], {
    encoding: 'utf8',
    cwd: dataDir,
    env: codexOnlyEnv(dataDir, env),
  });
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function runHookCodexOnly(scriptRelPath, payload, dataDir, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, scriptRelPath)], {
    encoding: 'utf8',
    input,
    env: codexOnlyEnv(dataDir, env),
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function createActiveRunCodexOnly(dataDir, { projectDir = dataDir, goal = 'codex hook fixture run', lane = 'PATCH', risk = 'low' } = {}) {
  const res = runCliCodexOnly('runtime/init-run.mjs', [
    '--goal', goal,
    '--session', 'codex-hook-session',
    '--project-dir', projectDir,
    '--lane', lane,
    '--risk', risk,
  ], dataDir);
  if (res.status !== 0 || !res.json?.ok) {
    throw new Error(`fixture init-run (Codex-only env) failed: ${res.stdout} ${res.stderr}`);
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

/**
 * Path to a fake-CLI fixture that a test can hand to KRYLO as a worker or
 * Codex CLI, without making the test depend on a Windows PATH lookup.
 *
 * The committed Windows fixtures (`fake-worker.cmd`, `fake-codex-cli.cmd`)
 * copy npm cmd-shim's real shape, including its bare `"node"` invocation.
 * scripts/lib/spawn-platform.mjs resolves that bare name by spawning
 * `where node` under a 4s anti-hang budget (PATH_LOOKUP_TIMEOUT_MS), and on a
 * contended runner that subprocess alone can exceed the budget. The lookup
 * is then reported as 'lookup-timeout', the CLI as unavailable, and a test
 * whose subject is something else entirely fails. Observed on
 * windows-latest CI: `WORKER_UNAVAILABLE` after ~4.9s in cross-harness-run,
 * and `probe-timeout` in the project hook launcher, in the same run.
 * Reproduced locally: `where node` exceeded 4s under CPU load, and
 * resolving the committed `fake-worker.cmd` returned 'lookup-timeout'.
 *
 * On Windows this writes an equivalent shim whose invocation line names
 * node by its absolute path (process.execPath), so resolution takes the
 * absolute-path branch and spawns nothing. Everything after resolution is
 * unchanged: the same shim parser, the same shell:false spawn of node.exe
 * with the fixture script, the same argv and stdin. Tests whose SUBJECT is
 * the bare-`node` PATH lookup (tests/unit/spawn-platform.test.mjs,
 * tests/unit/runtime-compat.test.mjs) must keep using the committed
 * fixtures directly. On POSIX there is no shim layer, so the committed
 * `.sh` fixture is returned unchanged.
 *
 * `fixtureDir` holds `<stem>.mjs` and `<stem>.sh`. The generated shim lives
 * in a per-process temp directory removed on exit.
 */
export function fakeCliWithoutPathLookup(fixtureDir, stem) {
  if (os.platform() !== 'win32') return path.join(fixtureDir, `${stem}.sh`);
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-fake-cli-'));
  process.on('exit', () => {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  });
  const shimPath = path.join(shimDir, `${stem}.cmd`);
  fs.writeFileSync(shimPath, `@ECHO off\r\n"${process.execPath}" "${path.join(fixtureDir, `${stem}.mjs`)}" %*\r\n`);
  return shimPath;
}
