// Proves every authoritative current-product-version field agrees, against
// the REAL repository (not a fixture) -- docs/process/
// V0_2_RELEASE_IMPLEMENTATION_PLAN.md Section 5's explicit requirement:
// "Add deterministic tests/scripts proving all authoritative current
// product-version fields agree on 0.2.0." Reuses the Ecosystem Maintenance
// checker's own internal-drift category rather than duplicating a second
// version-comparison implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInternalDriftChecks } from '../../scripts/maintenance/checks/internal-drift.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

test('every authoritative current-product-version field agrees, against the real repository', async () => {
  const results = await runInternalDriftChecks({ repoRoot: REPO_ROOT });
  const check = results.find((r) => r.id === 'product-version-agreement');
  assert.equal(check.status, 'ok', check.observed);
  assert.equal(check.current, '0.2.0');
});

test('package.json, both plugin manifests, and the marketplace manifest report the identical version, read directly (not via the shared checker) as an independent cross-check', () => {
  const readVersion = (relPath, extractor) => extractor(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')));
  const versions = {
    'package.json': readVersion('package.json', (j) => j.version),
    'package-lock.json': readVersion('package-lock.json', (j) => j.version),
    'plugins/krylo/.claude-plugin/plugin.json': readVersion('plugins/krylo/.claude-plugin/plugin.json', (j) => j.version),
    'plugins/krylo/.codex-plugin/plugin.json': readVersion('plugins/krylo/.codex-plugin/plugin.json', (j) => j.version),
    '.claude-plugin/marketplace.json': readVersion('.claude-plugin/marketplace.json', (j) => j.plugins[0].version),
  };
  const uniqueValues = new Set(Object.values(versions));
  assert.equal(uniqueValues.size, 1, `expected exactly one distinct version across all sources, got: ${JSON.stringify(versions)}`);
  assert.equal([...uniqueValues][0], '0.2.0');
});
