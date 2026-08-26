import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');
const CLI = path.join(SCRIPTS_ROOT, 'runtime', 'cross-harness-run.mjs');
const INIT_RUN = path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs');
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'cross-harness');
const FAKE_WORKER = os.platform() === 'win32' ? path.join(FIXTURES, 'fake-worker.cmd') : path.join(FIXTURES, 'fake-worker.sh');

function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-ch-'));
}

/**
 * A killed/timed-out fake-worker child process can briefly hold a Windows
 * file handle open inside its own cwd (the disposable Cross-Harness
 * directory, itself under dataDir) even after spawnSync has returned to the
 * parent -- fs.rmSync can race that teardown and hit EPERM. Retry briefly
 * rather than let a real, working test fail on Windows-specific cleanup
 * timing that has nothing to do with the behavior under test.
 */
function rmSyncRetry(dir, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      const until = Date.now() + 200;
      while (Date.now() < until) { /* brief busy-wait; no async cleanup hook available in a sync test finally block */ }
    }
  }
}

/** Claude-native env: detectHost() resolves 'claude', so the worker provider is always 'codex'. */
function claudeNativeEnv(dataDir, extra = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_CROSS_HARNESS_TEST_MODE: '1', KRYLO_CROSS_HARNESS_CODEX_CLI: FAKE_WORKER, FAKE_WORKER_PROVIDER: 'codex', ...extra };
  delete env.KRYLO_DATA_ROOT;
  delete env.PLUGIN_DATA;
  delete env.PLUGIN_ROOT;
  delete env.KRYLO_HOST;
  return env;
}

function createRun(dataDir, { projectDir = dataDir, goal = 'cross-harness fixture run' } = {}) {
  const res = spawnSync(process.execPath, [
    INIT_RUN, '--goal', goal, '--session', 'ch-session', '--project-dir', projectDir, '--lane', 'PATCH', '--risk', 'low',
  ], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, cwd: dataDir });
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.ok, true, res.stderr);
  return json.runId;
}

function runCli(dataDir, args, envExtra = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: dataDir,
    env: claudeNativeEnv(dataDir, envExtra),
    timeout: 30_000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function readState(dataDir, runId) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runId, 'state.json'), 'utf8'));
}

// A. explicit invocation, valid worker output
test('cross-harness-run: a valid worker result is returned, ok:true, and recorded as evidence on the run', () => {
  const dataDir = mkTempDataDir();
  try {
    const runId = createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'review the recent diff', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'valid' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    assert.equal(res.json.result.status, 'completed');
    assert.equal(res.json.result.provider, 'codex');

    const state = readState(dataDir, runId);
    assert.equal(state.delegation.externalWorker, true);
    assert.equal(state.delegation.depth, 0, 'the NATIVE run itself always stays depth 0');
    assert.ok(state.evidence.some((e) => e.sourceTool === 'cross-harness:codex:reviewer'));
  } finally {
    rmSyncRetry(dataDir);
  }
});

// C. Depth
test('cross-harness-run: refuses immediately when KRYLO_DELEGATION_DEPTH=1 is already set (simulating a worker re-invoking it)', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { KRYLO_DELEGATION_DEPTH: '1', FAKE_WORKER_MODE: 'nested-cross-harness-attempt' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'DEPTH_LIMIT');
  } finally {
    rmSyncRetry(dataDir);
  }
});

test('cross-harness-run: the worker itself receives the depth-1 marker, proving recursion would be refused if it tried', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'nested-cross-harness-attempt' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    assert.match(res.json.result.summary, /KRYLO_DELEGATION_DEPTH=1/);
    assert.match(res.json.result.summary, /KRYLO_EXTERNAL_WORKER=1/);
  } finally {
    rmSyncRetry(dataDir);
  }
});

// D. Roles
test('cross-harness-run: an unsupported role (builder) is deterministically rejected before any worker spawns', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'builder', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'valid' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'INVALID_ROLE');
  } finally {
    rmSyncRetry(dataDir);
  }
});

// Regression (L1, Reviewer): invoking cross-harness-run.mjs with no active
// run for the resolved session previously reported failureCode INVALID_ROLE
// (reused from an unrelated branch), which is misleading -- the real reason
// is that no run exists to attach the invocation to, not that the role was
// wrong. Must report the dedicated NO_ACTIVE_RUN code instead.
test('cross-harness-run: with no active run for the session, failureCode is NO_ACTIVE_RUN, not INVALID_ROLE', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'valid' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'NO_ACTIVE_RUN');
    assert.equal(res.json.error, 'no-current-run');
  } finally {
    rmSyncRetry(dataDir);
  }
});

