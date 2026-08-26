// Codex Cross-Harness provider adapter (docs/adr/0030-cross-harness-advisory-workers.md):
// capability detection, argv construction, and process lifecycle for
// invoking `codex exec` as a READ-ONLY advisory worker. Contains no policy
// logic (role/depth/egress validation lives in scripts/lib/cross-harness.mjs)
// -- this module only knows how to talk to the Codex CLI safely.
//
// Read-only enforcement (task Section 10): `--sandbox read-only` (OS-level
// sandbox, one of exactly three documented values), `-c approval_policy=never`
// (never blocks waiting for a human that does not exist in this
// non-interactive context -- execution failures are returned to the model
// directly, never escalated or auto-approved), `--skip-git-repo-check`
// (the disposable directory is not a git repo), `--ephemeral` (no session
// file persisted), no `--add-dir` (zero additional writable directories),
// never `--dangerously-bypass-approvals-and-sandbox`.
//
// The task/context payload is sent via STDIN, never argv (task Section 12):
// `codex exec` documents reading instructions from stdin when no PROMPT
// argument is given. The worker's system-prompt / prompt-injection-boundary
// text (scripts/lib/cross-harness.mjs's buildWorkerSystemPrompt) has no
// dedicated CLI flag on this build (confirmed: `codex exec --help` lists no
// system-prompt-style option), so it is prepended to the same stdin payload.

import { spawnSync } from 'node:child_process';

import { CROSS_HARNESS_MAX_OUTPUT_BYTES, CROSS_HARNESS_TIMEOUT_MS } from '../../lib/cross-harness.mjs';
import { platformSpawnTarget, killProcessTree } from '../../lib/spawn-platform.mjs';

export function detectCodexWorkerCapability({ cliPath = 'codex', env = process.env } = {}) {
  try {
    const target = platformSpawnTarget(cliPath, ['--version']);
    if (!target) return { available: false, reason: 'WORKER_UNAVAILABLE' };
    const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 64 * 1024, env });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') {
      return { available: false, reason: 'WORKER_UNAVAILABLE' };
    }
    const version = res.stdout.trim().split('\n')[0].slice(0, 80);
    if (!/^codex-cli\s+\d+\.\d+\.\d+/.test(version)) {
      return { available: false, reason: 'WORKER_UNSUPPORTED_VERSION', version };
    }
    return { available: true, version };
  } catch {
    return { available: false, reason: 'WORKER_UNAVAILABLE' };
  }
}

/**
 * Build the argv array for `codex exec`. Never includes task/context text --
 * that is written to stdin by the caller. Exported separately from the
 * spawn call so process-security tests can assert on the exact argv without
 * actually launching a process.
 */
export function buildCodexWorkerArgv({ cwd, outputSchemaPath }) {
  return [
    'exec',
    '--sandbox', 'read-only',
    '-c', 'approval_policy=never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--output-schema', outputSchemaPath,
    '--json',
    '-C', cwd,
    '-',
  ];
}

/**
 * Explicit environment allowlist for the worker child process -- the
 * parent's full process.env is never passed through (task Section 13).
 * Recursion-prevention markers (MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md
 * Section 12.7) are always included.
 */
export function buildCodexWorkerEnv({ runId, parentEnv = process.env }) {
  const allowed = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (typeof parentEnv[key] === 'string') allowed[key] = parentEnv[key];
  }
  // Test-only hook, gated behind the same KRYLO_CROSS_HARNESS_TEST_MODE
  // sentinel as the CLI-path override (cross-harness-run.mjs) -- see
  // claude-worker.mjs's identical comment for why this is no longer
  // unconditional.
  if (parentEnv.KRYLO_CROSS_HARNESS_TEST_MODE === '1') {
    for (const [key, value] of Object.entries(parentEnv)) {
      if (key.startsWith('FAKE_WORKER_') && typeof value === 'string') allowed[key] = value;
    }
  }
  return {
    ...allowed,
    KRYLO_EXTERNAL_WORKER: '1',
    KRYLO_PARENT_RUN_ID: runId,
    KRYLO_DELEGATION_DEPTH: '1',
  };
}

/**
 * Spawn the Codex worker and return the RAW result -- never parses or
 * trusts stdout as a result here (scripts/lib/cross-harness.mjs's
 * validateCrossHarnessResult owns that). shell:false always; argv array
 * built by buildCodexWorkerArgv, never a concatenated string.
 */
