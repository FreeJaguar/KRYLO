// TDD category J (task Section 19.J): workflow-security static tests for
// ecosystem-maintenance.yml. Proves the read-only architecture is real in
// the shipped workflow file, not just described in docs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ecosystem-maintenance.yml');

const FULL_SHA_RE = /uses:\s*[^\s@]+@([0-9a-f]{40})\b/g;

test('the workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test('contents: read at the top level, nothing broader', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const permissionsMatch = /^permissions:\s*\n\s+contents:\s*read\s*$/m.exec(text);
  assert.ok(permissionsMatch, 'expected a top-level `permissions: { contents: read }` block');
  // No write permission of any kind, anywhere in the file (job-level
  // permissions blocks would appear as additional `permissions:` sections;
  // this file must have exactly one, the top-level read-only one).
  const permissionsBlocks = text.match(/^permissions:/gm) || [];
  assert.equal(permissionsBlocks.length, 1, 'no job should declare its own, possibly broader, permissions block');
});

test('no write permission is granted anywhere (contents/issues/pull-requests/actions/packages/deployments/id-token)', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  for (const perm of ['contents: write', 'issues: write', 'pull-requests: write', 'actions: write', 'packages: write', 'deployments: write', 'id-token: write']) {
    assert.ok(!text.includes(perm), `must not grant ${perm}`);
  }
});

test('no PAT / repository write credential is referenced', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.ok(!/secrets\./.test(text), 'the workflow must not require any repository secret');
  assert.ok(!/\bPAT\b|personal[- ]access[- ]token/i.test(text), 'must not reference a Personal Access Token (word-bounded, to avoid a false positive on words like "workflow_dispatch")');
});

test('checkout is pinned to a full commit SHA and persist-credentials is false', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(text, /uses:\s*actions\/checkout@[0-9a-f]{40}/);
  assert.match(text, /persist-credentials:\s*false/);
});

test('every action reference in the workflow is pinned to a full 40-hex commit SHA', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const usesLines = text.match(/^\s*-?\s*uses:\s*.+$/gm) || [];
  assert.ok(usesLines.length > 0, 'expected at least one `uses:` reference');
  for (const line of usesLines) {
    assert.match(line, /@[0-9a-f]{40}(\s|#|$)/, `not a full-SHA pin: ${line.trim()}`);
  }
});

test('no issue/PR/release-write step exists', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  for (const pattern of [/gh\s+(issue|pr|release)\s+create/, /gh\s+pr\s+comment/, /actions\/create-release/, /peter-evans\/create-pull-request/]) {
    assert.ok(!pattern.test(text), `must not create/comment on an issue, PR, or release: ${pattern}`);
  }
});

test('no git push, branch creation, or commit step exists', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.ok(!/git\s+push/.test(text));
  assert.ok(!/git\s+commit/.test(text));
  assert.ok(!/git\s+checkout\s+-b/.test(text));
});

test('never runs on push or pull_request -- cannot block a PR or gate a release', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const onMatch = /^on:\s*\n([\s\S]*?)(?=\npermissions:)/m.exec(text);
  assert.ok(onMatch);
  assert.ok(!/^\s*push:/m.test(onMatch[1]));
  assert.ok(!/^\s*pull_request:/m.test(onMatch[1]));
  assert.match(onMatch[1], /workflow_dispatch/);
});

test('the checker CLI itself is invoked, not reimplemented inline in the workflow', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(text, /scripts\/maintenance\/check-ecosystem\.mjs/);
});
