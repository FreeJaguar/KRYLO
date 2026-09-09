// TDD category F (task Section 19.F): package/runtime -- engine/version consistency.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runNodeRuntimeChecks } from '../../scripts/maintenance/checks/node-runtime.mjs';

function makeFixtureRepo({ pkgEngines = '>=22.0.0', lockEngines = '>=22.0.0', testYmlVersions = ['22', '24'], singleVersion = '24' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-node-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.1', engines: pkgEngines ? { node: pkgEngines } : undefined }));
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', version: '0.1.1', packages: { '': { name: 'x', version: '0.1.1', engines: lockEngines ? { node: lockEngines } : undefined } } }),
  );
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), `matrix:\n  node: [${testYmlVersions.map((v) => `"${v}"`).join(', ')}]`);
  if (singleVersion) {
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'validate-plugin.yml'), `node-version: "${singleVersion}"`);
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'release.yml'), `node-version: "${singleVersion}"`);
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'claude-code-compat.yml'), `node-version: "${singleVersion}"`);
  }
  return dir;
}

test('engine/version consistency: package.json and package-lock.json engines agree', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-engines-floor-package-lock-consistency');
  assert.equal(check.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('engine/version drift: package.json and package-lock.json disagree -> changed', async () => {
  const repoRoot = makeFixtureRepo({ pkgEngines: '>=22.0.0', lockEngines: '>=20.0.0' });
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-engines-floor-package-lock-consistency');
  assert.equal(check.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('a workflow using a Node version below the declared engines floor is flagged high', async () => {
  const repoRoot = makeFixtureRepo({ pkgEngines: '>=22.0.0', singleVersion: '18' });
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-workflow-versions-meet-engines-floor');
  assert.equal(check.status, 'changed');
  assert.equal(check.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('non-matrix workflows using different single Node versions are flagged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-node-mismatch-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.1', engines: { node: '>=22.0.0' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '0.1.1', packages: { '': { engines: { node: '>=22.0.0' } } } }));
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), `matrix:\n  node: ["22", "24"]`);
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'validate-plugin.yml'), `node-version: "24"`);
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'release.yml'), `node-version: "22"`);
  const results = await runNodeRuntimeChecks({ repoRoot: dir });
  const check = results.find((r) => r.id === 'node-non-matrix-workflows-agree');
  assert.equal(check.status, 'changed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression (MEDIUM-6, Reviewer, CONFIRMED): the original code hardcoded
// four workflow filenames, so a NEW workflow file -- including this
// checkpoint's own ecosystem-maintenance.yml -- was never checked at all.
test('a Node version in a workflow file NOT on any hardcoded list is still detected (MEDIUM-6)', async () => {
  const repoRoot = makeFixtureRepo({ singleVersion: null });
  fs.writeFileSync(path.join(repoRoot, '.github', 'workflows', 'a-brand-new-workflow.yml'), `node-version: "18"`);
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-workflow-versions-meet-engines-floor');
  assert.equal(check.status, 'changed', 'a below-floor Node version in an unlisted workflow file must still be caught');
  assert.equal(check.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (MEDIUM-7, Reviewer, CONFIRMED): the original regex required
// end-of-line immediately after the version digits, missing the common
// actions/setup-node "NN.x" form and any trailing comment on the line --
// both silently read as "no version found," not the real value.
test('the common "NN.x" setup-node form is recognized, not silently missed (MEDIUM-7)', async () => {
  const repoRoot = makeFixtureRepo({ singleVersion: null });
  fs.writeFileSync(path.join(repoRoot, '.github', 'workflows', 'setup.yml'), `node-version: "18.x"`);
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-workflow-versions-meet-engines-floor');
  assert.equal(check.status, 'changed', 'the "18.x" form must be parsed as major version 18, below the >=22.0.0 floor');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('a trailing YAML comment on the node-version line does not prevent extraction (MEDIUM-7)', async () => {
  const repoRoot = makeFixtureRepo({ singleVersion: null });
  fs.writeFileSync(path.join(repoRoot, '.github', 'workflows', 'setup.yml'), `node-version: "18" # pinned deliberately for a compat test`);
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-workflow-versions-meet-engines-floor');
  assert.equal(check.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('zero Node versions extracted from non-empty workflow files is blocked, never a silent ok pass', async () => {
  const repoRoot = makeFixtureRepo({ singleVersion: null, testYmlVersions: [] });
  fs.writeFileSync(path.join(repoRoot, '.github', 'workflows', 'no-node-here.yml'), `name: sample\non:\n  push: {}\n`);
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-workflow-versions-meet-engines-floor');
  assert.equal(check.status, 'blocked');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('missing engines field is reported as blocked, never silently assumed', async () => {
  const repoRoot = makeFixtureRepo({ pkgEngines: null, lockEngines: null });
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-engines-floor-package-lock-consistency');
  assert.equal(check.status, 'blocked');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
