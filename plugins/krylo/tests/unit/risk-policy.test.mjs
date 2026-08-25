// Direct tests for the shared, host-neutral risk policy: classifyRiskAction
// is called directly (no Hook process spawn, no Claude JSON), so a
// contributor changing scripts/security/risk-policy.mjs gets fast, precise
// feedback here, and scripts/security/risk-gate.mjs (the Claude adapter) is
// exercised end-to-end separately by tests/hooks/risk-gate*.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRiskAction } from '../../scripts/security/risk-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RISK_POLICY_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'security', 'risk-policy.mjs');

// Platform-safe temp dir: os.tmpdir() resolves to the real system temp
// location on Windows, macOS, and Linux alike (never a hardcoded /tmp). The
// directory is only ever used as a string for data-root-protection matching
// in these tests, never created or written to.
function tempDataRoot() {
  return path.join(os.tmpdir(), 'krylo-risk-policy-test-data-root');
}

test('shared risk policy classifies git push without Claude Hook JSON', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-push');
  assert.equal(result.category, 'git-push');
  assert.equal('hookSpecificOutput' in result, false);
});

test('shared risk policy classifies every one of the 12 production-policy.json approvalClasses correctly, by exact class name', () => {
  // Task requirement (ADR-0027): review the complete require-approval class
  // matrix and do not leave a class accidentally unreachable. This asserts
  // the exact actionClass name for one representative command per class, so
  // a class silently renamed or removed from the policy file surfaces as a
  // test failure here, not merely as a missing test.
  const cases = [
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
  for (const [command, expectedClass] of cases) {
    const result = classifyRiskAction({
      toolName: 'Bash',
      toolInput: { command },
      cwd: process.cwd(),
      dataRoot: tempDataRoot(),
    });
    assert.equal(result.action, 'require-approval', `expected require-approval for ${expectedClass}: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected actionClass ${expectedClass} for: ${command}`);
  }
});

test('shared risk policy classifies a git force-push as git-force, not the more general git-push', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'git push --force origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-force');
});

test('shared risk policy passes npm test', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
  assert.equal(result.category, 'pass');
});

test('shared risk policy denies a protected secret path for Write', () => {
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: '.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
  assert.equal(typeof result.reason, 'string');
});

