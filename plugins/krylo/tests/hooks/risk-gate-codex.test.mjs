import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRunCodexOnly, runHookCodexOnly, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate-codex.mjs';

// tool_name: 'Bash' is the REAL, confirmed value -- an independent review
// plus direct byte inspection of the installed codex-cli 0.120.0 binary's
// own embedded PreToolUse JSON schema found `tool_name` is a schema CONST
// of "Bash" for every command-hook invocation on this build (not "shell" as
// earlier documentation-sourced assumptions used). The hooks.json matcher
// and this suite's default payload were both corrected to match; a
// dedicated test below additionally confirms 'shell'/'exec_command' still
// normalize correctly too, in case a different/future build differentiates.
function bashPayload(cwd, command, permissionMode = 'default') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
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

// apply_patch has its own tool identity (never silently relabeled as
// Claude's Edit/Write, per the task's explicit instruction), but a
// pre-review round confirmed it also had NO case anywhere in the shared
// risk-policy classifier at all -- it silently fell through to the
// unconditional final `pass` every genuinely unrecognized tool name
// reaches. A real, reproduced .env read/write/exfiltration bypass, not a
// hypothetical gap: `*** Update File: .env` and `*** Add File: .env`
// (with real-looking secret content) both classified as `pass`. Fixed by
// extracting every `*** Add|Update|Delete File:`/`*** Move to:` target from
// the patch text and running each through the same hard-deny/sensitive-path
// checks Write/Edit/NotebookEdit already get.
function applyPatchPayload(cwd, patch) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { patch },
    cwd,
    session_id: 'codex-hook-session',
    permission_mode: 'default',
  };
}

