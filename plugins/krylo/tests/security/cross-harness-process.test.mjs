// Cross-Harness process-spawning security (task Section 12/23-G): argv
// arrays only, shell:false always, no task/context text ever reaches
// argv, and a malicious task string cannot inject shell syntax end to end
// through the real CLI (not just the isolated spawn-platform primitive
// already covered by tests/unit/spawn-platform.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildCodexWorkerArgv, buildCodexWorkerEnv } from '../../scripts/host/cross-harness/codex-worker.mjs';
import { buildClaudeWorkerArgv, buildClaudeWorkerEnv } from '../../scripts/host/cross-harness/claude-worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');
const CLI = path.join(SCRIPTS_ROOT, 'runtime', 'cross-harness-run.mjs');
const INIT_RUN = path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs');
const FAKE_WORKER = path.resolve(__dirname, '..', 'fixtures', 'cross-harness', os.platform() === 'win32' ? 'fake-worker.cmd' : 'fake-worker.sh');

test('buildCodexWorkerArgv returns a plain argv array with no task/context text embedded', () => {
  const argv = buildCodexWorkerArgv({ cwd: 'C:\\some\\dir with spaces\\', outputSchemaPath: 'C:\\schema.json' });
  assert.ok(Array.isArray(argv));
  for (const el of argv) assert.equal(typeof el, 'string');
  assert.deepEqual(argv, ['exec', '--sandbox', 'read-only', '-c', 'approval_policy=never', '--skip-git-repo-check', '--ephemeral', '--output-schema', 'C:\\schema.json', '--json', '-C', 'C:\\some\\dir with spaces\\', '-']);
});

test('buildClaudeWorkerArgv returns a plain argv array; the only variable content is the fixed system-prompt text, never task/repository content', () => {
  const argv = buildClaudeWorkerArgv({ systemPrompt: 'FIXED BOUNDARY TEXT' });
  assert.ok(Array.isArray(argv));
  assert.ok(argv.includes('--tools'));
  assert.ok(argv.includes('Read,Grep,Glob'), 'no write/shell/MCP tool must ever be in the allowlist');
  assert.ok(!argv.some((el) => el.includes('Bash') || el.includes('Write') || el.includes('Edit') || el.includes('WebFetch') || el.includes('WebSearch')));
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
});

test('buildCodexWorkerEnv/buildClaudeWorkerEnv never pass through an arbitrary secret-shaped env var from the parent', () => {
  const parentEnv = { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'super-secret', GITHUB_TOKEN: 'ghp_x', DATABASE_URL: 'postgres://...', RANDOM_VAR: 'x' };
  for (const build of [buildCodexWorkerEnv, buildClaudeWorkerEnv]) {
    const env = build({ runId: 'run-abc', parentEnv });
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
    assert.ok(!('GITHUB_TOKEN' in env));
    assert.ok(!('DATABASE_URL' in env));
    assert.ok(!('RANDOM_VAR' in env));
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KRYLO_EXTERNAL_WORKER, '1');
    assert.equal(env.KRYLO_PARENT_RUN_ID, 'run-abc');
    assert.equal(env.KRYLO_DELEGATION_DEPTH, '1');
  }
});

// End-to-end: a malicious TASK string (the one field that ultimately comes
// from the model/user and could contain shell metacharacters) must never
// reach argv or be interpreted as shell syntax anywhere in the real
// spawn chain -- it only ever reaches the worker via stdin.
test('a task string containing shell metacharacters cannot inject a command through the real CLI/adapter/spawn-platform chain', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-ch-sec-'));
  try {
    const initRes = spawnSync(process.execPath, [INIT_RUN, '--goal', 'sec test', '--session', 'sec-session', '--project-dir', dataDir, '--lane', 'PATCH', '--risk', 'low'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
    assert.equal(JSON.parse(initRes.stdout.trim()).ok, true, initRes.stderr);

    const maliciousTask = 'review this && echo INJECTED > proof.txt; $(echo also-injected); `echo backtick-injected`';
    const res = spawnSync(process.execPath, [CLI, '--role', 'reviewer', '--task', maliciousTask, '--session', 'sec-session'], {
      encoding: 'utf8',
      cwd: dataDir,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        KRYLO_CROSS_HARNESS_CODEX_CLI: FAKE_WORKER,
        FAKE_WORKER_PROVIDER: 'codex',
        FAKE_WORKER_MODE: 'valid',
      },
      timeout: 30_000,
    });
    delete res.env; // n/a, just documenting nothing leaked back

    assert.ok(!fs.existsSync(path.join(dataDir, 'proof.txt')), 'the injected command must never actually execute anywhere in the chain');
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.ok, true, JSON.stringify(json));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
