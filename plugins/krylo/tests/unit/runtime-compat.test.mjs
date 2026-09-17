import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCompatibilityContract,
  probeCodexVersion,
  evaluateCodexRuntimeCompatibility,
} from '../../scripts/host/codex/runtime-compat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'codex-runtime-compat');
const FAKE_CLI = path.join(FIXTURES, os.platform() === 'win32' ? 'fake-codex-cli.cmd' : 'fake-codex-cli.sh');

function tempContractPath(prefix = 'krylo-compat-contract-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'contract.json');
}

function writeContract(obj) {
  const p = tempContractPath();
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return p;
}

const VALID_CONTRACT = {
  contractSchemaVersion: 1,
  reviewedAt: '2026-09-02',
  supported: [{ version: '0.120.0', evidence: 'test fixture', confirmedHookEvents: ['PreToolUse'] }],
  blocked: [{ version: '0.99.0', reason: 'known incompatible for testing' }],
};

// --- loadCompatibilityContract ---

test('loadCompatibilityContract: a well-formed contract loads successfully', () => {
  const p = writeContract(VALID_CONTRACT);
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, true);
  assert.equal(result.contract.supported.length, 1);
});

test('loadCompatibilityContract: a missing file fails safe (contract-unreadable)', () => {
  const result = loadCompatibilityContract({ contractPath: path.join(os.tmpdir(), 'krylo-does-not-exist-contract.json') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-unreadable');
});

test('loadCompatibilityContract: malformed JSON fails safe (contract-invalid-json)', () => {
  const p = writeContract('{ not valid json');
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-invalid-json');
});

test('loadCompatibilityContract: an unrecognized contractSchemaVersion fails safe, never silently accepted', () => {
  const p = writeContract({ ...VALID_CONTRACT, contractSchemaVersion: 2 });
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-unknown-schema-version');
});

test('loadCompatibilityContract: a missing contractSchemaVersion field fails safe', () => {
  const { contractSchemaVersion, ...rest } = VALID_CONTRACT;
  const p = writeContract(rest);
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-unknown-schema-version');
});

test('loadCompatibilityContract: supported/blocked not arrays fails safe (contract-invalid-shape)', () => {
  const p = writeContract({ ...VALID_CONTRACT, supported: 'not-an-array' });
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-invalid-shape');
});

test('loadCompatibilityContract: an entry missing a version field fails safe (contract-invalid-entry)', () => {
  const p = writeContract({ ...VALID_CONTRACT, supported: [{ evidence: 'no version field' }] });
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'contract-invalid-entry');
});

test('loadCompatibilityContract: a JSON array at the top level (not an object) fails safe', () => {
  const p = writeContract([1, 2, 3]);
  const result = loadCompatibilityContract({ contractPath: p });
  assert.equal(result.ok, false);
});

test('loadCompatibilityContract: the real, shipped contract file is itself well-formed', () => {
  const realPath = path.resolve(__dirname, '..', '..', 'policies', 'codex-runtime-compatibility.json');
  const result = loadCompatibilityContract({ contractPath: realPath });
  assert.equal(result.ok, true, `real contract must be well-formed: ${result.reason}`);
  assert.ok(result.contract.supported.length >= 1, 'the real contract must list at least one supported version');
});

// --- probeCodexVersion ---

test('probeCodexVersion: a well-formed "codex-cli X.Y.Z" response parses successfully', () => {
  const result = probeCodexVersion({ cliPath: FAKE_CLI, env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' } });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.120.0');
  assert.ok(typeof result.executablePath === 'string' && result.executablePath !== '');
  // Regression (found by a fresh independent Reviewer): on the Windows-shim
  // resolution path, the bare resolved `command` alone is just the
  // interpreter (node.exe), not a meaningful identity -- the real fixture
  // script path must be included too, so this is genuinely useful audit
  // evidence rather than the wrong binary's own path.
  assert.match(result.executablePath, /fake-codex-cli/, 'executablePath must name the real resolved script/binary, not merely an interpreter (e.g. bare node.exe on the Windows-shim path)');
});

test('probeCodexVersion: a missing/unresolvable executable fails safe, never guesses a version', () => {
  const result = probeCodexVersion({ cliPath: 'krylo-this-command-does-not-exist-anywhere-xyz', env: process.env });
  assert.equal(result.ok, false);
});

test('probeCodexVersion: a non-zero exit code fails safe', () => {
  const result = probeCodexVersion({ cliPath: FAKE_CLI, env: { ...process.env, FAKE_CODEX_EXIT_CODE: '1' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-nonzero-exit');
});

test('probeCodexVersion: malformed version output fails safe (probe-malformed-version), never guessed', () => {
  const result = probeCodexVersion({ cliPath: FAKE_CLI, env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'not a version string at all' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-malformed-version');
});

test('probeCodexVersion: a probe exceeding the timeout budget fails safe (probe-timeout), not a false success', () => {
  const result = probeCodexVersion({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_DELAY_MS: '2000' },
    timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-timeout');
});

test('probeCodexVersion: never throws even on a completely unusable cliPath', () => {
  assert.doesNotThrow(() => probeCodexVersion({ cliPath: '', env: process.env }));
  assert.doesNotThrow(() => probeCodexVersion({ cliPath: null, env: process.env }));
});

// --- evaluateCodexRuntimeCompatibility (the full decision table) ---

test('evaluateCodexRuntimeCompatibility: an exact-match supported version is trusted', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' },
    contractPath,
  });
  assert.equal(result.trusted, true);
  assert.equal(result.status, 'supported');
  assert.equal(result.version, '0.120.0');
});

test('evaluateCodexRuntimeCompatibility: an exact-match blocked version is never trusted, with the contract\'s own reason surfaced', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.99.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /known incompatible for testing/);
});

// Regression coverage (found by a fresh independent Reviewer: "blocked-wins"
// is the decision table's own key safety property and was asserted nowhere)
// -- a version listed in BOTH supported and blocked must still be denied.
// A well-reviewed contract should never actually do this, but the ordering
// itself (blocked checked strictly before supported) must hold regardless.
test('evaluateCodexRuntimeCompatibility: a version listed in BOTH supported and blocked is still denied -- blocked always wins', () => {
  const contractPath = writeContract({
    contractSchemaVersion: 1,
    supported: [{ version: '0.120.0', evidence: 'test fixture' }],
    blocked: [{ version: '0.120.0', reason: 'this exact version was later found to be broken' }],
  });
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /this exact version was later found to be broken/);
});

test('evaluateCodexRuntimeCompatibility: an unknown NEWER version is unverified, never automatically trusted for being newer', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 99.0.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'unverified');
});

