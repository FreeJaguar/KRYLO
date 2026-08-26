// TDD category G (task Section 19.G): repository consistency -- product
// version agreement, compatibility floor agreement, and (critically) that
// future 0.2 planning docs do not create a false-positive version-drift
// finding.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInternalDriftChecks } from '../../scripts/maintenance/checks/internal-drift.mjs';

function makeFixtureRepo({ pkgVersion = '0.1.1', claudePluginVersion = '0.1.1', codexPluginVersion = '0.1.1', marketplaceVersion = '0.1.1', changelog = '## [Unreleased]\n\nsome notes\n\n## [0.1.1] - 2026-07-20\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-maint-drift-'));
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'krylo', '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'krylo-marketplace', version: pkgVersion, engines: { node: '>=22.0.0' } }));
  fs.writeFileSync(path.join(dir, 'plugins', 'krylo', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'krylo', version: claudePluginVersion }));
  fs.writeFileSync(path.join(dir, 'plugins', 'krylo', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'krylo', version: codexPluginVersion }));
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'krylo', version: marketplaceVersion }] }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

test('product version agreement: all five sources agree -> ok', async () => {
  const repoRoot = makeFixtureRepo();
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'ok');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('compatibility floor / product version agreement: a mismatched plugin.json version is flagged high', async () => {
  const repoRoot = makeFixtureRepo({ codexPluginVersion: '0.1.0' });
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'changed');
  assert.equal(check.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('future 0.2 planning docs do NOT create a false-positive product-version drift finding', async () => {
  // A CHANGELOG whose [Unreleased] section freely mentions "0.2" work (as
  // this repository's own does) must never be compared against as if it
  // were a released version -- only the first REAL "## [X.Y.Z]" heading
  // (never literally "Unreleased") counts.
  const changelog = [
    '## [Unreleased]',
    '',
    '- Added: Ecosystem Maintenance drift checker, targeting a future 0.2 line.',
    '- Planned: further 0.2 work.',
    '',
    '## [0.1.1] - 2026-07-20',
    '',
    '- Initial hardening release.',
  ].join('\n');
  const repoRoot = makeFixtureRepo({ changelog });
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'ok', 'forward-looking "0.2" prose in [Unreleased] must not be treated as the current released version');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('a missing version source is reported as blocked, not silently skipped', async () => {
  const repoRoot = makeFixtureRepo();
  fs.rmSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'blocked');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Regression (MEDIUM-5, Reviewer, CONFIRMED): a missing source previously
// MASKED a genuine, simultaneous disagreement among the sources that WERE
// present -- downgrading a real, unambiguous version drift to a merely
// 'blocked'/medium finding (and dropping the exit-1 a real disagreement
// deserves) instead of 'changed'/high.
test('a missing source does NOT mask a genuine disagreement among the remaining sources (MEDIUM-5)', async () => {
  const repoRoot = makeFixtureRepo({ codexPluginVersion: '0.0.9' });
  fs.rmSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'changed', 'a real disagreement must be reported even when another source is also missing');
  assert.equal(check.severity, 'high');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('malformed package.json engines is flagged, not silently accepted', async () => {
  const repoRoot = makeFixtureRepo();
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.engines.node = 'node22'; // malformed, not ">=X.Y.Z"
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const results = await runInternalDriftChecks({ repoRoot });
  const check = results.find((r) => r.id === 'package-json-engines-well-formed');
  assert.equal(check.status, 'changed');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
