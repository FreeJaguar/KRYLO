#!/usr/bin/env node
// Regenerate RELEASE_MANIFEST.json from the actual, current git-tracked
// file tree (docs/process/V0_2_RELEASE_IMPLEMENTATION_PLAN.md Section 7).
//
// Uses `git ls-tree -r HEAD` as the sole source of truth for "files
// intended to ship" -- this is deterministic by construction: a local
// checkpoint/review artifact (prompt.md, *.patch, *-status.txt,
// *-commits.txt) can only ever appear here if it was actually `git add`ed,
// which this project's own established discipline never does (confirmed
// via `git status --short` throughout every checkpoint of this release
// line: they remain untracked). No hand-maintained inclusion/exclusion
// list is needed beyond the one generated-output file below, which would
// otherwise self-reference.
//
// Determinism: `git ls-tree -r` output is already in a fixed tree order;
// content is hashed directly from the git-tracked blob (not the
// working-tree file, so a stray CRLF/LF or uncommitted local edit can
// never produce a different hash than what will actually be shipped); no
// timestamp or other nondeterministic value is embedded (deliberately --
// Section 22 requires hash(first output) === hash(second output) across
// repeated runs from an unchanged HEAD, which a `generatedAt` field would
// break).
//
// Performance: all blob content is read via a SINGLE `git cat-file
// --batch` subprocess fed every blob SHA at once, rather than one `git
// show` subprocess per file -- for this repository's ~340 tracked files,
// this is the difference between ~6s and well under 1s, and matters
// because the test suite (release-manifest.test.mjs) calls this function
// repeatedly.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SELF_EXCLUDED = new Set(['RELEASE_MANIFEST.json']);

/** { path, sha }[] for every blob in the tree at HEAD, in git's own tree order. */
function gitTrackedBlobs() {
  const res = spawnSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git ls-tree failed: ${res.stderr}`);
  const entries = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    // "<mode> <type> <sha>\t<path>"
    const tabIdx = line.indexOf('\t');
    const meta = line.slice(0, tabIdx).split(' ');
    const filePath = line.slice(tabIdx + 1);
    entries.push({ path: filePath, sha: meta[2] });
  }
  return entries;
}

/**
 * Read every blob's content in one `git cat-file --batch` subprocess.
 * Returns a Map<sha, Buffer>. Parses the batch protocol manually (a
 * header line "<sha> blob <size>\n" followed by exactly <size> content
 * bytes and a trailing newline, repeated) since content is arbitrary
 * binary and cannot be split on newlines.
 */
function batchReadBlobs(shas) {
  const input = `${shas.join('\n')}\n`;
  const res = spawnSync('git', ['cat-file', '--batch'], { cwd: REPO_ROOT, input, maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git cat-file --batch failed: ${res.stderr?.toString() || ''}`);
  const buf = res.stdout;
  const result = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const headerEnd = buf.indexOf(0x0a, offset); // '\n'
    if (headerEnd === -1) break;
    const header = buf.slice(offset, headerEnd).toString('utf8');
    const [sha, , sizeStr] = header.split(' ');
    const size = Number(sizeStr);
    const contentStart = headerEnd + 1;
    const content = buf.subarray(contentStart, contentStart + size);
    result.set(sha, Buffer.from(content));
    offset = contentStart + size + 1; // skip the trailing newline after content
  }
  return result;
}

export function generateManifest({ version }) {
  const blobs = gitTrackedBlobs().filter((b) => !SELF_EXCLUDED.has(b.path));
  const contentBySha = batchReadBlobs(blobs.map((b) => b.sha));
  const entries = blobs
    .map(({ path: relPath, sha }) => {
      const content = contentBySha.get(sha);
      if (!content) throw new Error(`git cat-file --batch did not return content for ${relPath} (${sha})`);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      return { path: relPath, bytes: content.length, sha256 };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
