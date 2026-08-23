import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { mkTempDataDir, createActiveRun, runHook, patchState, cleanup, SCRIPTS_ROOT } from './helpers.mjs';
import { fingerprintText } from '../../scripts/lib/action-fingerprint.mjs';

const GATE = 'security/risk-gate.mjs';

function bashPayload(cwd, command) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

function baseApproval(state, overrides = {}) {
  return {
    id: 'ra-1',
    actionClass: 'git-push',
    status: 'approved',
    requestedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    projectRootHash: state.project.rootHash,
    runId: state.runId,
    environment: null,
    expiresAt: null,
    consumedAt: null,
    fingerprint: null,
    target: null,
    summary: 'push feature branch',
    ...overrides,
  };
}

test('approval: exact match — a target-bound approval allows the identical command', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    const command = 'git push origin main';
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { fingerprint: fingerprintText(command), target: command }));
    });
    const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
    assert.equal(decision(res), 'allow');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: different target — a target-bound approval refuses a different command in the same class', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, {
        fingerprint: fingerprintText('git push origin main'),
        target: 'git push origin main',
      }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin dev'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: modified command — adding flags to the approved target refuses consumption', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, {
        actionClass: 'git-force',
        fingerprint: fingerprintText('git push origin main'),
        target: 'git push origin main',
      }));
    });
    // Same actionClass (git-force also matches --force pushes), different
    // exact command -> must not be authorized by an approval bound to the
    // unmodified push.
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main --force'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: expired approval is treated as not-approved', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: reused approval — an already-consumed approval cannot be spent again', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { status: 'consumed', consumedAt: new Date().toISOString() }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: wrong project — an approval bound to a different project root hash never matches', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { projectRootHash: 'f'.repeat(64) }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: wrong run — an approval bound to a different runId never matches', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { runId: 'run-000000000000' }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: wrong environment — an approval bound to a different security profile never matches', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { environment: 'production-read-only' }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir, {
      env: { CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'local-only' },
    });
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: matching environment consumes normally', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state, { environment: 'local-only' }));
    });
    const res = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir, {
      env: { CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'local-only' },
    });
    assert.equal(decision(res), 'allow');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: metadata never stores the raw command or a secret, only a redacted target and its hash', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state));
    });
    const secret = 'ghp_1234567890abcdefghijklmno';
    const res = runHook(GATE, bashPayload(dataDir, `git push origin main # token=${secret}`), dataDir);
    assert.equal(decision(res), 'allow');

    const stateRaw = fs.readFileSync(statePath, 'utf8');
    assert.ok(!stateRaw.includes(secret), 'raw secret must never be persisted in the approval record');
  } finally {
    cleanup(dataDir);
  }
});

test('approval: concurrent consumption — exactly one of two racing attempts spends the approval', async () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push(baseApproval(state));
    });

    const gatePath = path.join(SCRIPTS_ROOT, GATE);
    const runOnce = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [gatePath], {
        // CLAUDE_SESSION_ID must match createActiveRun()'s fixed
        // '--session hook-session' so the host-neutral resolveActiveRun()
        // binds to the run this test just created instead of treating the
        // payload (which, like real Claude payloads, carries no session_id)
        // as unidentifiable and failing open.
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_SESSION_ID: 'hook-session' },
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(out.trim() === '' ? null : JSON.parse(out.trim()));
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.write(JSON.stringify(bashPayload(dataDir, 'git push origin main')));
      child.stdin.end();
    });

    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    const decisions = [a, b].map((r) => r?.hookSpecificOutput?.permissionDecision ?? null);
    const allows = decisions.filter((d) => d === 'allow');
    const denies = decisions.filter((d) => d === 'deny');
    assert.equal(allows.length, 1, `expected exactly one allow, got ${JSON.stringify(decisions)}`);
    assert.equal(denies.length, 1, `expected exactly one deny, got ${JSON.stringify(decisions)}`);
  } finally {
    cleanup(dataDir);
  }
});
