// Workflow-security static tests for ecosystem-radar.yml (Monthly Ecosystem
// Radar, docs/adr/0039-monthly-ecosystem-radar.md). Mirrors
// ecosystem-maintenance-workflow.test.mjs: proves the read-only architecture
// is real in the SHIPPED workflow file, not merely described in the ADR.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ecosystem-radar.yml');

function workflowText() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * The workflow's own header deliberately NAMES the commands design Section
 * 15.5 forbids, so that a reader knows the rule without leaving the file. A
 * grep over raw text would therefore flag the documentation of a prohibition
 * as the prohibition itself. These checks are about what the workflow can
 * EXECUTE, so comment lines (and trailing comments) are stripped first.
 */
function workflowExecutableText() {
  return workflowText()
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

test('ecosystem-radar workflow: exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test('ecosystem-radar workflow: monthly schedule plus manual dispatch, per design Section 16.2', () => {
  const text = workflowText();
  assert.match(text, /^\s+- cron: "[^"]+"/m, 'a cron schedule must be declared');
  const cron = /- cron: "([^"]+)"/.exec(text)[1];
  const fields = cron.trim().split(/\s+/);
  assert.equal(fields.length, 5, 'cron must be a standard 5-field expression');
  assert.notEqual(fields[2], '*', 'a monthly radar must pin a day-of-month, not run daily');
  assert.equal(fields[4], '*', 'day-of-week must stay wildcard for a monthly cadence');
  assert.match(text, /^\s+workflow_dispatch:/m, 'manual dispatch must be available');
});

test('ecosystem-radar workflow: never triggered by push or pull_request, so it can never block a PR or a release', () => {
  const text = workflowText();
  assert.ok(!/^on:[\s\S]*?^\s+push:/m.test(text), 'must not trigger on push');
  assert.ok(!/^\s+pull_request:/m.test(text), 'must not trigger on pull_request');
});

test('ecosystem-radar workflow: contents: read at the top level, and nothing broader anywhere', () => {
  const text = workflowText();
  assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m, 'expected a top-level `permissions: { contents: read }` block');
  assert.equal((text.match(/^permissions:/gm) || []).length, 1, 'no job may declare its own, possibly broader, permissions block');
  for (const perm of ['contents: write', 'issues: write', 'pull-requests: write', 'actions: write', 'packages: write', 'deployments: write', 'id-token: write', 'attestations: write']) {
    assert.ok(!text.includes(perm), `must not grant ${perm}`);
  }
});

test('ecosystem-radar workflow: checkout does not persist credentials', () => {
  assert.match(workflowText(), /persist-credentials:\s*false/, 'checkout must disable credential persistence');
});

test('ecosystem-radar workflow: every action is pinned to a full 40-hex commit SHA', () => {
  const text = workflowText();
  const uses = text.match(/uses:\s*\S+/g) || [];
  assert.ok(uses.length > 0, 'the workflow must use at least one action');
  for (const u of uses) {
    assert.match(u, /@[0-9a-f]{40}$/, `unpinned or mutable action reference: ${u}`);
  }
});

test('ecosystem-radar workflow: no PAT or repository-write credential is referenced', () => {
  const text = workflowExecutableText();
  for (const secret of ['secrets.GITHUB_TOKEN', 'secrets.PAT', 'secrets.GH_TOKEN', 'GITHUB_TOKEN:']) {
    assert.ok(!text.includes(secret), `must not reference ${secret}`);
  }
});

// Design Section 15.5's prohibited-behaviour list, asserted against the file
// that would actually run it. A scheduled job that installed or executed a
// watched candidate would turn drift DETECTION into supply-chain exposure.
test('ecosystem-radar workflow: never installs or executes anything belonging to a watched candidate', () => {
  const text = workflowExecutableText();
  for (const forbidden of ['npm install', 'npm ci', 'npx ', 'pip install', 'yarn add', 'pnpm add', 'git clone', 'curl ', 'wget ']) {
    assert.ok(!text.includes(forbidden), `design Section 16.5 forbids ${forbidden.trim()} in this workflow`);
  }
});

test('ecosystem-radar workflow: never writes to the repository, opens a PR, or files an issue', () => {
  const text = workflowExecutableText();
  for (const forbidden of ['git commit', 'git push', 'gh pr create', 'gh issue create', 'peter-evans/create-pull-request', 'add-and-commit']) {
    assert.ok(!text.includes(forbidden), `must never ${forbidden}`);
  }
});

test('ecosystem-radar workflow: invokes the real read-only checker entrypoint', () => {
  assert.match(workflowText(), /node plugins\/krylo\/scripts\/maintenance\/check-ecosystem-radar\.mjs/, 'the workflow must run the shipped checker');
});
