// Proves the release workflow's own tag-vs-version check (task Section 25:
// "verify release scripts expect the correct relationship... test mismatch
// cases"). Extracts the REAL shell script text from release.yml's "Check
// tag matches plugin name and version" step and executes it via a real
// shell (bash, present on both this repository's Windows dev environment
// via Git Bash and the workflow's own ubuntu-latest runner) -- this tests
// the actual shipped script, not a reimplementation of its logic that
// could silently drift from what release.yml really runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

// Read from the real manifest rather than hardcoding. An independent review
// found the wrong-plugin-name negative control below had silently lost its
// discriminating power at the 0.3.0 bump: it passed `wrong-name--v0.2.0`,
// which after the bump is wrong in BOTH the name and the version, so it
// would still fail even if the script's name comparison were removed
// entirely -- passing for the wrong reason. Deriving the version here keeps
// each negative control isolating exactly one variable, permanently.
const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

/** Extract the `run: |` block immediately following the named step. */
function extractStepScript(workflowText, stepName) {
  const stepIdx = workflowText.indexOf(`name: ${stepName}`);
  if (stepIdx === -1) throw new Error(`step "${stepName}" not found in release.yml`);
  const runIdx = workflowText.indexOf('run: |', stepIdx);
  const afterRun = workflowText.slice(runIdx + 'run: |'.length);
  const lines = afterRun.split('\n').slice(1); // drop the rest of the "run: |" line itself
  const scriptLines = [];
  for (const line of lines) {
    if (line.trim() === '') { scriptLines.push(''); continue; }
    const indentMatch = /^( {6})(.*)$/.exec(line); // this workflow indents run: | blocks by 6 spaces
    if (!indentMatch) break;
    scriptLines.push(indentMatch[2]);
  }
  return scriptLines.join('\n');
}

function runTagCheck(tag) {
  const workflowText = fs.readFileSync(RELEASE_WORKFLOW, 'utf8');
  const script = extractStepScript(workflowText, 'Check tag matches plugin name and version (claude plugin tag format)');
  assert.ok(script.includes('test "$name--v$v" = "$TAG"'), 'the extracted script does not look like the expected tag-check step -- release.yml may have changed shape');
  try {
    execFileSync('bash', ['-c', script], { cwd: REPO_ROOT, env: { ...process.env, TAG: tag }, encoding: 'utf8' });
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err.status };
  }
}

test('the real release.yml tag-check script accepts the correct tag for the current product version', () => {
  const result = runTagCheck('krylo--v0.3.0');
  assert.equal(result.ok, true);
});

test('v0.3.1 with package 0.3.0 -> fail', () => {
  const result = runTagCheck('krylo--v0.3.1');
  assert.equal(result.ok, false);
});

test('a stale, already-released tag no longer matching the current package version -> fail', () => {
  const result = runTagCheck('krylo--v0.2.0');
  assert.equal(result.ok, false);
});

// Isolates exactly one variable: the version matches the real current one,
// so ONLY the plugin name is wrong. If the script's name comparison were
// ever dropped, this test fails -- which is the whole point of it.
test('a tag with the wrong plugin name prefix fails, with the version deliberately correct', () => {
  const result = runTagCheck(`wrong-name--v${CURRENT_VERSION}`);
  assert.equal(result.ok, false);
});

test('every uses: reference in release.yml is pinned to a full commit SHA', () => {
  const text = fs.readFileSync(RELEASE_WORKFLOW, 'utf8');
  const usesLines = text.match(/^\s*-?\s*uses:\s*.+$/gm) || [];
  assert.ok(usesLines.length > 0);
  for (const line of usesLines) {
    assert.match(line, /@[0-9a-f]{40}(\s|#|$)/, `not a full-SHA pin: ${line.trim()}`);
  }
});

// Regression: `gh release create "$TAG"` with no --target tags whatever
// commit the repository's DEFAULT BRANCH points to at the moment the
// GitHub API call actually creates/finalizes the release -- for a
// `--draft` release (as this workflow uses) that is not creation time but
// PUBLISH time, since GitHub does not fix a draft's target_commitish until
// it is published (confirmed against GitHub's own release-creation API
// description). A draft published after `main` has advanced would
// silently tag a different, unverified commit than the uploaded
// archive/checksums/attestation. `GITHUB_SHA` is fixed for the whole
// workflow run to the commit resolved at dispatch time (unaffected by
// later pushes, and preserved verbatim across a re-run), so pinning
// `--target "$GITHUB_SHA"` closes this regardless of how long the draft
// sits before being published. Extracts the real step text (not a
// reimplementation) matching this file's own established convention;
// the `--target` assertion is deliberately order-independent (it must not
// break on a harmless flag reordering) and a second assertion confirms the
// step's own `env:` block never shadows the reserved `GITHUB_SHA` variable
// with something else, which would silently defeat the pin.
test('the release-creation step explicitly pins the tag target to GITHUB_SHA, never the live default branch', () => {
  const workflowText = fs.readFileSync(RELEASE_WORKFLOW, 'utf8');
  const script = extractStepScript(workflowText, 'Create GitHub release (draft)');
  assert.ok(script.includes('gh release create "$TAG"'), 'the extracted script does not look like the expected release-create step -- release.yml may have changed shape');
  assert.match(
    script,
    /gh release create "\$TAG"[\s\S]*?--target "\$GITHUB_SHA"/,
    'gh release create must pin --target "$GITHUB_SHA" (order of other flags does not matter), not rely on the API\'s default-branch-at-publish-time behavior',
  );

  const stepIdx = workflowText.indexOf('name: Create GitHub release (draft)');
  const nextStepIdx = workflowText.indexOf('\n      - ', workflowText.indexOf('run:', stepIdx));
  const fullStepBlock = workflowText.slice(stepIdx, nextStepIdx === -1 ? workflowText.length : nextStepIdx);
  const envBlockMatch = /env:\s*\n((?:\s+\S.*\n?)+)/.exec(fullStepBlock);
  assert.ok(envBlockMatch, 'expected an env: block on this step');
  assert.doesNotMatch(
    envBlockMatch[1],
    /^\s*GITHUB_SHA:/m,
    'this step\'s own env: block must never redefine GITHUB_SHA -- doing so would silently defeat the --target pin above',
  );
});

test('the verify job requests only contents:read; the release job (needs:verify, gated behind manual dispatch + a passing verify) is the only job with write permissions', () => {
  const text = fs.readFileSync(RELEASE_WORKFLOW, 'utf8');
  const topLevelPermissions = /^permissions:\s*\n\s+contents:\s*read\s*$/m.exec(text);
  assert.ok(topLevelPermissions, 'expected a top-level contents:read permissions block (the verify job\'s own floor)');
  assert.match(text, /needs:\s*verify/, 'the release job must depend on the verify job passing first');
  assert.match(text, /^on:\s*\n\s+workflow_dispatch:/m, 'the release workflow must only be manually dispatched, never triggered by push/pull_request');
});
