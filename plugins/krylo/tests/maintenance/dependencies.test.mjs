// TDD category F (task Section 19.F, continued): package/runtime -- expected
// dependency inventory, unexpected lifecycle scripts, audit result parsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDependenciesChecks } from '../../scripts/maintenance/checks/dependencies.mjs';

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

test('does not run arbitrary package scripts merely to inspect them: no scripts other than the requested command are executed', async () => {
  const repoRoot = makeFixtureRepo({ scripts: { test: 'should never run: node -e "throw new Error(\'ran a script during a maintenance check\')"' } });
  // Merely constructing/running the check must never invoke `npm run test`
  // or any other repository script -- only `npm audit --json` itself
  // (task Section 5.E's explicit "do not automatically run arbitrary
  // package scripts merely to inspect them").
  await assert.doesNotReject(() => runDependenciesChecks({ repoRoot, offline: true }));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
