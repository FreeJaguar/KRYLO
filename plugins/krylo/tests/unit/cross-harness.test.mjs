import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  CROSS_HARNESS_ROLES,
  isCrossHarnessDepthExceeded,
  oppositeProvider,
  buildCrossHarnessRequest,
  summarizeEgress,
  buildContextPacket,
  validateCrossHarnessResult,
} from '../../scripts/lib/cross-harness.mjs';

const VALID_RUN_ID = 'run-abc123def456';
const VALID_HASH = 'a'.repeat(64);

function validArgs(overrides = {}) {
  return {
    nativeHost: 'claude',
    nativeSessionId: 'session-1',
    runId: VALID_RUN_ID,
    projectRootHash: VALID_HASH,
    role: 'reviewer',
    task: 'review the diff for correctness',
    env: {},
    ...overrides,
  };
}

// C. Depth
test('depth 0 (no marker) -> a well-formed request is allowed by policy', () => {
  const result = buildCrossHarnessRequest(validArgs());
  assert.equal(result.ok, true);
  assert.equal(result.request.depth, 1, 'the WORKER the request will spawn is always depth 1');
  assert.equal(result.request.workerProvider, 'codex');
});

test('depth 1 (KRYLO_DELEGATION_DEPTH=1) -> nested worker denied deterministically', () => {
  const result = buildCrossHarnessRequest(validArgs({ env: { KRYLO_DELEGATION_DEPTH: '1' } }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'DEPTH_LIMIT');
});

test('depth 1 (KRYLO_EXTERNAL_WORKER=1 alone, without KRYLO_DELEGATION_DEPTH) -> still denied', () => {
  const result = buildCrossHarnessRequest(validArgs({ env: { KRYLO_EXTERNAL_WORKER: '1' } }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'DEPTH_LIMIT');
});

test('missing/invalid depth signal (garbage env) -> fails safe by simply not matching the exceeded condition, never throws', () => {
  assert.doesNotThrow(() => isCrossHarnessDepthExceeded({ KRYLO_DELEGATION_DEPTH: 'not-a-real-value' }));
  assert.equal(isCrossHarnessDepthExceeded({ KRYLO_DELEGATION_DEPTH: 'not-a-real-value' }), false);
  assert.equal(isCrossHarnessDepthExceeded({}), false);
  assert.equal(isCrossHarnessDepthExceeded(undefined), false);
});

// B. Provider routing
test('Claude native -> Codex worker', () => {
  assert.equal(oppositeProvider('claude'), 'codex');
});

test('Codex native -> Claude worker', () => {
  assert.equal(oppositeProvider('codex'), 'claude');
});

test('an unrecognized native host has no opposite provider', () => {
  assert.equal(oppositeProvider('unknown-host'), null);
});

test('Claude -> Claude is rejected (not Cross-Harness)', () => {
  // buildCrossHarnessRequest always computes workerProvider as the OPPOSITE
  // of nativeHost -- there is no code path where nativeHost and
  // workerProvider can ever be equal, so a same-provider request is
  // structurally impossible to construct, not merely discouraged.
  const result = buildCrossHarnessRequest(validArgs({ nativeHost: 'claude' }));
  assert.equal(result.ok, true);
  assert.notEqual(result.request.workerProvider, 'claude');
});

// D. Roles
test('reviewer, verifier, security-reviewer, architect are all allowed', () => {
  for (const role of CROSS_HARNESS_ROLES) {
    const result = buildCrossHarnessRequest(validArgs({ role }));
    assert.equal(result.ok, true, `role ${role} should be allowed`);
    assert.equal(result.request.role, role);
  }
});

test('writer/builder/deployer/releaser/unknown roles are all denied', () => {
  for (const role of ['writer', 'builder', 'implementer', 'deployer', 'releaser', 'admin', '']) {
    const result = buildCrossHarnessRequest(validArgs({ role }));
    assert.equal(result.ok, false, `role ${role} should be denied`);
    assert.equal(result.failureCode, 'INVALID_ROLE');
  }
});

// F. Context packet
test('context packet excludes never-transfer paths (.env, .ssh, secrets.json) and reports the exclusion', () => {
  const result = buildContextPacket({
    task: 'review',
    fileExcerpts: [
      { path: '.env', content: 'SECRET=1' },
      { path: 'src/.ssh/id_rsa', content: 'nope' },
      { path: 'config/secrets.json', content: '{}' },
      { path: 'src/index.js', content: 'console.log(1)' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.packet.fileExcerpts.length, 1);
  assert.equal(result.packet.fileExcerpts[0].path, 'src/index.js');
  assert.ok(result.excludedPaths.includes('.env'));
  assert.ok(result.excludedPaths.some((p) => p.includes('id_rsa')));
  assert.ok(result.excludedPaths.some((p) => p.includes('secrets.json')));
});

// Regression: a fresh independent Reviewer found the never-transfer list
// missed .config/gh/hosts.yml (the GitHub CLI OAuth token store), which
// production-policy.json's own sensitivePaths already protects elsewhere
// in KRYLO -- a real, if narrow, parity gap between the two independent
// lists. Fixed by adding the pattern directly; this test both proves the
// fix and cross-checks parity against production-policy.json's own
// globProtectedPaths so the two lists cannot silently diverge again
// without at least this specific entry failing loudly.
test('context packet excludes .config/gh/hosts.yml (GitHub CLI OAuth token store), matching production-policy.json protection', () => {
  const result = buildContextPacket({
    task: 'review',
    fileExcerpts: [{ path: '.config/gh/hosts.yml', content: 'oauth_token: ghp_xxx' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.packet.fileExcerpts.length, 0);
  assert.ok(result.excludedPaths.includes('.config/gh/hosts.yml'));
});

test('every literal protected path production-policy.json declares (globProtectedPaths) is also excluded by the Cross-Harness never-transfer list', () => {
  const productionPolicy = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'policies', 'production-policy.json'), 'utf8'),
  );
  const protectedPaths = productionPolicy.sensitivePaths.globProtectedPaths.filter((p) => !p.endsWith('/*'));
  for (const protectedPath of protectedPaths) {
    const result = buildContextPacket({ task: 'review', fileExcerpts: [{ path: protectedPath, content: 'x' }] });
    assert.equal(result.packet.fileExcerpts.length, 0, `${protectedPath} (protected by production-policy.json) must also be excluded from the Cross-Harness context packet`);
  }
});

test('context packet excludes an absolute path and a traversal path as unsafe-to-classify', () => {
  const result = buildContextPacket({
    task: 'review',
    fileExcerpts: [
      { path: 'C:\\Users\\eliyahus\\secret.txt', content: 'x' },
      { path: '../../etc/passwd', content: 'x' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.packet.fileExcerpts.length, 0);
  assert.equal(result.excludedPaths.length, 2);
});

test('context packet redacts secret-shaped content inside an otherwise-allowed file excerpt', () => {
  const result = buildContextPacket({
    task: 'review',
    fileExcerpts: [{ path: 'src/config.js', content: 'const key = "sk-ant-api03-1234567890abcdef1234567890";' }],
  });
  assert.equal(result.ok, true);
  assert.ok(!result.packet.fileExcerpts[0].content.includes('sk-ant-api03'));
});

test('an oversized context packet is rejected as EGRESS_CONTENT_BLOCKED, never silently truncated', () => {
  // Varied, non-repetitive words (not a single repeated character) so
  // nothing collapses it under redaction -- this must still be oversized
  // AFTER redaction, which is what buildContextPacket actually measures.
  const words = ['function', 'const', 'return', 'if', 'else', 'import', 'export', 'class', 'async', 'await'];
  const huge = Array.from({ length: 40_000 }, (_, i) => words[i % words.length]).join(' ');
  const result = buildContextPacket({ task: 'review', boundedDiff: huge });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'EGRESS_CONTENT_BLOCKED');
});

test('context packet never includes a conversation-transcript-shaped field (no such field exists in the builder signature at all)', () => {
  const result = buildContextPacket({ task: 'review', acceptanceCriteria: ['AC-1'] });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.packet).sort(), ['acceptanceCriteria', 'boundedDiff', 'constraints', 'fileExcerpts', 'knownFindings', 'task', 'testResults'].sort());
});

// E. Egress summary hygiene
test('summarizeEgress contains only bounded metadata, never raw context content', () => {
  const req = buildCrossHarnessRequest(validArgs()).request;
  const summary = summarizeEgress({ request: req, contextManifest: { categories: ['diff', 'tests'], paths: ['src/a.js', 'src/b.js'] }, approxContextBytes: 1234 });
  assert.deepEqual(summary, {
    runId: VALID_RUN_ID,
    targetProvider: 'codex',
    role: 'reviewer',
    contextCategories: ['diff', 'tests'],
    selectedPaths: ['src/a.js', 'src/b.js'],
    approxContextBytes: 1234,
  });
});

// J. Output parsing
function validResult(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    status: 'completed',
    provider: 'codex',
    role: 'reviewer',
    summary: 'looks fine',
    filesModified: [],
    findings: [],
    limitations: [],
    ...overrides,
  };
}

test('a valid worker result passes validation', () => {
  const result = validateCrossHarnessResult(validResult());
  assert.equal(result.ok, true);
});

test('invalid JSON shape (not an object) is rejected', () => {
  assert.equal(validateCrossHarnessResult(null).ok, false);
  assert.equal(validateCrossHarnessResult('a string').ok, false);
  assert.equal(validateCrossHarnessResult([1, 2]).ok, false);
});

test('extra/unexpected top-level content does not crash validation and still requires the real fields', () => {
  const result = validateCrossHarnessResult({ ...validResult(), extraField: 'whatever' });
  assert.equal(result.ok, true);
  assert.ok(!('extraField' in result.result), 'unexpected fields must not be carried into the trusted, normalized result');
});

test('oversized output (summary over the cap) is rejected', () => {
  const result = validateCrossHarnessResult(validResult({ summary: 'x'.repeat(5000) }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'INVALID_OUTPUT');
});

test('an invalid finding severity is rejected', () => {
  const result = validateCrossHarnessResult(validResult({
    findings: [{ severity: 'catastrophic', title: 'x', confidence: 'high', recommendation: 'y', evidence: [] }],
  }));
  assert.equal(result.ok, false);
});

test('an absolute-path finding evidence entry is rejected', () => {
  const result = validateCrossHarnessResult(validResult({
    findings: [{ severity: 'low', title: 'x', confidence: 'high', recommendation: 'y', evidence: [{ path: '/etc/passwd', description: 'z' }] }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'INVALID_OUTPUT');
});

test('a path-traversal finding evidence entry is rejected', () => {
  const result = validateCrossHarnessResult(validResult({
    findings: [{ severity: 'low', title: 'x', confidence: 'high', recommendation: 'y', evidence: [{ path: '../../secrets.json', description: 'z' }] }],
  }));
  assert.equal(result.ok, false);
});

test('a malformed line number is rejected', () => {
  const result = validateCrossHarnessResult(validResult({
    findings: [{ severity: 'low', title: 'x', confidence: 'high', recommendation: 'y', evidence: [{ path: 'src/a.js', line: -1, description: 'z' }] }],
  }));
  assert.equal(result.ok, false);
});

test('a command-like recommendation stays plain text -- validation never interprets or executes it', () => {
  const result = validateCrossHarnessResult(validResult({
    findings: [{ severity: 'low', title: 'x', confidence: 'high', recommendation: 'rm -rf /; git push --force', evidence: [] }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.result.findings[0].recommendation, 'rm -rf /; git push --force');
});

test('non-empty filesModified is rejected outright as a policy violation, even with an otherwise perfect result', () => {
  const result = validateCrossHarnessResult(validResult({ filesModified: ['src/a.js'] }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'INVALID_OUTPUT');
  assert.match(result.error, /filesModified/);
});

test('more than the maximum number of findings is rejected', () => {
  const findings = Array.from({ length: 40 }, () => ({ severity: 'info', title: 'x', confidence: 'low', recommendation: 'y', evidence: [] }));
  const result = validateCrossHarnessResult(validResult({ findings }));
  assert.equal(result.ok, false);
});

test('an unrecognized role in the worker output is rejected', () => {
  const result = validateCrossHarnessResult(validResult({ role: 'builder' }));
  assert.equal(result.ok, false);
});

test('an unrecognized provider in the worker output is rejected', () => {
  const result = validateCrossHarnessResult(validResult({ provider: 'gemini' }));
  assert.equal(result.ok, false);
});