test('risk-gate-codex: apply_patch targeting a sensitive path (.env) denies -- the confirmed Critical bypass, now closed', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const updatePatch = '*** Begin Patch\n*** Update File: .env\n@@\n-OLD=1\n+API_KEY=stolen\n*** End Patch\n';
    const updateRes = runHookCodexOnly(GATE, applyPatchPayload(dataDir, updatePatch), dataDir);
    assert.equal(updateRes.status, 0);
    assert.equal(decision(updateRes), 'deny', `apply_patch Update File: .env must deny, got: ${updateRes.stdout}`);
    assert.equal(updateRes.json.hookSpecificOutput.hookEventName, 'PreToolUse');

    const addPatch = '*** Begin Patch\n*** Add File: .env\n+API_KEY=exfiltrated123\n*** End Patch\n';
    const addRes = runHookCodexOnly(GATE, applyPatchPayload(dataDir, addPatch), dataDir);
    assert.equal(decision(addRes), 'deny', `apply_patch Add File: .env must deny, got: ${addRes.stdout}`);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: apply_patch targeting an ordinary, non-sensitive file passes silently (not a blanket apply_patch deny)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  // A separate project directory, distinct from dataDir (which doubles as
  // PLUGIN_DATA/the data root in this test env): a relative patch target
  // resolved against dataDir itself would spuriously land inside the data
  // root and trigger data-root-protection, unrelated to what this test
  // means to exercise.
  const projectDir = mkTempDataDir('krylo-codex-hook-project-');
  try {
    createActiveRunCodexOnly(dataDir, { projectDir });
    const patch = '*** Begin Patch\n*** Update File: src/index.js\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch\n';
    const res = runHookCodexOnly(GATE, applyPatchPayload(projectDir, patch), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'a benign apply_patch to an ordinary file must pass silently, proving the tool name reached classification and this is not a blanket apply_patch deny');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('risk-gate-codex: apply_patch with an unparseable/empty patch (no extractable file target) fails safe -- deny, never a silent pass', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const noHeaders = runHookCodexOnly(GATE, applyPatchPayload(dataDir, '*** Begin Patch\n*** End Patch\n'), dataDir);
    assert.equal(decision(noHeaders), 'deny', `unparseable patch must fail safe (deny), got: ${noHeaders.stdout}`);

    const missingPatchField = runHookCodexOnly(GATE, {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {},
      cwd: dataDir,
      session_id: 'codex-hook-session',
      permission_mode: 'default',
    }, dataDir);
    assert.equal(decision(missingPatchField), 'deny', `a missing patch field must fail safe (deny), got: ${missingPatchField.stdout}`);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: apply_patch touching KRYLO\'s own data root or the plugin installation denies, same protection Write/Edit already get', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    // dataDir doubles as PLUGIN_DATA (see codexOnlyEnv in helpers.mjs), so a
    // patch targeting a path inside it is a data-root-protection case.
    const dataRootPatch = `*** Begin Patch\n*** Update File: ${dataDir}/current-run.json\n@@\n-x\n+y\n*** End Patch\n`;
    const dataRootRes = runHookCodexOnly(GATE, applyPatchPayload(dataDir, dataRootPatch), dataDir);
    assert.equal(decision(dataRootRes), 'deny', `apply_patch touching the data root must deny, got: ${dataRootRes.stdout}`);
    assert.match(dataRootRes.json.hookSpecificOutput.permissionDecisionReason, /data directory|data root/i);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: apply_patch renaming a file INTO a sensitive path via "*** Move to:" also denies', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const movePatch = '*** Begin Patch\n*** Update File: notes.txt\n*** Move to: .env\n@@\n-x\n+y\n*** End Patch\n';
    const res = runHookCodexOnly(GATE, applyPatchPayload(dataDir, movePatch), dataDir);
    assert.equal(decision(res), 'deny', `a rename destination landing on a sensitive path must deny, got: ${res.stdout}`);
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

// Security-critical, independent review finding: current Codex docs do not
// expose the real session_id to the MODEL (only to Hooks -- confirmed open
// upstream gap, openai/codex#8923). The Skill instructs the model to use a
// fixed literal placeholder for --session; this hook -- the only place that
// ever sees both the real session_id and the command about to run --
// substitutes it before the command executes, via Codex's own
// confirmed-supported "allow" + updatedInput rewrite. Without this, a
// model-invented session id would never match the real one every
// subsequent hook resolves, silently disabling enforcement for the whole
// run (reproduced by an independent Reviewer against the unfixed code).
test('risk-gate-codex: the KRYLO_CODEX_SESSION placeholder in the bootstrapping init-run.mjs call is rewritten to the REAL session id, even with no active run yet', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    // Deliberately NO createActiveRunCodexOnly() call: this is exactly the
    // bootstrapping case, before any KRYLO run exists.
    const realSessionId = 'real-codex-session-abc123';
    const command = `node "\${PLUGIN_ROOT}/scripts/runtime/init-run.mjs" --goal "test" --session "KRYLO_CODEX_SESSION" --lane PATCH --risk low`;
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: dataDir,
      session_id: realSessionId,
      permission_mode: 'default',
    };
    const res = runHookCodexOnly(GATE, payload, dataDir);
    assert.equal(res.status, 0);
    assert.equal(decision(res), 'allow', `expected an allow+rewrite decision, got: ${res.stdout}`);
    const rewrittenCommand = res.json.hookSpecificOutput.updatedInput.command;
    assert.ok(rewrittenCommand.includes(`--session "${realSessionId}"`), `rewritten command must contain the real session id, got: ${rewrittenCommand}`);
    assert.ok(!rewrittenCommand.includes('KRYLO_CODEX_SESSION'), 'the placeholder must not remain in the rewritten command');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: the session placeholder rewrite also applies once a run is active (update-state.mjs/read-state.mjs calls)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const command = 'node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "KRYLO_CODEX_SESSION" --add-criterion "test"';
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: dataDir,
      session_id: 'codex-hook-session',
      permission_mode: 'default',
    };
    const res = runHookCodexOnly(GATE, payload, dataDir);
    assert.equal(decision(res), 'allow');
    assert.ok(res.json.hookSpecificOutput.updatedInput.command.includes('--session "codex-hook-session"'));
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: a placeholder-bearing command that would otherwise deny is NOT allowed through via the rewrite (rewrite never bypasses a deny)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    // A dangerous command that happens to also contain the literal
    // placeholder text -- must still deny, never be rewritten-and-allowed.
    const command = 'cat .env; echo "KRYLO_CODEX_SESSION"';
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: dataDir,
      session_id: 'codex-hook-session',
      permission_mode: 'default',
    };
    const res = runHookCodexOnly(GATE, payload, dataDir);
    assert.equal(decision(res), 'deny', `a sensitive-path command must still deny even if it contains the session placeholder text, got: ${res.stdout}`);
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: a command with no placeholder is never rewritten (no spurious "allow" for an ordinary passing command)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'ls -la'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ordinary command with no placeholder must pass silently, not go through the allow+rewrite path');
  } finally {
    cleanup(dataDir);
  }
});
