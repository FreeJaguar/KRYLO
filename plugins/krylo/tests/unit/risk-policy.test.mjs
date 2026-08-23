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

test('shared risk policy denies an unknown MCP server', () => {
  const result = classifyRiskAction({
    toolName: 'mcp__some_random_service__update_thing',
    toolInput: {},
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(typeof result.actionClass, 'string');
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

test('module source never reads a CLAUDE_-prefixed environment variable', () => {
  const source = fs.readFileSync(RISK_POLICY_PATH, 'utf8');
  assert.doesNotMatch(source, /process\.env\.CLAUDE_/);
  assert.doesNotMatch(source, /env\[.CLAUDE_/);
});
