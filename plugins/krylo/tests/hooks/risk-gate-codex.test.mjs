import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRunCodexOnly, runHookCodexOnly, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate-codex.mjs';

function bashPayload(cwd, command, permissionMode = 'default') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'shell',
    tool_input: { command },
    cwd,
    session_id: 'codex-hook-session',
    permission_mode: permissionMode,
  };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

test('risk-gate-codex: no active run -> everything passes silently (no output, exit 0)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'cat .env'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: malformed stdin without active run passes silently', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    const res = runHookCodexOnly(GATE, null, dataDir, { rawInput: 'not json' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: hard-deny (sensitive path) denies via the confirmed-supported permissionDecision:"deny" shape, never "ask"', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'cat .env'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(decision(res), 'deny');
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(typeof res.json.hookSpecificOutput.permissionDecisionReason === 'string');
    // The five confirmed-unsupported PreToolUse fields must never appear.
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.json.decision, undefined);
    assert.equal(res.json.continue, undefined);
    assert.equal(res.json.stopReason, undefined);
    assert.equal(res.json.suppressOutput, undefined);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: a benign command passes silently', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'ls -la'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});

// Security-critical: EVERY require-approval classification fails closed on
// Codex, regardless of permission_mode, since permissionDecision:"ask" is
// confirmed unsupported and no verified rule/PreToolUse ordering exists to
// trust instead (docs/adr/0029-codex-host-packaging-and-approval-boundary.md).
const REQUIRE_APPROVAL_COMMANDS = [
  ['git push origin main', 'git-push'],
  ['git push --force origin main', 'git-force'],
  ['npm publish', 'publish'],
  ['gh release create v1.0.0', 'release'],
  ['terraform apply -auto-approve', 'deploy'],
  ['kubectl delete pod web-1', 'deploy'],
];

for (const [command, label] of REQUIRE_APPROVAL_COMMANDS) {
  for (const permissionMode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', undefined, 'unknown-future-mode']) {
    test(`risk-gate-codex: require-approval (${label}) denies deterministically under permission_mode=${permissionMode} -- never "ask", never silently allowed`, () => {
      const dataDir = mkTempDataDir('krylo-codex-hook-');
      try {
        createActiveRunCodexOnly(dataDir);
        const payload = bashPayload(dataDir, command, permissionMode);
        if (permissionMode === undefined) delete payload.permission_mode;
        const res = runHookCodexOnly(GATE, payload, dataDir);
        assert.equal(res.status, 0);
        assert.equal(decision(res), 'deny', `${label} under permission_mode=${permissionMode} must deny, got: ${res.stdout}`);
        assert.notEqual(decision(res), 'ask', 'permissionDecision:"ask" is confirmed unsupported by current Codex docs and must never be emitted');
        assert.match(
          res.json.hookSpecificOutput.permissionDecisionReason,
          /outside the KRYLO autonomous run|explicitly supported Codex approval path/,
          'the deny reason must explain the capability gap, not just say "denied"',
        );
      } finally {
        cleanup(dataDir);
      }
    });
  }
}

test('risk-gate-codex: apply_patch tool name is preserved (not silently relabeled as Claude Edit/Write)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Begin Patch\n*** End Patch\n' },
      cwd: dataDir,
      session_id: 'codex-hook-session',
      permission_mode: 'default',
    };
    const res = runHookCodexOnly(GATE, payload, dataDir);
    assert.equal(res.status, 0);
    // A benign apply_patch payload with no sensitive path/require-approval
    // signal must pass silently, same as a benign Bash command -- proving
    // the tool name was normalized and reached classification rather than
    // erroring out or being treated as an unknown/denied surface.
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: exec_command tool name normalizes to Bash, same as shell', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'exec_command',
      tool_input: { command: 'cat .env' },
      cwd: dataDir,
      session_id: 'codex-hook-session',
      permission_mode: 'default',
    };
    const res = runHookCodexOnly(GATE, payload, dataDir);
    assert.equal(res.status, 0);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});
