import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, patchState, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate.mjs';

function bashPayload(cwd, command) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}

function writePayload(cwd, filePath) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, cwd };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

const DENIED_COMMANDS = [
  ['git push origin main', 'git-push or git-force'],
  ['git -C /some/repo push origin main', 'git-push via -C (security finding 1)'],
  ['git -c user.name=x push origin main', 'git-push via -c'],
  ['git --git-dir=/r/.git push', 'git-push via --git-dir'],
  ['git push origin +main', 'force via +refspec'],
  ['git -C ../other reset --hard HEAD~1', 'destructive via -C'],
  ['git push --force origin main', 'force'],
  ['npm publish', 'publish'],
  ['gh release create v1.0.0', 'release'],
  ['terraform apply -auto-approve', 'deploy'],
  ['kubectl delete pod web-1', 'deploy'],
  ['psql -c "DROP TABLE users"', 'destructive'],
  ['supabase db reset', 'destructive'],
  ['git reset --hard HEAD~1', 'destructive'],
  ['gh pr merge 42', 'merge'],
  ['gh secret set DEPLOY_KEY', 'secrets'],
];

const ALLOWED_COMMANDS = [
  'npm test',
  'git status',
  'git commit -m "fix: adjust parser"',
  'node script.mjs --check',
  'npx vitest run',
];

test('risk-gate: production/destructive/publish commands are denied during an active run', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command] of DENIED_COMMANDS) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0, command);
      assert.equal(decision(res), 'deny', `expected deny for: ${command}`);
      // Prompt-injection / leak safety: the reason never echoes the command.
      assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(command),
        `reason must not echo the command: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: benign commands pass silently during an active run', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const command of ALLOWED_COMMANDS) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0, command);
      assert.equal(decision(res), null, `expected silent allow for: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: sensitive file targets are denied for Write and Bash', () => {
  const dataDir = mkTempDataDir();
  // Distinct project dir: in production the project is never the data root,
  // and a benign relative write must not resolve into the protected root.
  const projectDir = mkTempDataDir('krylo-proj-');
  try {
    createActiveRun(dataDir, { projectDir });
    for (const target of ['.env', '.env.local', 'config/secrets.yaml', '~/.ssh/id_rsa']) {
      const res = runHook(GATE, writePayload(projectDir, target), dataDir);
      assert.equal(decision(res), 'deny', `expected deny for Write ${target}`);
    }
    for (const command of ['cat .env', 'echo TOKEN=x >> .env']) {
      const res = runHook(GATE, bashPayload(projectDir, command), dataDir);
      assert.equal(decision(res), 'deny', `expected deny for: ${command}`);
    }
    const ok = runHook(GATE, writePayload(projectDir, 'src/app.js'), dataDir);
    assert.equal(decision(ok), null);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('risk-gate: approved override allows the matching class only', () => {
  const dataDir = mkTempDataDir();
  try {
    const { statePath } = createActiveRun(dataDir);
    patchState(statePath, (state) => {
      state.riskApprovals.push({
        id: 'ra-1',
        actionClass: 'git-push',
        status: 'approved',
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        summary: 'push approved by user for this task',
      });
    });
    const pushRes = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(pushRes), 'allow');

    const publishRes = runHook(GATE, bashPayload(dataDir, 'npm publish'), dataDir);
    assert.equal(decision(publishRes), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: KRYLO data root is integrity-protected (security finding 2)', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const stateTarget = `${dataDir.replace(/\\/g, '/')}/runs/x/state.json`;

    // Direct Write into the data root -> deny
    const w = runHook(GATE, writePayload(dataDir, stateTarget), dataDir);
    assert.equal(decision(w), 'deny');

    // Bash commands naming the pointer, wrapper config, or data root -> deny
    for (const command of [
      `rm ${dataDir.replace(/\\/g, '/')}/current-run.json`,
      'rm ~/.claude/plugins/data/krylo/current-run.json',
      `echo '{"originalCommand":["evil"]}' > ${dataDir.replace(/\\/g, '/')}/wrapper-config.json`,
      'del %USERPROFILE%\\.claude\\plugins\\data\\krylo\\current-run.json',
    ]) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(decision(res), 'deny', `expected deny for: ${command}`);
    }

    // Self-approval attempt through Edit -> deny
    const e = runHook(GATE, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: stateTarget, old_string: '"status": "pending"', new_string: '"status": "approved"' },
      cwd: dataDir,
    }, dataDir);
    assert.equal(decision(e), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: no active run -> everything passes silently', () => {
  const dataDir = mkTempDataDir();
  try {
    for (const command of ['git push --force', 'npm publish', 'terraform apply']) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '');
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: malformed stdin without active run passes silently', () => {
  const dataDir = mkTempDataDir();
  try {
    const res = runHook(GATE, null, dataDir, { rawInput: '{{{' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});