test('evaluateCodexRuntimeCompatibility: an unknown OLDER version is unverified unless explicitly supported', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.1.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'unverified');
});

test('evaluateCodexRuntimeCompatibility: does not trust a "compatible-looking" nearby version -- only exact match, no ranges', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.1' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'unverified');
});

test('evaluateCodexRuntimeCompatibility: a missing Codex executable fails safe (probe-failed), never treated as compatible', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: 'krylo-this-command-does-not-exist-anywhere-xyz',
    env: process.env,
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'probe-failed');
});

test('evaluateCodexRuntimeCompatibility: malformed version output fails safe (probe-failed)', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'garbage' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'probe-failed');
});

test('evaluateCodexRuntimeCompatibility: a probe timeout fails safe (probe-failed), never a false pass', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_DELAY_MS: '2000' },
    contractPath,
    timeoutMs: 200,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'probe-failed');
});

test('evaluateCodexRuntimeCompatibility: a malformed compatibility registry fails safe (contract-malformed), even for an otherwise-supported installed version', () => {
  const contractPath = writeContract('{ not valid json');
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'contract-malformed');
});

test('evaluateCodexRuntimeCompatibility: an unsupported/unrecognized registry schema version fails safe (contract-malformed)', () => {
  const contractPath = writeContract({ ...VALID_CONTRACT, contractSchemaVersion: 999 });
  const result = evaluateCodexRuntimeCompatibility({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' },
    contractPath,
  });
  assert.equal(result.trusted, false);
  assert.equal(result.status, 'contract-malformed');
});

test('evaluateCodexRuntimeCompatibility: every trusted:false result carries a non-empty, precise reason string', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  const scenarios = [
    { FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 99.0.0' }, // unverified
    { FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.99.0' }, // blocked
    { FAKE_CODEX_VERSION_OUTPUT: 'garbage' }, // probe-failed
  ];
  for (const envOverrides of scenarios) {
    const result = evaluateCodexRuntimeCompatibility({ cliPath: FAKE_CLI, env: { ...process.env, ...envOverrides }, contractPath });
    assert.equal(result.trusted, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 10, `expected a precise reason for ${JSON.stringify(envOverrides)}`);
  }
});

// Regression (found by a fresh independent Reviewer): the second assertion
// here originally passed `contractPath: undefined`, which falls back to the
// REAL shipped contract, combined with `cliPath: undefined`, which falls
// back to the real bare `codex` command -- genuinely spawning whatever
// Codex binary happens to be installed on the machine running this test,
// contradicting this suite's own hermetic-test requirement (design doc:
// "this repository's test suite must remain fully hermetic"). Both cases
// below now use an explicit fixture contractPath and a definitely-absent
// cliPath, so this test proves "never throws on malformed input" without
// depending on, or actually invoking, any real installed Codex binary.
test('evaluateCodexRuntimeCompatibility: never throws for any combination of malformed inputs', () => {
  const contractPath = writeContract(VALID_CONTRACT);
  assert.doesNotThrow(() => evaluateCodexRuntimeCompatibility({ cliPath: '', env: {}, contractPath: '' }));
  assert.doesNotThrow(() => evaluateCodexRuntimeCompatibility({
    cliPath: 'krylo-this-command-definitely-does-not-exist-anywhere-xyz',
    env: {},
    contractPath,
  }));
});

// REGRESSION (CI, Windows). The gate told a human the Codex binary was not
// installed on a machine where it demonstrably was: the PATH lookup the
// resolution step runs is itself a subprocess, that subprocess exceeded its
// own timeout under runner load, and "we could not ask" was returned as the
// same value as "we asked and it is absent". Both still refuse the run, so
// nothing failed open -- but one of the two reasons is a false factual claim
// about the user's machine, which is exactly what this repository forbids.
test('probeCodexVersion: an abandoned PATH lookup is reported as transient, never as a missing executable', { skip: os.platform() !== 'win32' }, () => {
  // 1ms cannot outlast process creation, so the lookup is always abandoned.
  const stalled = probeCodexVersion({ cliPath: FAKE_CLI, resolutionTimeoutMs: 1 });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.reason, 'probe-timeout', 'a lookup that never answered must not be reported as an absent binary');

  // The genuinely-absent case must keep its own distinct reason, or the fix
  // above would have traded one false claim for the opposite one.
  const absent = probeCodexVersion({ cliPath: 'krylo-no-such-codex-cli-xyz' });
  assert.equal(absent.ok, false);
  assert.equal(absent.reason, 'probe-executable-unresolved');

  // And the same fixture resolves normally when the lookup is left alone,
  // proving the two cases above differ only in the lookup's fate.
  const healthy = probeCodexVersion({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CODEX_VERSION_OUTPUT: 'codex-cli 0.120.0' },
  });
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
});
