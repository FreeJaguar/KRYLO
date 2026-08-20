// KRYLO runtime data-root and safe-path helpers.
//
// All runtime state lives under a single data root:
//   runs/<runId>/state.json
//   runs/<runId>/artifacts/
//   telemetry/<runId>.jsonl
//   active-runs/<projectRootHash>/<sessionSegment>.json  (per-project, per-session pointer)
//   current-run.json  (legacy single pointer; read once for migration, then removed)
//
// Every path used by the runtime must be produced through safeJoin() so a
// malformed or malicious runId/segment can never escape the data root.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { HOST_NAMES } from './host-context.mjs';

/**
 * Resolve the KRYLO plugin data root.
 * Honors KRYLO_DATA_ROOT (host-neutral) so tests, and any host adapter, can
 * point at a temp or host-specific directory. Claude-facing entrypoints
 * bootstrap KRYLO_DATA_ROOT from the Claude-specific plugin data location via
 * scripts/host/claude/context.mjs before this is read, so existing Claude
 * users keep using the same physical 0.1.1 data root.
 */
export function getDataRoot() {
  const envRoot = process.env.KRYLO_DATA_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return path.resolve(envRoot);
  }
  return path.join(os.homedir(), '.krylo', 'data');
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
 *
 * Deliberately does not pre-check `fs.existsSync` and then call
 * `fs.realpathSync` as two separate steps: that window lets a concurrent
 * process delete or rename the very path being checked in between (observed
 * under concurrent lock-file creation/removal, scripts/lib/lock.mjs, on
 * Windows: ENOENT/EPERM from `realpathSync` for a path `existsSync` had just
 * reported present). `realpathSync` alone is a single syscall with no such
 * gap; any failure — not found, or vanished between an earlier check and now
 * — is treated identically: walk up to the parent and retry.
 */
function resolveRealOrNearestExisting(targetPath) {
  const suffixParts = [];
  let current = targetPath;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return suffixParts.length > 0 ? path.join(real, ...suffixParts) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding a resolvable ancestor.
        return suffixParts.length > 0 ? path.join(current, ...suffixParts) : current;
      }
      suffixParts.unshift(path.basename(current));
      current = parent;
    }
  }
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
  const rootReal = resolveRealOrNearestExisting(resolvedRoot);

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

/** Exclusive-lock marker for one run's state (serializes risk-approval consumption). */
export function runLockPath(runId) {
  return safeJoin(getDataRoot(), 'runs', runId, '.state.lock');
}

export function runArtifactsDir(runId) {
  return safeJoin(getDataRoot(), 'runs', runId, 'artifacts');
}

export function telemetryPath(runId) {
  return safeJoin(getDataRoot(), 'telemetry', `${runId}.jsonl`);
}

/** Legacy (pre-0.1.1) single global pointer. Read only, for one-time migration. */
export function currentRunPointerPath() {
  return safeJoin(getDataRoot(), 'current-run.json');
}

/**
 * A session identifier becomes a filesystem path segment. Claude Code session
 * ids are UUIDs and pass through unchanged; anything else (or anything
 * containing characters unsafe for a path segment) is hashed instead, so a
 * malformed or adversarial session id can never be used for traversal.
 */
function safeSessionSegment(sessionId) {
  if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return sessionId;
  }
  return crypto.createHash('sha256').update(String(sessionId ?? ''), 'utf8').digest('hex');
}

export function activeRunsRootDir() {
  return safeJoin(getDataRoot(), 'active-runs');
}

/** Directory holding every host's pointer subdirectory for one project. */
export function activeRunsProjectDir(projectRootHash) {
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash);
}

/** A host name becomes a filesystem path segment: refuse anything not a known host. */
function assertValidHost(host) {
  if (!HOST_NAMES.includes(host)) {
    throw new Error(`Refusing unsupported host as path segment: ${JSON.stringify(host)}`);
  }
}

/** Directory holding every session pointer for one project, scoped to one host. */
export function activeRunsHostDir(projectRootHash, host) {
  assertValidHost(host);
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, host);
}

/** Path to the pointer file for one project + host + host-session-id triple. */
export function activeRunPointerPath(projectRootHash, host, hostSessionId) {
  assertValidHost(host);
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, host, `${safeSessionSegment(hostSessionId)}.json`);
}

/**
 * Path to the pre-0.2.0 flat pointer layout (`active-runs/<project>/<session>.json`,
 * no host segment). Read-only: used only to detect and lazily migrate a
 * still-active 0.1.1 pointer into the new host-scoped layout.
 */
export function legacyActiveRunPointerPath(projectRootHash, sessionId) {
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, `${safeSessionSegment(sessionId)}.json`);
}