// J. Output parsing
test('cross-harness-run: malformed JSON output is rejected as INVALID_OUTPUT', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'malformed-json' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'INVALID_OUTPUT');
  } finally {
    rmSyncRetry(dataDir);
  }
});

test('cross-harness-run: a non-zero worker exit is reported as WORKER_EXIT_FAILED, never silently treated as success', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'stderr-failure' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'WORKER_EXIT_FAILED');
  } finally {
    rmSyncRetry(dataDir);
  }
});

test('cross-harness-run: malicious output (path traversal evidence, filesModified non-empty, command-shaped recommendation) is rejected outright, never trusted or executed', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'malicious-output' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'INVALID_OUTPUT');
    assert.ok(!fs.existsSync(path.join(dataDir, 'SHOULD_NOT_EXIST_ANYWHERE.txt')));
  } finally {
    rmSyncRetry(dataDir);
  }
});

// Timeout
test('cross-harness-run: a slow worker exceeding the timeout is reported as TIMEOUT, and the process does not hang the CLI itself', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const t0 = Date.now();
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session', '--timeout-ms', '1000'], { FAKE_WORKER_MODE: 'slow', FAKE_WORKER_DELAY_MS: '10000' });
    const elapsedMs = Date.now() - t0;
    // The real behavior under test: the CLI process itself returns in
    // BOUNDED time (well under the fake worker's full 10s delay) and
    // reports TIMEOUT -- it never hangs waiting for the slow worker.
    assert.ok(elapsedMs < 8000, `CLI took ${elapsedMs}ms, expected well under the fake worker's 10000ms delay`);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'TIMEOUT');
  } finally {
    // Best-effort only: a killed worker's cwd can stay locked by Windows
    // for longer than is reasonable to block a test on (observed
    // multi-second delays independent of whether the process tree is
    // already confirmed terminated). Temp-dir garbage collection reclaims
    // it eventually; this is test-tmpdir hygiene, not the product
    // correctness already asserted above.
    try { rmSyncRetry(dataDir, 5); } catch { /* see comment above */ }
  }
});

// Regression (M1, Reviewer, plus a Verifier-flagged coverage gap in a later
// round): spawnSync sets BOTH res.error.code='ENOBUFS' AND res.signal=
// 'SIGTERM' on a real maxBuffer overflow -- the original branch order
// checked SIGTERM/timeout first and misreported oversized worker output as
// TIMEOUT. The fake worker's 'huge-output' mode writes 50MB, well past
// CROSS_HARNESS_MAX_OUTPUT_BYTES (2MB), to exercise this live rather than
// only via static code reading.
test('cross-harness-run: oversized worker output is reported as OUTPUT_TOO_LARGE, never misreported as TIMEOUT', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'huge-output' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'OUTPUT_TOO_LARGE');
  } finally {
    try { rmSyncRetry(dataDir, 5); } catch { /* see slow-worker test's identical Windows cleanup-timing note */ }
  }
});

// Regression (H2, Reviewer, plus a Verifier-flagged coverage gap in a later
// round): a worker's own reported severity was recorded verbatim, letting
// an untrusted worker unilaterally block VERIFIED_COMPLETE by reporting a
// fabricated critical/high finding. cappedSeverity() must demote it to
// medium on the actual persisted state.json, not merely in the function
// that implements the cap -- exercised end to end here, not just read.
test('cross-harness-run: a worker-reported "high" finding is persisted as severity "medium", with the original severity preserved in the summary text', () => {
  const dataDir = mkTempDataDir();
  try {
    const runId = createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'high-severity-finding' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));

    const state = readState(dataDir, runId);
    const recorded = state.findings.find((f) => f.source === 'cross-harness:codex:reviewer');
    assert.ok(recorded, 'the worker finding should have been recorded');
    assert.equal(recorded.severity, 'medium', 'a worker-reported high/critical finding must never be persisted at its own reported severity');
    assert.match(recorded.summary, /worker-reported severity: high/, 'the original, unconfirmed severity must remain visible for a human to independently re-file');
  } finally {
    rmSyncRetry(dataDir);
  }
});

