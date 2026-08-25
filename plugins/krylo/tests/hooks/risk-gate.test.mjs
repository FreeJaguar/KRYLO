import test from 'node:test';
import assert from 'node:assert/strict';

import { mkTempDataDir, createActiveRun, runHook, patchState, readState, cleanup } from './helpers.mjs';

const GATE = 'security/risk-gate.mjs';

function bashPayload(cwd, command) {
  // permission_mode: 'auto' matches the real, empirically-observed default
  // for a non-interactive Claude Code session with no --permission-mode
  // flag (confirmed live against the real 2.1.223 binary during this
  // checkpoint's verification pass) -- ASK_ELIGIBLE_PERMISSION_MODES in
  // risk-gate.mjs is an allowlist, so an ask-path test must supply an
  // eligible mode explicitly rather than relying on an absent field.
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, permission_mode: 'auto' };
}

function powershellPayload(cwd, command) {
  // permission_mode: 'auto' -- same reasoning as bashPayload() above: an
  // ask-path test must supply an eligible mode explicitly.
  return { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command }, cwd, permission_mode: 'auto' };
}

function writePayload(cwd, filePath) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, cwd };
}

function decision(res) {
  return res.json?.hookSpecificOutput?.permissionDecision ?? null;
}

// Native ask (docs/adr/0025-native-permission-approval.md, restored to full
// require-approval-class coverage by ADR-0027) now applies to every
// require-approval class, not only git-push/git-force -- KRYLO's own
// product contract requires a real human-approval path for every class
// policy classifies as require-approval, not a hard deny indistinguishable
// from a true deny.
const GIT_PUSH_OR_FORCE_COMMANDS = [
  ['git push origin main', 'git-push'],
  ['git -C /some/repo push origin main', 'git-push via -C (security finding 1)'],
  ['git -c user.name=x push origin main', 'git-push via -c'],
  ['git --git-dir=/r/.git push', 'git-push via --git-dir'],
  ['git push origin +main', 'git-force via +refspec'],
  ['git push --force origin main', 'git-force'],
];

