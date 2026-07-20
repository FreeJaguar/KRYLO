import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { mkTempDataDir, createActiveRun, runCli, patchState, cleanup, SCRIPTS_ROOT } from '../hooks/helpers.mjs';

function runStatusline(dataDir, env = {}) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'status', 'subagent-statusline.mjs')], {
    encoding: 'utf8',
    input: '{}',
    // createActiveRun() defaults the fixture's project dir to dataDir; the
    // statusline resolves the active run from its own process.cwd(), so the
    // spawned process must run with that same directory as its cwd.
    cwd: dataDir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
  });
  return res;
}

test('statusline: no active run -> empty output, exit 0', () => {
  const dataDir = mkTempDataDir('krylo-status-');
  try {
    const res = runStatusline(dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('statusline: renders summary and agent rows without sensitive content', () => {
  const dataDir = mkTempDataDir('krylo-status-');
  try {
    const { statePath } = createActiveRun(dataDir);
    runCli('runtime/update-state.mjs', ['--add-criterion', 'endpoint returns CSV'], dataDir);
    patchState(statePath, (s) => {
      s.agents.push({
        id: 'agent-1',
        type: 'krylo:builder',
        configuredModel: 'sonnet',
        resolvedModel: null,
        status: 'running',
        startedAt: new Date(Date.now() - 48000).toISOString(),
        endedAt: null,
        taskLabel: 'implementing export flow',
      });
      s.phase = 'EXECUTING';
    });

    const res = runStatusline(dataDir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /KRYLO EXECUTING/);
    assert.match(res.stdout, /0\/1 AC/);
    assert.match(res.stdout, /krylo:builder \| sonnet \| working/);
    assert.match(res.stdout, /implementing export flow/);
  } finally {
    cleanup(dataDir);
  }
});

test('statusline: resolvedModel wins over configured alias when present', () => {
  const dataDir = mkTempDataDir('krylo-status-');
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (s) => {
      s.agents.push({
        id: 'agent-1',
        type: 'krylo:reviewer',
        configuredModel: 'opus',
        resolvedModel: 'claude-opus-4-6',
        status: 'running',
        startedAt: new Date(Date.now() - 130000).toISOString(),
        endedAt: null,
      });
    });
    const res = runStatusline(dataDir);
    assert.match(res.stdout, /claude-opus-4-6/);
    assert.match(res.stdout, /still working/);
  } finally {
    cleanup(dataDir);
  }
});

test('statusline: minimal detail renders only the summary line; long labels truncated', () => {
  const dataDir = mkTempDataDir('krylo-status-');
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (s) => {
      s.agents.push({
        id: 'agent-1',
        type: 'krylo:builder',
        configuredModel: 'sonnet',
        resolvedModel: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        taskLabel: 'x'.repeat(120),
      });
    });

    const minimal = runStatusline(dataDir, { CLAUDE_PLUGIN_OPTION_STATUS_DETAIL: 'minimal' });
    assert.equal(minimal.stdout.trim().split('\n').length, 1);

    const normal = runStatusline(dataDir);
    const agentLine = normal.stdout.split('\n').find((l) => l.startsWith('*'));
    assert.ok(agentLine.length < 120, 'agent line must truncate long labels');
  } finally {
    cleanup(dataDir);
  }
});

test('statusline: secret-bearing labels written through the CLI stay redacted', () => {
  const dataDir = mkTempDataDir('krylo-status-');
  try {
    const token = 'ghp_STATUSLEAK000000000000000000000000';
    createActiveRun(dataDir, { goal: `fix ${token} exposure` });
    const res = runStatusline(dataDir);
    assert.ok(!res.stdout.includes(token));
  } finally {
    cleanup(dataDir);
  }
});