export function spawnCodexWorker({ cliPath = 'codex', cwd, outputSchemaPath, stdinPayload, runId, timeoutMs = CROSS_HARNESS_TIMEOUT_MS, env = process.env }) {
  const argv = buildCodexWorkerArgv({ cwd, outputSchemaPath });
  const childEnv = buildCodexWorkerEnv({ runId, parentEnv: env });
  const target = platformSpawnTarget(cliPath, argv);
  if (!target) return { ok: false, failureCode: 'WORKER_UNAVAILABLE' };
  const { command, args } = target;
  try {
    const res = spawnSync(command, args, {
      cwd,
      input: stdinPayload,
      encoding: 'utf8',
      shell: false,
      timeout: timeoutMs,
      maxBuffer: CROSS_HARNESS_MAX_OUTPUT_BYTES,
      env: childEnv,
    });
    // A real maxBuffer overflow's signaling is NOT consistent across
    // platforms -- on this project's own Windows dev machine, spawnSync
    // reliably sets BOTH res.error.code='ENOBUFS' AND res.signal='SIGTERM'
    // (confirmed directly there, and checked BEFORE the timeout check below
    // since the original branch order misreported it as TIMEOUT). A fresh
    // evidence-first investigation of a real Ubuntu CI failure confirmed
    // Linux instead silently truncates res.stdout to (approximately)
    // maxBuffer bytes with NO res.error and NO res.signal at all -- that
    // fell through every branch below and was misreported as INVALID_OUTPUT
    // once the truncated, non-JSON-parseable text reached
    // parseCodexWorkerOutput(). Checking res.stdout's own length against
    // the configured limit first is the one signal that is unambiguous and
    // platform-independent: no legitimate worker result should ever
    // approach CROSS_HARNESS_MAX_OUTPUT_BYTES (every field this schema
    // accepts is separately length-capped elsewhere). The ENOBUFS check
    // below is kept as a second, redundant signal for whichever platform
    // still sets it.
    if (typeof res.stdout === 'string' && res.stdout.length >= CROSS_HARNESS_MAX_OUTPUT_BYTES) {
      killProcessTree(res.pid);
      return { ok: false, failureCode: 'OUTPUT_TOO_LARGE' };
    }
    if (res.error?.code === 'ENOBUFS') {
      killProcessTree(res.pid);
      return { ok: false, failureCode: 'OUTPUT_TOO_LARGE' };
    }
    if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') {
      // spawnSync's own timeout only reliably reaches the DIRECT child.
      // platformSpawnTarget() resolves and invokes the worker CLI's real
      // target directly (no cmd.exe indirection since the spawn-platform.mjs
      // rewrite -- see that module's own header comment), but the worker
      // CLI itself may spawn its OWN subprocesses internally; killProcessTree
      // kills the whole tree so a slow/hung worker never survives past the
      // reported TIMEOUT regardless of what it spawned underneath itself.
      killProcessTree(res.pid);
      return { ok: false, failureCode: 'TIMEOUT' };
    }
    if (res.error) {
      return { ok: false, failureCode: 'SPAWN_FAILED' };
    }
    if (typeof res.stdout !== 'string' || res.stdout.length === 0) {
      return { ok: false, failureCode: res.status === 0 ? 'INVALID_OUTPUT' : 'WORKER_EXIT_FAILED' };
    }
    return { ok: true, stdout: res.stdout, stderr: res.stderr ?? '', status: res.status };
  } catch {
    return { ok: false, failureCode: 'SPAWN_FAILED' };
  }
}

/**
 * Extract the model's final JSON result from `codex exec --json`'s JSONL
 * event stream. Never throws on malformed input -- returns a failure
 * result instead, which the caller feeds straight into
 * validateCrossHarnessResult() as an INVALID_OUTPUT case.
 */
export function parseCodexWorkerOutput(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]);
      const text = event?.msg?.last_agent_message ?? event?.last_agent_message ?? event?.message;
      if (typeof text === 'string' && text.trim() !== '') {
        return JSON.parse(text);
      }
      if (event && typeof event === 'object' && 'schemaVersion' in event) {
        return event;
      }
    } catch {
      // Not the final-result line; keep scanning backwards.
    }
  }
  return null;
}
