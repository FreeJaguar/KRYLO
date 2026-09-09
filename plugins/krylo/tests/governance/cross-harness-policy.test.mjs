// Verifies the Cross-Harness data-egress approval wiring (docs/adr/0030-cross-harness-advisory-workers.md
// Section "Reused, not reinvented"): invoking scripts/runtime/cross-harness-run.mjs
// via Bash/PowerShell is itself the require-approval-classified action,
// using the SAME production-policy.json + risk-policy.mjs + state.mjs
// actionClass machinery every other approval class already uses -- no new
// approval mechanism, no code changes to risk-gate.mjs's ask-eligibility
// logic (ADR-0027 already made every require-approval class ask-eligible).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRiskAction } from '../../scripts/security/risk-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function tempDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-ch-gov-'));
}

test('production-policy.json registers a cross-harness-invocation approval class matching real invocation commands', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policies', 'production-policy.json'), 'utf8'));
  assert.ok('cross-harness-invocation' in policy.approvalClasses, 'production-policy.json must declare the cross-harness-invocation class');
  const cls = policy.approvalClasses['cross-harness-invocation'];
  assert.ok(typeof cls.reason === 'string' && cls.reason.length > 0);
  assert.ok(Array.isArray(cls.patterns) && cls.patterns.length > 0);
});

test('cross-harness-invocation is a valid actionClass in both state.mjs and run-state.schema.json, kept in sync', () => {
  const stateSource = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'state.mjs'), 'utf8');
  assert.match(stateSource, /'cross-harness-invocation'/, 'scripts/lib/state.mjs ENUMS.actionClass must include cross-harness-invocation');

  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'schemas', 'run-state.schema.json'), 'utf8'));
  const actionClassEnum = schema.properties.riskApprovals.items.properties.actionClass.enum;
  assert.ok(actionClassEnum.includes('cross-harness-invocation'), 'run-state.schema.json riskApprovals actionClass enum must include cross-harness-invocation');
});

test('invoking cross-harness-run.mjs via Bash is classified require-approval, cross-harness-invocation -- the real gate any $krylo-run invocation goes through', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'node "/plugin/scripts/runtime/cross-harness-run.mjs" --role reviewer --task "review this diff"' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'cross-harness-invocation');
});

test('invoking cross-harness-run.mjs via PowerShell is classified identically (parity, matching every other approval class)', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'node "C:\\plugin\\scripts\\runtime\\cross-harness-run.mjs" --role verifier --task x' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'cross-harness-invocation');
});

test('an ordinary runtime CLI invocation (read-state.mjs) is NOT classified as cross-harness-invocation -- the pattern is specific, not a broad match on scripts/runtime/', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'node "/plugin/scripts/runtime/read-state.mjs"' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.notEqual(result.actionClass, 'cross-harness-invocation');
});

test('scripts/host/cross-harness/ contains exactly the two provider adapters, no shared "core" duplication (ADR-0030: one shared implementation, thin adapters only)', () => {
  const dir = path.join(PLUGIN_ROOT, 'scripts', 'host', 'cross-harness');
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['claude-worker.mjs', 'codex-worker.mjs']);
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    // A comment REFERENCING these Shared Core functions (e.g. "-- see
    // scripts/lib/cross-harness.mjs's validateCrossHarnessResult") is fine
    // and expected; only a local DEFINITION would be real duplication.
    assert.doesNotMatch(source, /\bfunction\s+(classifyRiskAction|buildCrossHarnessRequest|validateCrossHarnessResult)\s*\(/, `${file} must not duplicate Shared Core policy logic`);
  }
});
