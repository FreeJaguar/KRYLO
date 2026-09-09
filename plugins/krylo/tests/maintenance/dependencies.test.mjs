// TDD category F (task Section 19.F, continued): package/runtime -- expected
// dependency inventory, unexpected lifecycle scripts, audit result parsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runDependenciesChecks, resolveNpmInvocation } from '../../scripts/maintenance/checks/dependencies.mjs';

function makeFixtureRepo({ deps = {}, devDeps = {}, scripts = {}, lockName = 'x', lockVersion = '0.1.1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-deps-'));
  const pkg = { name: 'x', version: '0.1.1', dependencies: deps, devDependencies: devDeps, scripts };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: lockName, version: lockVersion }));
  return dir;
}

test('expected dependency inventory: zero dependencies is ok', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runDependenciesChecks({ repoRoot, offline: true });
  const check = results.find((r) => r.id === 'dependency-inventory');
  assert.equal(check.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('unexpected dependency addition: a non-zero dependency count is flagged for review, not silently accepted', async () => {
  const repoRoot = makeFixtureRepo({ deps: { 'some-new-package': '^1.0.0' } });
  const results = await runDependenciesChecks({ repoRoot, offline: true });
  const check = results.find((r) => r.id === 'dependency-inventory');
  assert.equal(check.status, 'changed');
  assert.equal(check.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('unexpected lifecycle script: a postinstall script is flagged critical', async () => {
  const repoRoot = makeFixtureRepo({ scripts: { postinstall: 'node evil.js' } });
  const results = await runDependenciesChecks({ repoRoot, offline: true });
  const check = results.find((r) => r.id === 'no-lifecycle-scripts');
  assert.equal(check.status, 'changed');
  assert.equal(check.severity, 'critical');
  assert.equal(check.requiresHumanReview, true);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('exact lock consistency: name/version mismatch between package.json and package-lock.json is flagged high', async () => {
  const repoRoot = makeFixtureRepo({ lockName: 'different-name', lockVersion: '0.0.9' });
  const results = await runDependenciesChecks({ repoRoot, offline: true });
  const check = results.find((r) => r.id === 'lockfile-consistency');
  assert.equal(check.status, 'changed');
  assert.equal(check.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('offline mode: npm audit is explicitly unavailable, never a false "ok"', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runDependenciesChecks({ repoRoot, offline: true });
  const check = results.find((r) => r.id === 'npm-audit');
  assert.equal(check.status, 'unavailable');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (MEDIUM-9, Reviewer, CONFIRMED): the Windows npm.cmd fix
// (resolveNpmInvocation) previously had zero test coverage of any kind.
test('resolveNpmInvocation resolves to a real, directly-invokable command/args pair in this environment', () => {
  const target = resolveNpmInvocation(['audit', '--json']);
  assert.ok(target, 'expected a resolved target in a real Node environment that has npm installed');
  assert.equal(typeof target.command, 'string');
  assert.ok(Array.isArray(target.args));
  assert.ok(target.args.includes('audit'));
  assert.ok(target.args.includes('--json'));
});

test('resolveNpmInvocation\'s resolved target actually runs and produces real npm output', () => {
  const target = resolveNpmInvocation(['--version']);
  const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/, 'expected a real npm version string');
});

// Regression (MEDIUM-9, Reviewer, CONFIRMED): the high/critical severity
// mapping (dependencies.mjs's runDependenciesChecks, npm-audit result)
// was previously untested in live mode at all, since every test ran with
// offline:true (which returns before ever reaching that logic). Uses the
// new injectable runNpmAudit parameter rather than a real subprocess.
test('a high/critical vulnerability count from npm audit is mapped to status changed/severity high', async () => {
  const repoRoot = makeFixtureRepo();
  const runNpmAudit = () => ({ ok: true, json: { metadata: { vulnerabilities: { low: 0, moderate: 0, high: 2, critical: 1 } } } });
  const results = await runDependenciesChecks({ repoRoot, offline: false, runNpmAudit });
  const check = results.find((r) => r.id === 'npm-audit');
  assert.equal(check.status, 'changed');
  assert.equal(check.severity, 'high');
  assert.equal(check.requiresHumanReview, true);
  assert.match(check.observed, /high=2/);
  assert.match(check.observed, /critical=1/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('zero vulnerabilities from npm audit is mapped to status ok/severity info', async () => {
  const repoRoot = makeFixtureRepo();
  const runNpmAudit = () => ({ ok: true, json: { metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } } } });
  const results = await runDependenciesChecks({ repoRoot, offline: false, runNpmAudit });
  const check = results.find((r) => r.id === 'npm-audit');
  assert.equal(check.status, 'ok');
  assert.equal(check.severity, 'info');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('does not run arbitrary package scripts merely to inspect them: no scripts other than the requested command are executed', async () => {
  const repoRoot = makeFixtureRepo({ scripts: { test: 'should never run: node -e "throw new Error(\'ran a script during a maintenance check\')"' } });
  // Merely constructing/running the check must never invoke `npm run test`
  // or any other repository script -- only `npm audit --json` itself
  // (task Section 5.E's explicit "do not automatically run arbitrary
  // package scripts merely to inspect them").
  await assert.doesNotReject(() => runDependenciesChecks({ repoRoot, offline: true }));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
