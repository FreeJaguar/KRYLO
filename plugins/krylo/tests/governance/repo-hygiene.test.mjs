// Regression guard for a real incident: `.claude/scheduled_tasks.lock`
// (a local Claude Code runtime lock carrying a PID, process-start time, and
// session id) was committed to this public repository. This test fails the
// build whenever a Claude Code local-runtime or lock file is tracked by git,
// anywhere in the repository, so it can never happen again silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// Path fragments that only ever hold local, machine-specific Claude Code
// runtime state: process locks, local-only settings overrides, and agent
// scratch memory. None of these belong in a public repository.
const FORBIDDEN_PATTERNS = [
  /(^|\/)\.claude\/.*\.lock$/,
  /(^|\/)\.claude\/scheduled_tasks\.lock$/,
  /(^|\/)\.claude\/settings\.local\.json$/,
  /(^|\/)\.claude\/agent-memory\//,
];

function listTrackedFiles() {
  const res = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ls-files failed: ${res.stderr}`);
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('no Claude Code local-runtime, lock, or session file is tracked by git', () => {
  const tracked = listTrackedFiles();
  const offenders = tracked.filter((file) => FORBIDDEN_PATTERNS.some((re) => re.test(file)));
  assert.deepEqual(offenders, [], `local Claude Code state must never be committed: ${offenders.join(', ')}`);
});

test('.gitignore declares the local-runtime patterns this test enforces', () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /\.claude\/\*\.lock/);
  assert.match(gitignore, /\.claude\/agent-memory\//);
});
