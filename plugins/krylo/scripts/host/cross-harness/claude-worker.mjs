// Claude Cross-Harness provider adapter (docs/adr/0030-cross-harness-advisory-workers.md):
// capability detection, argv construction, and process lifecycle for
// invoking `claude -p` as a READ-ONLY advisory worker. Contains no policy
// logic (role/depth/egress validation lives in scripts/lib/cross-harness.mjs)
// -- this module only knows how to talk to the Claude CLI safely.
//
// Read-only enforcement (task Section 10), layered rather than trusting one
// mechanism alone: `--tools Read,Grep,Glob` (no Bash/PowerShell/Write/Edit/
// NotebookEdit/WebFetch/WebSearch tool is even AVAILABLE to the worker,
// regardless of what it is told -- this is the real, sufficient enforcement),
// `--strict-mcp-config` with no `--mcp-config` (zero MCP servers),
// `--setting-sources ""` (no user/
// project/local settings file is loaded, so no personal hook or MCP
// configuration can apply inside the worker's own process), `--no-session-
// persistence` (the worker's own conversation is never saved/resumable).
// Never `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`.
//
// Deliberately NOT `--bare`: a real live probe against this environment's
// actual authenticated session (OAuth via claude.ai, not an API key) found
// `--bare` makes the worker unable to authenticate at all -- its own
// documented contract states plainly that in --bare mode "OAuth and
// keychain are never read" and only `ANTHROPIC_API_KEY`/`apiKeyHelper` are
// accepted. Since OAuth is the common, documented default authentication
// path (not merely this environment's own setup), `--bare` would have
// silently made Cross-Harness's Claude worker direction nonfunctional for
// the majority of real users. `--setting-sources ""` reproduces --bare's
// settings-file isolation (no hook/hooks.json, no personal MCP config, no
// personal CLAUDE.md picked up) without touching the auth path.
//
// The task/context payload is sent via STDIN, never argv (task Section 12).
// The worker's system-prompt / prompt-injection-boundary text
// (scripts/lib/cross-harness.mjs's buildWorkerSystemPrompt) is fixed,
// KRYLO-authored text with no task/source content in it, so it is passed
// via `--append-system-prompt` directly (a real CLI-documented flag);
// only the actual repository context goes through stdin.

import { spawnSync } from 'node:child_process';

import { CROSS_HARNESS_MAX_OUTPUT_BYTES, CROSS_HARNESS_TIMEOUT_MS } from '../../lib/cross-harness.mjs';
import { platformSpawnTarget, killProcessTree } from '../../lib/spawn-platform.mjs';

const READ_ONLY_TOOLS = 'Read,Grep,Glob';

export function detectClaudeWorkerCapability({ cliPath = 'claude', env = process.env } = {}) {
  try {
    const target = platformSpawnTarget(cliPath, ['--version']);
    if (!target) return { available: false, reason: 'WORKER_UNAVAILABLE' };
    const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 64 * 1024, env });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') {
      return { available: false, reason: 'WORKER_UNAVAILABLE' };
    }
    const version = res.stdout.trim().split('\n')[0].slice(0, 80);
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return { available: false, reason: 'WORKER_UNSUPPORTED_VERSION', version };
    }
    return { available: true, version };
  } catch {
    return { available: false, reason: 'WORKER_UNAVAILABLE' };
  }
}

/**
 * Build the argv array for `claude -p`. Never includes task/context text --
 * that is written to stdin by the caller; systemPrompt/jsonSchema are
 * fixed, non-secret KRYLO-authored content, safe to pass as argument
 * values. `--json-schema` is a first line of defense constraining the
 * model's final response shape (mirroring Codex's `--output-schema`) --
 * scripts/lib/cross-harness.mjs's validateCrossHarnessResult() remains
 * authoritative regardless of whether the platform enforces it.
 */
export function buildClaudeWorkerArgv({ systemPrompt, jsonSchema }) {
  // Deliberately NOT --permission-mode plan (present in an earlier draft
  // of this function, and once genuinely a live suspect while debugging
  // the --json-schema structured-output failure -- a fresh independent
  // Reviewer caught it still being shipped after this comment, ADR-0030,
  // and the capability matrix all already documented its removal, which
  // was itself a real bug, now fixed here to match). --tools above already
  // excludes every write-capable tool regardless of permission mode, so
  // Plan Mode's own "conclude with a plan" semantics add no verified
  // protection for a worker that will never have a Write tool to plan
  // into -- pure surface area, removed.
  return [
    '-p',
    '--setting-sources', '',
    '--tools', READ_ONLY_TOOLS,
    '--strict-mcp-config',
    '--output-format', 'json',
    '--no-session-persistence',
    '--append-system-prompt', systemPrompt,
    ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : []),
  ];
}