const OTHER_GATED_COMMANDS = [
  ['git -C ../other reset --hard HEAD~1', 'destructive via -C'],
  ['kubectl -n prod delete pod x', 'production-deploy via -n flag (code review finding 1)'],
  ['kubectl --context prod apply -f x.yaml', 'production-deploy via --context flag'],
  ['aws --profile prod iam delete-user --user-name x', 'iam-or-secrets via --profile flag'],
  ['helm --namespace prod upgrade app ./chart', 'production-deploy via --namespace flag'],
  ['terraform -chdir=infra apply', 'production-deploy via -chdir flag'],
  ['docker --context prod push myimage:latest', 'package-publish via --context flag'],
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

const DENIED_COMMANDS = [...GIT_PUSH_OR_FORCE_COMMANDS, ...OTHER_GATED_COMMANDS];

// One representative Bash command per production-policy.json approvalClasses
// key, exhaustively -- the task's own explicit requirement ("for each class,
// document and test whether the final outcome is ask/deny/allow; do not
// leave a class accidentally unreachable"). Class names here are the exact
// keys, not free-text labels, so a class silently renamed or removed from
// the policy file would show up as a mismatch here, not just a missing test.
const ALL_TWELVE_REQUIRE_APPROVAL_CLASSES = [
  ['kubectl --context prod apply -f app.yaml', 'production-deploy'],
  ['prisma migrate deploy', 'production-data-write'],
  ['rm -rf /var/data', 'destructive-operation'],
  ['npm publish', 'package-publish'],
  ['gh release create v1.0.0', 'release'],
  ['git push origin main', 'git-push'],
  ['git push --force origin main', 'git-force'],
  ['gh pr merge 42', 'merge'],
  ['gh secret set DEPLOY_KEY', 'iam-or-secrets'],
  ['stripe charges create --amount 100', 'payment'],
  ['slack send "release is out"', 'external-message'],
  ['npx omniroute start', 'external-write'],
];

const ALLOWED_COMMANDS = [
  'npm test',
  'git status',
  'git commit -m "fix: adjust parser"',
  'node script.mjs --check',
  'npx vitest run',
];

test('risk-gate: every one of the 12 require-approval classes (ADR-0027) triggers ask under an eligible mode, and deny under an ineligible one -- no class is accidentally unreachable', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command, className] of ALL_TWELVE_REQUIRE_APPROVAL_CLASSES) {
      const askRes = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(decision(askRes), 'ask', `expected ask for class ${className}: ${command}`);

      const denyRes = runHook(GATE, { ...bashPayload(dataDir, command), permission_mode: 'bypassPermissions' }, dataDir);
      assert.equal(decision(denyRes), 'deny', `expected deny (bypassPermissions) for class ${className}: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: git push/force-push commands trigger a native ask prompt on Bash during an active run', () => {
  // Native permission approval (docs/adr/0025-native-permission-approval.md):
  // human authorization for git-push/git-force belongs to Claude Code's own
  // permission UI, reached via permissionDecision: "ask".
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command] of GIT_PUSH_OR_FORCE_COMMANDS) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0, command);
      assert.equal(decision(res), 'ask', `expected ask for: ${command}`);
      // Prompt-injection / leak safety: the reason never echoes the command.
      assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(command),
        `reason must not echo the command: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: permission_mode "default" -- an undocumented sixth CLI value, live-verified on the pinned 2.1.223 floor -- also triggers ask, not deny', () => {
  // A second independent review round found `--permission-mode default`
  // (absent from `claude --help`'s own choices list but silently accepted
  // by the CLI) produces `"permission_mode":"default"` in the real Hook
  // payload, and live testing on the pinned 2.1.223 binary confirmed it
  // honors a hook's `ask` decision identically to `auto`/`manual`
  // (docs/adr/0025-native-permission-approval.md). Excluding it would have
  // silently made native ask inert for whatever real sessions actually use
  // this mode.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const res = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' },
      cwd: dataDir, permission_mode: 'default',
    }, dataDir);
    assert.equal(decision(res), 'ask');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: every other production/destructive/publish/release/merge/secrets class ALSO triggers native ask on Bash, not just git-push/git-force (ADR-0027)', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command] of OTHER_GATED_COMMANDS) {
      const res = runHook(GATE, bashPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0, command);
      assert.equal(decision(res), 'ask', `expected ask for: ${command}`);
      assert.ok(!res.json.hookSpecificOutput.permissionDecisionReason.includes(command),
        `reason must not echo the command: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: every require-approval class (git-push/git-force included) still falls back to deny when the permission mode is not ask-eligible', () => {
  // Restoring native ask to every class (ADR-0027) must not weaken the
  // existing fail-safe: an ineligible mode (bypassPermissions, an unknown
  // mode, or an absent field) still denies every one of these classes, not
  // only the two that were ask-eligible before this checkpoint.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command] of DENIED_COMMANDS) {
      const bypassRes = runHook(GATE, { ...bashPayload(dataDir, command), permission_mode: 'bypassPermissions' }, dataDir);
      assert.equal(decision(bypassRes), 'deny', `expected deny (bypassPermissions) for: ${command}`);
      const noModeRes = runHook(GATE, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dataDir }, dataDir);
      assert.equal(decision(noModeRes), 'deny', `expected deny (absent permission_mode) for: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: an unknown, absent, or future permission_mode falls back to deny, not ask (allowlist, not a denylist)', () => {
  // Independent security review found the original check
  // (`permission_mode !== 'bypassPermissions'`) was a denylist, inverted
  // relative to the tool-name and action-class checks in the same
  // expression (both allowlists) -- an absent field, a renamed mode, or a
  // brand-new upstream mode would all fail toward the unconfirmed 'ask'
  // path. ASK_ELIGIBLE_PERMISSION_MODES is now an allowlist: only modes
  // actually verified live to honor a hook's ask decision are eligible.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const mode of [undefined, 'plan', 'acceptEdits', 'dontAsk', 'somethingNew']) {
      const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: dataDir, ...(mode !== undefined ? { permission_mode: mode } : {}) };
      const res = runHook(GATE, payload, dataDir);
      assert.equal(decision(res), 'deny', `expected deny for permission_mode=${mode}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: git push/force-push in bypassPermissions mode falls back to deny, not ask', () => {
  // permission_mode: "bypassPermissions" is a session mode whose documented
  // purpose is skipping permission prompts -- the v2.1.211 auto-mode-ask-
  // flooring guarantee says nothing about it, so trusting ask there would be
  // exactly the unconfirmed leap this checkpoint's evidence discipline
  // forbids.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const payload = { ...bashPayload(dataDir, 'git push origin main'), permission_mode: 'bypassPermissions' };
    const res = runHook(GATE, payload, dataDir);
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: bypassPermissions still falls back to deny even when session_id is missing (degraded identity)', () => {
  // Independent security review found that normalizeClaudeHookPayload()'s
  // degraded (session-less) identity path omits permissionMode entirely, so
  // checking normalized.identity.permissionMode would let a bypassPermissions
  // session with an unresolvable session_id slip through to 'ask'. The gate
  // must read permission_mode directly off the raw payload instead.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir); // the sole active run, resolved via the ADR-0020 fallback
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      cwd: dataDir,
      permission_mode: 'bypassPermissions',
      // session_id deliberately omitted
    };
    const res = runHook(GATE, payload, dataDir, { env: { CLAUDE_SESSION_ID: undefined } });
    assert.equal(decision(res), 'deny');
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: the same production/destructive/publish commands trigger native ask via the PowerShell tool too, same classification as Bash (ADR-0027, PowerShell risk parity)', () => {
  // ADR-0027 restores PowerShell to equal footing with Bash for native ask:
  // official documentation states PreToolUse hooks run before the
  // permission prompt for every tool, and risk CLASSIFICATION was already
  // identical for both tools (tests/unit/risk-policy.test.mjs) -- there is
  // no principled reason for the resulting Hook decision to differ once the
  // permission mode itself is eligible.
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    for (const [command] of DENIED_COMMANDS) {
      const res = runHook(GATE, powershellPayload(dataDir, command), dataDir);
      assert.equal(res.status, 0, command);
      assert.equal(decision(res), 'ask', `expected ask for PowerShell: ${command}`);
    }
  } finally {
    cleanup(dataDir);
  }
});

test('risk-gate: PowerShell require-approval classes still fall back to deny under an ineligible permission mode', () => {
  const dataDir = mkTempDataDir();
  try {
    createActiveRun(dataDir);
    const res = runHook(GATE, { ...powershellPayload(dataDir, 'git push origin main'), permission_mode: 'bypassPermissions' }, dataDir);
    assert.equal(decision(res), 'deny');
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

test('risk-gate: sensitive file targets and data-root/hook-entrypoint protection hold for the PowerShell tool too', () => {
  const dataDir = mkTempDataDir();
  const projectDir = mkTempDataDir('krylo-proj-');
  try {
    createActiveRun(dataDir, { projectDir });

    for (const command of ['Get-Content .env', 'Add-Content .env -Value TOKEN=x']) {
      const res = runHook(GATE, powershellPayload(projectDir, command), dataDir);
      assert.equal(decision(res), 'deny', `expected deny for PowerShell: ${command}`);
    }

    const dataRootCmd = `Remove-Item -Recurse -Force ${dataDir.replace(/\\/g, '/')}/current-run.json`;
    const dataRootRes = runHook(GATE, powershellPayload(projectDir, dataRootCmd), dataDir);
    assert.equal(decision(dataRootRes), 'deny');

    const hookEntrypointRes = runHook(GATE, powershellPayload(
      projectDir, 'node plugins/krylo/scripts/security/risk-gate.mjs',
    ), dataDir);
    assert.equal(decision(hookEntrypointRes), 'deny');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('risk-gate: the model cannot weaken Claude Code\'s own settings.json/settings.local.json through the real Hook (Foundation final-closure Section B)', () => {
  const dataDir = mkTempDataDir();
  const projectDir = mkTempDataDir('krylo-proj-');
  try {
    createActiveRun(dataDir, { projectDir });
    for (const target of ['.claude/settings.json', '.claude/settings.local.json']) {
      const writeRes = runHook(GATE, {
        hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: '{"permissions":{"allow":["Bash"]}}' }, cwd: projectDir,
      }, dataDir);
      assert.equal(decision(writeRes), 'deny', `expected deny for Write(${target})`);

      const bashRes = runHook(GATE, bashPayload(projectDir, `echo x >> ${target}`), dataDir);
      assert.equal(decision(bashRes), 'deny', `expected deny for a Bash command referencing ${target}`);
    }
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
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

    // Read/Glob/Grep must be gated too (HIGH finding, independent security
    // review): a model denied on `cat .env` via Bash must not be able to
    // read the identical content by switching to a different tool. Each
    // tool_input below uses that tool's REAL parameter shape (a second
    // independent review round found the first fix's test used a synthetic
    // `file_path` payload Grep/Glob never actually send, masking a real
    // bypass through Grep's `glob` and Glob's `pattern` fields).
    const readDeny = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(readDeny), 'deny', 'expected deny for Read(.env)');

    const grepPathDeny = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: '.', path: '.env' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(grepPathDeny), 'deny', 'expected deny for Grep(path: .env)');

    // Reproduced bypass (second independent review round): Grep's `glob`
    // field, not `path`, was the unchecked route to the same file content.
    const grepGlobDeny = runHook(GATE, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: '.', glob: '**/.env', output_mode: 'content' },
      cwd: projectDir,
    }, dataDir);
    assert.equal(decision(grepGlobDeny), 'deny', 'expected deny for Grep(glob: **/.env, output_mode: content)');

    // Reproduced bypass: Glob's real field is `pattern`, not `file_path`.
    const globPatternDeny = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/.env' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(globPatternDeny), 'deny', 'expected deny for Glob(pattern: **/.env)');

    const benignRead = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/app.js' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(benignRead), null);

    const benignGrep = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'TODO', glob: '**/*.js' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(benignGrep), null, 'a benign content search must not be denied merely for containing a search pattern');

    const benignGlob = runHook(GATE, {
      hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.js' }, cwd: projectDir,
    }, dataDir);
    assert.equal(decision(benignGlob), null);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('risk-gate: a pre-existing local "approved" riskApprovals record cannot authorize execution on its own', () => {
  // Security requirement (docs/adr/0025-native-permission-approval.md):
  // KRYLO-local approval records may persist for audit/state purposes only,
  // and must never independently authorize an action -- authority belongs to
  // Claude Code's own native permission UI. Even a matching, unconsumed,
  // 'approved' record for the exact action class must still route through
  // the native ask prompt, not bypass it.
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
        summary: 'a stale/historical local approval record',
      });
    });
    const pushRes = runHook(GATE, bashPayload(dataDir, 'git push origin main'), dataDir);
    assert.equal(decision(pushRes), 'ask');

    // The local record itself is left completely untouched -- it is never
    // read, consumed, or mutated by the risk gate any more.
    assert.equal(readState(statePath).riskApprovals[0].status, 'approved');
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