test('shared risk policy denies a protected secret path for Read, Glob, and Grep (not just Bash/Write)', () => {
  // Independent security review found that Read/Glob/Grep were entirely
  // absent from the risk-gate matcher and from classifyRiskAction()'s
  // tool-name branches: a model denied on `cat .env` via Bash could simply
  // switch to Read(".env") and read the identical content ungated.
  const readDeny = classifyRiskAction({
    toolName: 'Read',
    toolInput: { file_path: '.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(readDeny.action, 'deny');
  assert.equal(readDeny.category, 'sensitive-path');

  // Grep's real schema carries `path` and, separately, `glob` -- a second
  // independent review round found the first fix checked only `path`,
  // leaving `glob` (which Grep(pattern, glob, output_mode: 'content') can
  // use to return an arbitrary file's *content*) completely unchecked.
  const grepByPath = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { path: '.env', pattern: 'SECRET' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(grepByPath.action, 'deny');
  assert.equal(grepByPath.category, 'sensitive-path');

  const grepByGlob = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { pattern: '.', glob: '**/.env', output_mode: 'content' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(grepByGlob.action, 'deny', 'Grep(glob: **/.env) must be denied, not just Grep(path: .env)');
  assert.equal(grepByGlob.category, 'sensitive-path');

  // Glob has no `file_path` field at all -- its real path-shaped field is
  // `pattern` itself (the second bypass reproduced by the same review).
  const globByPattern = classifyRiskAction({
    toolName: 'Glob',
    toolInput: { pattern: '**/.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(globByPattern.action, 'deny', 'Glob(pattern: **/.env) must be denied');
  assert.equal(globByPattern.category, 'sensitive-path');
});

test('shared risk policy passes a benign Read/Glob/Grep target', () => {
  const benignRead = classifyRiskAction({
    toolName: 'Read',
    toolInput: { file_path: 'src/app.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignRead.action, 'pass');

  // A Grep search PATTERN (the content regex, not a path) must never be
  // matched against sensitive-path patterns -- only `path`/`glob` are
  // path-shaped for Grep. Searching *for* the text ".env" across ordinary
  // source files is not the same as reading a secret file.
  const benignGrep = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { pattern: '.env', glob: '**/*.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignGrep.action, 'pass', 'Grep pattern text must not itself be treated as a path');

  const benignGlob = classifyRiskAction({
    toolName: 'Glob',
    toolInput: { pattern: '**/*.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignGlob.action, 'pass');
});

test('shared risk policy denies a Bash command that reads a protected secret path', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'cat .env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
  // Prompt-injection / leak safety: the reason never echoes the command.
  assert.ok(!result.reason.includes('cat .env'));
});

test('shared risk policy denies direct writes into the KRYLO data root', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: path.join(dataRoot, 'runs', 'x', 'state.json') },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via ~/.krylo/data (tilde shorthand)', () => {
  // ADDITIONAL HARDENING (security-hardening checkpoint): the new
  // multi-host design introduces ~/.krylo/data as the future shared data
  // root. A model could reference it in a Bash command using the tilde
  // shorthand, or $HOME/%USERPROFILE% env-var expansion, rather than the
  // literal resolved absolute path -- the shell still expands it to the
  // same location, so the protection must not be bypassable just because
  // the command text spells the path conventionally instead of literally.
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'rm -rf ~/.krylo/data/runs' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via $HOME (POSIX env var)', () => {
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'cat $HOME/.krylo/data/runs/x/state.json' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via %USERPROFILE% (Windows env var)', () => {
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'type %USERPROFILE%\\.krylo\\data\\runs\\x\\state.json' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Write reaching the data root through a symlinked directory (escape via symlink)', () => {
  // ADDITIONAL HARDENING (security-hardening checkpoint): path.resolve()
  // alone does not follow symlinks, so a symlink OUTSIDE the data root that
  // points INTO it would previously escape detection -- the nominal
  // (unresolved) path never starts with the data root's own literal path,
  // even though writing through the symlink lands inside it for real.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-symlink-test-'));
  try {
    const dataRoot = path.join(base, 'real-data-root');
    fs.mkdirSync(dataRoot, { recursive: true });
    const outsideDir = path.join(base, 'looks-harmless');
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkPath = path.join(outsideDir, 'link-to-data-root');
    try {
      fs.symlinkSync(dataRoot, linkPath, 'junction');
    } catch {
      // Symlink/junction creation can require elevated privileges in some
      // environments; skip rather than fail the suite on an unrelated
      // permissions gap.
      return;
    }

    const result = classifyRiskAction({
      toolName: 'Write',
      toolInput: { file_path: path.join(linkPath, 'runs', 'x', 'state.json') },
      cwd: outsideDir,
      dataRoot,
    });
    assert.equal(result.action, 'deny');
    assert.equal(result.category, 'data-root-protection');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('shared risk policy denies a Bash or PowerShell command directly invoking a KRYLO Hook entrypoint', () => {
  // A model must not be able to forge PostToolUse/SubagentStart/Stop/
  // PreToolUse payloads to manipulate telemetry, agent records, Orbit
  // bookkeeping, or risk classification by running a Hook entrypoint script
  // directly via its own Bash or PowerShell tool instead of the host's own
  // Hook dispatch actually invoking it.
  const dataRoot = tempDataRoot();
  for (const filename of ['question-gate.mjs', 'risk-gate.mjs', 'posttool-telemetry.mjs', 'fingerprint.mjs', 'agent-events.mjs', 'stop-gate.mjs']) {
    for (const toolName of ['Bash', 'PowerShell']) {
      const result = classifyRiskAction({
        toolName,
        toolInput: { command: `node plugins/krylo/scripts/security/${filename}` },
        cwd: process.cwd(),
        dataRoot,
      });
      assert.equal(result.action, 'deny', `expected direct invocation of ${filename} via ${toolName} to be denied`);
      assert.equal(result.category, 'hook-entrypoint-protection');
    }
  }
});

test('shared risk policy still allows the legitimate runtime CLIs the model is meant to call directly', () => {
  const dataRoot = tempDataRoot();
  for (const command of [
    'node plugins/krylo/scripts/runtime/init-run.mjs --goal "x" --session s --lane PATCH --risk low',
    'node plugins/krylo/scripts/runtime/read-state.mjs --session s',
    'node plugins/krylo/scripts/runtime/update-state.mjs --session s --add-criterion "x"',
  ]) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.notEqual(result.category, 'hook-entrypoint-protection', `legitimate CLI call must not be denied as a hook-entrypoint invocation: ${command}`);
  }
});

test('shared risk policy denies an oversized Bash command outright, bounding classification latency (ReDoS-style DoS finding)', () => {
  // HIGH FINDING (independent security review, security-hardening
  // checkpoint): production-policy.json's multi-segment lazy-quantifier
  // patterns scale superlinearly against the full command text -- the
  // reviewer measured ~25 seconds at the 1MB stdin ceiling readStdinJson()
  // otherwise allows, close enough to a real PreToolUse Hook timeout to be
  // a genuine availability risk. A model could pad an actually-dangerous
  // command with ~1MB of adversarial filler as a shell comment and stall
  // the gate itself. Fixed: an oversized Bash command is denied outright,
  // before any pattern matching runs, rather than truncated (which could
  // hide a real dangerous command appearing after the cut point).
  const dataRoot = tempDataRoot();

  const oversized = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: `git push --force origin main  # ${'x'.repeat(20_000)}` },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(oversized.action, 'deny');
  assert.equal(oversized.category, 'oversized-command');

  // A normal-sized command is completely unaffected.
  const normal = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(normal.action, 'pass');

  // Classification of an adversarial-but-under-the-cap command stays fast
  // (bounds the fix, not just the denial path): the reviewer's own
  // benchmark showed ~4ms at 10,000 bytes against the real policy file.
  const nearCapCommand = `az deploymentx functionappy ${'az deploymentx functionappy '.repeat(300)}`.slice(0, 9_900);
  const start = process.hrtime.bigint();
  classifyRiskAction({ toolName: 'Bash', toolInput: { command: nearCapCommand }, cwd: process.cwd(), dataRoot });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert.ok(elapsedMs < 500, `classification of a near-cap adversarial command took ${elapsedMs}ms, expected well under 500ms`);
});

test('shared risk policy denies a Bash command naming the wrapper config in the data root', () => {
  const dataRoot = tempDataRoot();
  const command = `echo '{"originalCommand":["evil"]}' > ${dataRoot.replace(/\\/g, '/')}/wrapper-config.json`;
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy passes a benign file write', () => {
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: 'src/app.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
});

test('shared risk policy invariant: Write/Edit/NotebookEdit/Read/Glob/Grep and an unrecognized tool name can NEVER produce require-approval', () => {
  // risk-gate.mjs's native-ask eligibility (ADR-0027) relies on this
  // invariant to know Bash/PowerShell/MCP are the only tool surfaces that
  // ever need to reach the ask/deny branch at all -- independent review
  // found this invariant lived only in a code comment. Locking it here
  // means a future change that adds a require-approval path for one of
  // these tools surfaces as a failing test, not a silent gap in
  // risk-gate.mjs's NATIVE_ASK_ELIGIBLE_TOOLS set.
  const dataRoot = tempDataRoot();
  const cwd = process.cwd();
  const cases = [
    ['Write', { file_path: 'src/app.js' }],
    ['Write', { file_path: '.env' }], // even the sensitive-path deny case
    ['Edit', { file_path: 'src/app.js' }],
    ['NotebookEdit', { notebook_path: 'nb.ipynb' }],
    ['Read', { file_path: 'src/app.js' }],
    ['Read', { file_path: '.env' }],
    ['Glob', { pattern: '**/*.js' }],
    ['Grep', { pattern: 'TODO', glob: '**/*.js' }],
    ['SomeFutureToolKrylODoesNotYetClassify', { anything: 'x' }],
  ];
  for (const [toolName, toolInput] of cases) {
    const result = classifyRiskAction({ toolName, toolInput, cwd, dataRoot });
    assert.notEqual(result.action, 'require-approval', `${toolName} must never produce require-approval`);
  }
});

test('shared risk policy hard-denies an unknown MCP server (not merely require-approval)', () => {
  // Restore-native-approval checkpoint: `deny` and `require-approval` are
  // distinct KRYLO policy outcomes. An entirely unrecognized MCP server has
  // no identity a human could meaningfully approve, so it must stay a hard
  // `deny` even now that known MCP write classes route through native ask
  // -- otherwise widening `ask` to MCP tools would silently downgrade
  // "we have never reviewed this server at all" to a single-click prompt.
  const result = classifyRiskAction({
    toolName: 'mcp__some_random_service__update_thing',
    toolInput: {},
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
});

test('shared risk policy passes a known read-only-shaped MCP operation', () => {
  const result = classifyRiskAction({
    toolName: 'mcp__context7__query-docs',
    toolInput: { q: 'hello' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
  assert.equal(result.category, 'mcp-pass');
});

test('shared risk policy gates a known write-shaped MCP operation pending approval', () => {
  const result = classifyRiskAction({
    toolName: 'mcp__github__merge_pull_request',
    toolInput: { pr: 42 },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'merge');
});

test('shared risk policy falls back to the real data root when dataRoot is omitted', () => {
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = tempDataRoot();
  try {
    const result = classifyRiskAction({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      cwd: process.cwd(),
    });
    assert.equal(result.action, 'pass');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
  }
});

test('shared risk policy contains zero Claude-specific fields in its decisions', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'gh secret set DEPLOY_KEY' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal('hookSpecificOutput' in result, false);
  assert.equal('permissionDecision' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['action', 'actionClass', 'category', 'reason'].sort());
});

// --- PowerShell coverage (Windows): a risky action must not bypass KRYLO
// merely because Claude invokes the PowerShell tool instead of Bash. Official
// Claude Code Hook documentation confirms PowerShell is a distinct tool name
// from Bash, with the same tool_input.command shape (docs/adr/0022's version
// floor update; code.claude.com/docs/en/hooks). ---

test('shared risk policy classifies a git push via the PowerShell tool exactly like Bash', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'git push origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-push');
});

test('shared risk policy classifies a force push via the PowerShell tool as git-force', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'git push --force origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-force');
});

test('shared risk policy classifies a native PowerShell destructive delete (Remove-Item -Recurse -Force) as destructive-operation (require-approval)', () => {
  // A Bash-flavored `rm -rf` pattern alone would miss the syntax a genuine
  // PowerShell user or a PowerShell-invoking model actually writes.
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'Remove-Item -Recurse -Force C:\\Users\\dev\\important' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'destructive-operation');
});

test('shared risk policy catches PowerShell parameter abbreviations and built-in aliases for the same destructive delete', () => {
  // Independent security review found the prior pattern required the FULL
  // "remove-item"/"-recurse"/"-force" spelling, which PowerShell's own
  // parameter-prefix matching and built-in command aliases trivially evade
  // (verified empirically: -Rec/-Fo/-R/-F abbreviations and the ri/rd/rmdir/
  // del/erase aliases all previously classified as a silent 'pass'). `rm`
  // is deliberately EXCLUDED from this alias list: a follow-up review found
  // that including it turned ordinary Bash hygiene commands (`rm -rf
  // node_modules`, `rm -f package-lock.json`) into unconditional denies
  // with no in-run unlock (destructive-operation is not in the native-ask
  // allowlist). The pre-existing, separately-anchored Bash `rm` pattern
  // (root/home/drive-letter targets only) is unaffected and still covers
  // genuinely dangerous `rm` usage; see the benign-command test below for
  // the negative case this trade-off requires.
  const dataRoot = tempDataRoot();
  const commands = [
    'Remove-Item -Rec -Fo C:\\important',
    'Remove-Item -R -F C:\\important',
    'ri -Recurse -Force C:\\important',
    'rd /s /q C:\\important',
    'rmdir -Recurse -Force C:\\important',
    'del /f /s /q C:\\important',
    'erase -Force C:\\important',
  ];
  for (const command of commands) {
    const result = classifyRiskAction({ toolName: 'PowerShell', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, 'destructive-operation', `expected destructive-operation for: ${command}`);
  }
});

test('shared risk policy still passes ordinary Bash rm/git-rm/docker-rm hygiene commands (negative case for the PowerShell alias fix)', () => {
  // Regression found by independent review: an earlier attempt at the fix
  // above included bare "rm" in the PowerShell alias alternation, which
  // (since the alternation has no path/target anchor) turned routine Bash
  // commands with no PowerShell involvement at all into unconditional
  // destructive-operation denies -- with no native-ask unlock, a real
  // availability regression on ordinary build/dev hygiene.
  const dataRoot = tempDataRoot();
  const commands = [
    'rm -rf node_modules',
    'rm -rf dist',
    'rm -f package-lock.json',
    'docker rm -f my-container',
    'git rm -r --cached .',
    'xargs rm -f',
  ];
  for (const command of commands) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass (not blocked) for: ${command}`);
  }
});

test('shared risk policy denies a PowerShell command reading a protected secret path', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'Get-Content .env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
});

test('shared risk policy denies a PowerShell command directly invoking a KRYLO Hook entrypoint', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'node plugins/krylo/scripts/security/risk-gate.mjs' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'hook-entrypoint-protection');
});

test('shared risk policy denies a PowerShell command referencing the KRYLO data root', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: `Remove-Item -Recurse -Force ${dataRoot.replace(/\\/g, '/')}/runs` },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies an oversized PowerShell command outright, same as Bash', () => {
  const dataRoot = tempDataRoot();
  const oversized = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: `git push --force origin main  # ${'x'.repeat(20_000)}` },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(oversized.action, 'deny');
  assert.equal(oversized.category, 'oversized-command');
});

test('shared risk policy passes a benign PowerShell command', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
});

test('module source never reads a CLAUDE_-prefixed environment variable', () => {
  const source = fs.readFileSync(RISK_POLICY_PATH, 'utf8');
  assert.doesNotMatch(source, /process\.env\.CLAUDE_/);
  assert.doesNotMatch(source, /env\[.CLAUDE_/);
});
