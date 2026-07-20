// KRYLO runtime data-root and safe-path helpers.
//
// All runtime state lives under a single data root:
//   runs/<runId>/state.json
//   runs/<runId>/artifacts/
//   telemetry/<runId>.jsonl
//   current-run.json
//
// Every path used by the runtime must be produced through safeJoin() so a
// malformed or malicious runId/segment can never escape the data root.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolve the KRYLO plugin data root.
 * Honors CLAUDE_PLUGIN_DATA so tests can point at a temp directory.
 */
export function getDataRoot() {
  const envRoot = process.env.CLAUDE_PLUGIN_DATA;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return path.resolve(envRoot);
  }
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'krylo');
}

/** Create a directory (recursively) if it does not already exist. */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Resolve the real path of the nearest existing ancestor of targetPath and
 * reattach the non-existing suffix. Used to detect symlink escapes even when
 * the final path component does not exist yet (e.g. before writing a new file).
 */
function resolveRealOrNearestExisting(targetPath) {
  const suffixParts = [];
  let current = targetPath;
  // eslint-disable-next-line no-constant-condition
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding an existing ancestor.
      break;
    }
    suffixParts.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return suffixParts.length > 0 ? path.join(real, ...suffixParts) : real;
}

function assertWithinRoot(root, target) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`Refusing path outside data root: target escapes ${root}`);
  }
}

/**
 * Join root with segments, refusing any result that escapes root after
 * resolving `..` traversal, absolute-path injection, and symlink escapes.
 * Returns the resolved absolute path (not real-pathed, since the target may
 * not exist yet).
 */
export function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const rootReal = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;

  // Build the candidate from the REAL root so a data root that is itself
  // reached through a symlink (e.g. macOS /tmp) does not fail-closed on
  // legitimate paths. path.resolve (unlike path.join) collapses `..` and lets
  // an absolute segment override the base, which is exactly the injection we
  // must catch.
  const candidate = path.resolve(rootReal, ...segments);
  assertWithinRoot(rootReal, candidate);

  const candidateReal = resolveRealOrNearestExisting(candidate);
  assertWithinRoot(rootReal, candidateReal);

  return candidate;
}

export function runsRootDir() {
  return safeJoin(getDataRoot(), 'runs');
}

export function telemetryRootDir() {
  return safeJoin(getDataRoot(), 'telemetry');
}

export function runDir(runId) {
  return safeJoin(getDataRoot(), 'runs', runId);
}

export function runStatePath(runId) {
  return safeJoin(getDataRoot(), 'runs', runId, 'state.json');
}

export function runArtifactsDir(runId) {
  return safeJoin(getDataRoot(), 'runs', runId, 'artifacts');
}

export function telemetryPath(runId) {
  return safeJoin(getDataRoot(), 'telemetry', `${runId}.jsonl`);
}

export function currentRunPointerPath() {
  return safeJoin(getDataRoot(), 'current-run.json');
}
