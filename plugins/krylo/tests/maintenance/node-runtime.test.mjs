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

test('missing engines field is reported as blocked, never silently assumed', async () => {
  const repoRoot = makeFixtureRepo({ pkgEngines: null, lockEngines: null });
  const results = await runNodeRuntimeChecks({ repoRoot });
  const check = results.find((r) => r.id === 'node-engines-floor-package-lock-consistency');
  assert.equal(check.status, 'blocked');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