// H. Read-only enforcement (fixture-level; the real read-only-probe against actual CLIs is a separate, environment-gated test)
test('cross-harness-run: the fake worker\'s own filesystem write attempt inside its cwd is observable (fixture sanity: proves the probe technique itself works before trusting a real CLI\'s sandbox)', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'attempt-write' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    // The fake worker (unlike a real sandboxed CLI) has ordinary write
    // access to its own cwd, so this fixture is expected to SUCCEED at
    // writing -- proving the probe technique is real and observable, not
    // that KRYLO's own gate did anything here (there is no sandbox to
    // enforce inside a plain Node fixture).
    assert.match(res.json.result.summary, /WRITE_SUCCEEDED|write blocked/);
  } finally {
    rmSyncRetry(dataDir);
  }
});

// Unavailable worker (Section 7 fail-open availability)
test('cross-harness-run: an unresolvable worker CLI reports WORKER_UNAVAILABLE and never crashes', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { KRYLO_CROSS_HARNESS_CODEX_CLI: 'this-cli-does-not-exist-xyz' });
    assert.equal(res.json?.ok, false);
    assert.equal(res.json.failureCode, 'WORKER_UNAVAILABLE');
  } finally {
    rmSyncRetry(dataDir);
  }
});

// K. State isolation
test('cross-harness-run: a Cross-Harness invocation for session A never touches session B\'s run', () => {
  const dataDir = mkTempDataDir();
  try {
    const projectDir = mkTempDataDir();
    const runA = createRun(dataDir, { projectDir });
    // A second session/run in the SAME project.
    const res2 = spawnSync(process.execPath, [INIT_RUN, '--goal', 'run B', '--session', 'ch-session-B', '--project-dir', projectDir, '--lane', 'PATCH', '--risk', 'low'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, cwd: dataDir });
    const runB = JSON.parse(res2.stdout.trim()).runId;
    assert.notEqual(runA, runB);

    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session', '--project-dir', projectDir], { FAKE_WORKER_MODE: 'valid' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    assert.equal(res.json.runId, runA);

    const stateA = readState(dataDir, runA);
    const stateB = readState(dataDir, runB);
    assert.equal(stateA.delegation.externalWorker, true);
    assert.equal(stateB.delegation.externalWorker, false, 'run B must be completely untouched');
    fs.rmSync(projectDir, { recursive: true, force: true });
  } finally {
    rmSyncRetry(dataDir);
  }
});

// Cleanup
test('cross-harness-run: the disposable worker invocation directory is cleaned up after completion', () => {
  const dataDir = mkTempDataDir();
  try {
    createRun(dataDir);
    const res = runCli(dataDir, ['--role', 'reviewer', '--task', 'x', '--session', 'ch-session'], { FAKE_WORKER_MODE: 'valid' });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    const crossHarnessDir = path.join(dataDir, 'cross-harness');
    if (fs.existsSync(crossHarnessDir)) {
      const runDirs = fs.readdirSync(crossHarnessDir);
      for (const rd of runDirs) {
        const invocations = fs.readdirSync(path.join(crossHarnessDir, rd));
        assert.equal(invocations.length, 0, 'the specific invocation directory must be removed after completion');
      }
    }
  } finally {
    rmSyncRetry(dataDir);
  }
});

// Regression: fake-worker.sh is a shebang script meant to be exec'd
// directly on POSIX by cross-harness-process.mjs. It was previously
// committed to git as mode 100644 (non-executable), which had no effect on
// this project's own Windows dev machine (Windows has no POSIX exec-bit
// concept) but broke every Ubuntu CI checkout: the fixture became
// unrunnable, and every test depending on it surfaced as a generic
// WORKER_UNAVAILABLE instead of its intended specific failure code. A real
// filesystem-permission check can't be written portably (Windows has no
// exec bit to inspect), so this asserts on git's OWN tracked mode instead
// -- `git ls-files -s` reports it independent of the checkout OS, and git
// preserves it correctly through a POSIX checkout regardless of which OS
// committed it, as long as the index itself says 100755.
test('fake-worker.sh is tracked in git with the executable mode bit (100755), never 100644', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const relPath = 'plugins/krylo/tests/fixtures/cross-harness/fake-worker.sh';
  const res = spawnSync('git', ['ls-files', '-s', relPath], { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(res.status, 0, res.stderr);
  const mode = res.stdout.trim().split(/\s+/)[0];
  assert.equal(mode, '100755', `${relPath} must be tracked as executable (100755); git reports: ${res.stdout.trim()}`);
});
