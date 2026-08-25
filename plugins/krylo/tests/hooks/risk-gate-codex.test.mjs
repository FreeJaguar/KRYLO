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

// Session identity is no longer this gate's concern at all (independent
// review history, docs/adr/0029): the run is created exactly once, by
// scripts/security/user-prompt-submit-codex.mjs, using the authoritative
// host-supplied session_id from a Codex UserPromptSubmit event -- never by
// this PreToolUse gate, and never via any model-supplied or model-rewritten
// value. This gate simply resolves the already-active run the normal way
// (resolveActiveRun with the real session_id from ITS OWN hook payload),
// exactly like the Claude gate always has. These two tests confirm no
// leftover special-casing remains: a command that happens to mention the
// old placeholder text is treated as perfectly ordinary text, never
// specially denied.
test('risk-gate-codex: a benign command mentioning the retired session-placeholder text is treated as ordinary text, not specially denied', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'echo "KRYLO_CODEX_SESSION is retired"'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'this text has no special meaning to the gate anymore and must pass silently like any other benign command');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate-codex: a real KRYLO runtime CLI invocation with no --session flag at all passes silently (the model never supplies one)', () => {
  const dataDir = mkTempDataDir('krylo-codex-hook-');
  try {
    createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly(GATE, bashPayload(dataDir, 'node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --add-criterion "test"'), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});
