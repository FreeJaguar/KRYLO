// Proves RELEASE_MANIFEST.json's generator/verifier tooling actually meets
// task Section 7/22's guarantees: deterministic regeneration (byte-for-byte
// identical across repeated runs from an unchanged HEAD), every entry
// corresponds to a real git-tracked file with a correct hash, no
// git-tracked file is missing, and -- critically -- a local checkpoint/
// review artifact (never git-tracked) can never appear in the manifest.
//
// generateManifest() hashes every git-tracked file via its own `git show`
// subprocess (~6s for this repository's ~340 files) -- a real, deliberate
// cost paid once at actual release-preparation time, not a hot path. This
// test file computes ONE shared base manifest and reuses/deep-clones it
// everywhere a fresh generateManifest() call is not the actual thing under
// test, rather than regenerating from scratch in every test (an earlier
// version of this file did that and took over a minute to run).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateManifest } from '../../scripts/release/generate-release-manifest.mjs';
import { verifyManifest } from '../../scripts/release/verify-release-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const BASE_MANIFEST = generateManifest({ version: '0.2.0' });

function writeTempManifest(manifest) {
  const p = path.join(os.tmpdir(), `krylo-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(manifest));
  return p;
}

function cloneManifest() {
  return JSON.parse(JSON.stringify(BASE_MANIFEST));
}

test('generateManifest is deterministic: two independent runs from the same HEAD produce byte-identical JSON', () => {
  const fresh = generateManifest({ version: '0.2.0' });
  assert.equal(JSON.stringify(BASE_MANIFEST), JSON.stringify(fresh));
});

test('every generated entry has a well-formed 64-hex-character SHA-256 and a non-negative byte count', () => {
  assert.ok(BASE_MANIFEST.files.length > 100, 'sanity: a real repository should have well over 100 tracked files');
  for (const entry of BASE_MANIFEST.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `malformed hash for ${entry.path}`);
    assert.ok(entry.bytes >= 0, `negative byte count for ${entry.path}`);
    assert.equal(typeof entry.path, 'string');
  }
});

test('no known local checkpoint/review artifact pattern ever appears in the generated manifest, even if one exists untracked on disk right now', () => {
  const suspicious = BASE_MANIFEST.files.filter(
    (f) => f.path === 'prompt.md' || f.path.endsWith('.patch') || f.path.endsWith('-status.txt') || f.path.endsWith('-commits.txt'),
  );
  assert.deepEqual(suspicious, [], `local checkpoint/review artifacts must never appear in the release manifest: ${JSON.stringify(suspicious)}`);
});

test('the manifest is internally consistent: fileCount matches the actual entry count', () => {
  assert.equal(BASE_MANIFEST.fileCount, BASE_MANIFEST.files.length);
});

test('verifyManifest against the real, currently-committed RELEASE_MANIFEST.json reports ok with zero errors', () => {
  const result = verifyManifest();
  // A stale manifest is the single most common way this test fails, and its
  // raw output is a wall of twenty-plus hash mismatches that says nothing
  // about what to DO. It is the expected state of any commit that changed a
  // tracked file without regenerating -- including every automated
  // dependency PR, since a bot cannot regenerate it and this repository
  // deliberately grants no repository-write automation (ADR-0031). Lead with
  // the remedy, keep the raw errors after it for the genuinely different
  // case (a file the manifest lists that is no longer tracked, or vice
  // versa).
  const remedy = 'RELEASE_MANIFEST.json is out of date for this commit. Regenerate it with `npm run manifest` and commit the result. (This is expected on any commit that changed a tracked file, including an automated dependency PR: the manifest covers EVERY git-tracked file by design, and narrowing that scope to keep a bot green would weaken a supply-chain control.)';
  assert.equal(result.ok, true, `${remedy}\n\nraw verifier errors:\n${JSON.stringify(result.errors, null, 2)}`);
  assert.deepEqual(result.errors, []);
});

test('verifyManifest catches a hash mismatch introduced into a real (temp-file) manifest', () => {
  const manifest = cloneManifest();
  manifest.files[0] = { ...manifest.files[0], sha256: '0'.repeat(64) };
  const tamperedPath = writeTempManifest(manifest);
  try {
    const result = verifyManifest({ manifestPath: tamperedPath });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('hash mismatch') && e.includes(manifest.files[0].path)));
  } finally {
    fs.rmSync(tamperedPath, { force: true });
  }
});

test('verifyManifest catches a git-tracked file missing from a real (temp-file) manifest', () => {
  const manifest = cloneManifest();
  const removedPath = manifest.files[0].path;
  manifest.files = manifest.files.slice(1);
  manifest.fileCount = manifest.files.length;
  const tamperedPath = writeTempManifest(manifest);
  try {
    const result = verifyManifest({ manifestPath: tamperedPath });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(removedPath) && e.includes('missing')));
  } finally {
    fs.rmSync(tamperedPath, { force: true });
  }
});

test('verifyManifest catches a manifest entry for a file that is not (or no longer) git-tracked', () => {
  const manifest = cloneManifest();
  manifest.files.push({ path: 'this/file/does/not/exist/in/git.txt', bytes: 10, sha256: '1'.repeat(64) });
  manifest.fileCount = manifest.files.length;
  const tamperedPath = writeTempManifest(manifest);
  try {
    const result = verifyManifest({ manifestPath: tamperedPath });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('this/file/does/not/exist/in/git.txt') && e.includes('not')));
  } finally {
    fs.rmSync(tamperedPath, { force: true });
  }
});