/**
 * Explicit environment allowlist for the worker child process -- the
 * parent's full process.env is never passed through (task Section 13).
 * Recursion-prevention markers (MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md
 * Section 12.7) are always included.
 */
export function buildClaudeWorkerEnv({ runId, parentEnv = process.env }) {
  const allowed = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (typeof parentEnv[key] === 'string') allowed[key] = parentEnv[key];
  }
  // Test-only hook, gated behind the same KRYLO_CROSS_HARNESS_TEST_MODE
  // sentinel as the CLI-path override (cross-harness-run.mjs) -- a fresh
  // independent Reviewer found the earlier, unconditional version of this
  // passthrough was reachable in a real production invocation (nothing
  // gated it), so any FAKE_WORKER_*-prefixed variable an attacker could
  // smuggle into the environment would silently reach the real worker
  // process. Only tests/fixtures/cross-harness/fake-worker.mjs consumes
  // these, and only plugins/krylo/tests/hooks/cross-harness-run.test.mjs
  // sets the sentinel.
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
 * Spawn the Claude worker and return the RAW result -- never parses or
 * trusts stdout as a result here (scripts/lib/cross-harness.mjs's
 * validateCrossHarnessResult owns that). shell:false always; argv array
 * built by buildClaudeWorkerArgv, never a concatenated string. cwd is the
 * disposable Cross-Harness directory (claude has no -C/--cd flag on this
 * build; cwd is set via the child_process option instead).
 */
export function spawnClaudeWorker({ cliPath = 'claude', cwd, systemPrompt, jsonSchema, stdinPayload, runId, timeoutMs = CROSS_HARNESS_TIMEOUT_MS, env = process.env }) {
  const argv = buildClaudeWorkerArgv({ systemPrompt, jsonSchema });
  const childEnv = buildClaudeWorkerEnv({ runId, parentEnv: env });
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
    // ENOBUFS (real maxBuffer overflow) is checked BEFORE the timeout
    // check: a fresh independent Reviewer found spawnSync sets BOTH
    // res.error.code='ENOBUFS' AND res.signal='SIGTERM' when the child's
    // output exceeds maxBuffer (confirmed directly: an oversized-output
    // fixture was reported as TIMEOUT, not OUTPUT_TOO_LARGE, in the
    // original branch order). spawnSync never throws on maxBuffer overflow
    // -- that is an execSync/execFileSync-only behavior -- so the old
    // `catch (err) { if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') ... }`
    // below was dead code, removed.
    if (res.error?.code === 'ENOBUFS') {
      killProcessTree(res.pid);
      return { ok: false, failureCode: 'OUTPUT_TOO_LARGE' };
    }
    if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') {
      // See codex-worker.mjs's identical comment: spawnSync's own timeout
      // only reaches the direct child (the worker CLI's real target,
      // resolved directly by platformSpawnTarget() -- no cmd.exe
      // indirection since the spawn-platform.mjs rewrite), never a
      // subprocess the worker CLI spawns internally -- kill the whole tree
      // explicitly.
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
 * Extract the model's final JSON result from `claude -p --output-format
 * json --json-schema <schema>`'s output. Two real, live-confirmed shapes
 * exist, and which one appears depends on other flags combined with
 * `--json-schema` (confirmed: adding `--append-system-prompt` changes
 * which shape is produced, even with `--output-format json` present in
 * both cases) -- so this checks for all of them rather than assuming one:
 *   1. The `--output-format json` envelope with a dedicated
 *      `structured_output` field holding the already-parsed,
 *      schema-conformant object directly (seen with no custom system
 *      prompt).
 *   2. The RAW schema-conformant object printed directly to stdout, with
 *      no envelope at all -- `--output-format json`'s own wrapping did not
 *      apply (seen with `--append-system-prompt` present). Detected by the
 *      parsed top-level object itself already carrying `schemaVersion`.
 *   3. Fallback: the envelope's `result` field (a plain string) holding
 *      the model's raw text, which may itself be JSON (optionally wrapped
 *      in a markdown code fence the model added despite instructions not
 *      to) -- covers any other shape not yet seen live.
 * validateCrossHarnessResult() (scripts/lib/cross-harness.mjs) remains the
 * actual authority regardless of which path extracted the object. Never
 * throws on malformed input.
 */
export function parseClaudeWorkerOutput(stdout) {
  try {
    const outer = JSON.parse(stdout);
    if (outer && typeof outer === 'object') {
      if (outer.structured_output && typeof outer.structured_output === 'object') {
        return outer.structured_output;
      }
      if ('schemaVersion' in outer) {
        return outer;
      }
    }
    let text = typeof outer?.result === 'string' ? outer.result : null;
    if (text === null) return null;
    text = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fenced) text = fenced[1];
    return JSON.parse(text);
  } catch {
    return null;
  }
}
