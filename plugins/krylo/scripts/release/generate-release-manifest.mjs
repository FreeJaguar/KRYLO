#!/usr/bin/env node
// Regenerate RELEASE_MANIFEST.json from the actual, current git-tracked
// file tree (docs/process/V0_2_RELEASE_IMPLEMENTATION_PLAN.md Section 7).
//
// Uses `git ls-files` as the sole source of truth for "files intended to
// ship" -- this is deterministic by construction: a local checkpoint/review
// artifact (prompt.md, *.patch, *-status.txt, *-commits.txt) can only ever
// appear here if it was actually `git add`ed, which this project's own
// established discipline never does (confirmed via `git status --short`
// throughout every checkpoint of this release line: they remain untracked).
// No hand-maintained inclusion/exclusion list is needed beyond the two
// generated-output files below, which would otherwise self-reference.
//
// Determinism: file list from `git ls-files` is already sorted; content is
// hashed directly from the git-tracked blob (not the working-tree file, so
// a stray CRLF/LF or uncommitted local edit can never produce a different
// hash than what will actually be shipped); no timestamp or other
// nondeterministic value is embedded (deliberately -- Section 22 requires
// hash(first output) === hash(second output) across repeated runs from an
// unchanged HEAD, which a `generatedAt` field would break).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SELF_EXCLUDED = new Set(['RELEASE_MANIFEST.json']);

function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

function hashBlob(relPath) {
  // Hash the git blob content, not the working-tree file -- immune to a
  // dirty working tree, line-ending normalization differences, or a file
  // permission bit, and is exactly the content `git archive`/a clone of
  // this exact commit would produce.
  const content = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return { bytes: content.length, sha256 };
}

export function generateManifest({ version }) {
  const files = gitTrackedFiles().filter((p) => !SELF_EXCLUDED.has(p));
  const entries = files.map((relPath) => {
    const { bytes, sha256 } = hashBlob(relPath);
    return { path: relPath, bytes, sha256 };
  });
  return {
    name: 'krylo-release',
    version,
    note: 'Per-file SHA-256 of every git-tracked file at HEAD (excluding this manifest itself). Hashed from the committed git blob content, not the working tree, so this is reproducible from a clean clone of the same commit. Deterministic: regenerating from an unchanged HEAD produces byte-identical output (no timestamp or other nondeterministic field is embedded). BLUEPRINT_MANIFEST.json remains the separate, immutable record of blueprint 0.1.2 as delivered in the baseline commit.',
    fileCount: entries.length,
    files: entries,
  };
}

function main() {
  const args = process.argv.slice(2);
  const versionArg = args.find((a) => a.startsWith('--version='));
  if (!versionArg) {
    process.stderr.write('Usage: generate-release-manifest.mjs --version=X.Y.Z\n');
    process.exit(2);
  }
  const version = versionArg.slice('--version='.length);
  const manifest = generateManifest({ version });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
