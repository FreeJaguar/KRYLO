#!/usr/bin/env node
// Independently verify RELEASE_MANIFEST.json against the actual current
// git-tracked tree at HEAD (docs/process/V0_2_RELEASE_IMPLEMENTATION_PLAN.md
// Section 7). Never trusts the manifest's own claims -- recomputes every
// hash independently and cross-checks against `git ls-files` in both
// directions (a file the manifest lists that no longer exists/is untracked,
// and a git-tracked file the manifest is missing).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateManifest } from './generate-release-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'RELEASE_MANIFEST.json');

function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return new Set(out.split('\n').filter(Boolean));
}

export function verifyManifest() {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`could not read/parse RELEASE_MANIFEST.json: ${String(err?.message || err)}`] };
  }

  const tracked = gitTrackedFiles();
  const manifestPaths = new Set(manifest.files.map((f) => f.path));

  // Every manifest entry must correspond to a real, currently git-tracked file.
  for (const entry of manifest.files) {
    if (!tracked.has(entry.path)) {
      errors.push(`manifest lists "${entry.path}", which is not (or no longer) git-tracked`);
    }
  }

  // Every git-tracked file (other than the manifest itself) must be listed --
  // a missing shipping file is exactly what Section 7's own step 3 requires
  // catching.
  for (const trackedPath of tracked) {
    if (trackedPath === 'RELEASE_MANIFEST.json') continue;
    if (!manifestPaths.has(trackedPath)) {
      errors.push(`git-tracked file "${trackedPath}" is missing from the manifest`);
    }
  }

  // Independently recompute every hash from the real git blob content and
  // compare -- never trust the manifest's own claimed bytes/sha256.
  const fresh = generateManifest({ version: manifest.version });
  const freshByPath = new Map(fresh.files.map((f) => [f.path, f]));
  for (const entry of manifest.files) {
    const real = freshByPath.get(entry.path);
    if (!real) continue; // already reported above
    if (real.sha256 !== entry.sha256) {
      errors.push(`hash mismatch for "${entry.path}": manifest says ${entry.sha256}, actual is ${real.sha256}`);
    }
    if (real.bytes !== entry.bytes) {
      errors.push(`byte-count mismatch for "${entry.path}": manifest says ${entry.bytes}, actual is ${real.bytes}`);
    }
  }

  if (manifest.fileCount !== manifest.files.length) {
    errors.push(`fileCount field (${manifest.fileCount}) does not match the actual entry count (${manifest.files.length})`);
  }

  return { ok: errors.length === 0, errors, fileCount: manifest.files.length };
}

function main() {
  const result = verifyManifest();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
