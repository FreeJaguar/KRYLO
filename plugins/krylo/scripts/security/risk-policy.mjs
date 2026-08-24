// KRYLO shared risk policy (host-neutral).
//
// Classifies commands, file targets, and MCP tool calls against
// policies/production-policy.json and policies/mcp-policy.json (the latter
// integrated with the Tool Trust Registry in catalog/tools.json). Production,
// destructive, publish, release, push, merge, IAM/secret, payment, external-
// message, and other declared write classes require an explicit, scoped,
// single-use, expiring user approval (scripts/runtime/update-state.mjs
// --request-approval / --resolve-approval). Sensitive files (.env, keys,
// credential stores) are protected.
//
// This module is shared by every host adapter (scripts/security/risk-gate.mjs
// for Claude Code today). It never reads a host-specific environment
// variable or Hook payload field, never calls process.exit, and never writes
// to stdout: every entrypoint here returns a plain decision or result object
// for its caller to translate into that host's own output format.
// `KRYLO_SECURITY_PROFILE` is the one host-neutral runtime variable this
// module still reads directly (as a fallback when a caller does not pass
// `securityProfile` explicitly), since every host adapter's bootstrap sets
// it, not just Claude Code's.
//
// Decision text (the `reason` field) references ONLY the policy class and its
// reason — never the matched command, path, or tool arguments (prompt-
// injection and secret-leak safety). The one exception is the approval's own
// audit trail (fingerprint + redacted target), which is never surfaced back
// to the model as free text.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getDataRoot, runLockPath } from '../lib/paths.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { redactAndTruncate, deepRedact } from '../lib/redact.mjs';
import { fingerprintText } from '../lib/action-fingerprint.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { isMcpToolName, classifyMcpTool } from './mcp-classifier.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, '..', '..', 'policies', 'production-policy.json');

export const DATA_ROOT_REASON =
  'The KRYLO runtime data directory (run state, approvals, pointers, wrapper config) is integrity-protected. ' +
  'It may only be modified through the KRYLO runtime scripts, never directly.';

/**
 * KRYLO's own control plane (state.json, current-run.json, wrapper-config.json)
 * must not be writable through direct tool calls, or a prompt-injected model
 * could self-approve gated actions or disable the gates entirely. Legitimate
 * mutations go through the runtime CLIs, which never embed the data-root path
 * in the command line.
 */
/**
 * A Bash command can reference the data root using a shell shorthand that
 * expands to the same location at execution time (`~`, `$HOME`, `${HOME}`,
 * the Windows `%USERPROFILE%`) instead of spelling out the literal resolved
 * path. Substring-matching the raw command text alone would miss these, so
 * this also checks a version of the command with those forms expanded to
 * the real home directory -- lowercased and tried with both path-separator
 * styles, the same way the resolved data root itself already is.
 */
function homeExpandedVariants(command, home) {
  if (!home) return [];
  const homeLower = String(home).toLowerCase();
  const withHomeReplaced = String(command)
    .replace(/~[/\\]/g, `${homeLower}/`)
    .replace(/\$\{?home\}?/gi, homeLower)
    .replace(/%userprofile%/gi, homeLower);
  return [withHomeReplaced, withHomeReplaced.replace(/\\/g, '/'), withHomeReplaced.replace(/\//g, '\\')];
}

/**
 * Resolve a path through any symlinks, best-effort. fs.realpathSync throws
 * for a path whose final component does not exist yet (a common case: a new
 * file about to be created); this walks up to the nearest existing ancestor,
 * resolves *that* through symlinks, and re-appends the not-yet-existing
 * suffix, so a not-yet-created file inside a symlinked directory still
 * resolves to where it would actually land.
 */
function realpathBestEffort(candidatePath) {
  let current = candidatePath;
  const suffix = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidatePath; // reached the filesystem root; give up gracefully
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function touchesDataRoot({ toolName, toolInput, cwd, dataRoot }) {
  const variants = [
    dataRoot,
    dataRoot.split(path.sep).join('/'),
    '.claude/plugins/data/krylo',
    '.claude\\plugins\\data\\krylo',
    // The multi-host Foundation's generic (non-Claude-specific) data-root
    // fallback (scripts/lib/paths.mjs::getDataRoot()) -- covered both as a
    // relative fragment and, for Bash, via home-shorthand expansion below.
    '.krylo/data',
    '.krylo\\data',
    'current-run.json',
    'wrapper-config.json',
  ].map((v) => v.toLowerCase());

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');

  if (name === 'Bash') {
    const command = String(input.command ?? '').toLowerCase();
    if (variants.some((v) => command.includes(v))) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => variants.some((v) => e.toLowerCase().includes(v)));
  }

  const target = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.notebook_path === 'string'
      ? input.notebook_path
      : '';
  if (target === '') return false;
  const lower = target.toLowerCase();
  if (variants.some((v) => lower.includes(v))) return true;
  try {
    const resolved = path.resolve(cwd || process.cwd(), target).toLowerCase();
    const rootLower = path.resolve(dataRoot).toLowerCase();
    if (resolved === rootLower || resolved.startsWith(rootLower + path.sep.toLowerCase())) return true;
    // path.resolve() alone never follows symlinks: a symlink outside the
    // data root that points into it would otherwise escape this check, even
    // though writing through it lands inside the data root for real. Resolve
    // both sides through any symlinks (best-effort for a target that does
    // not exist yet, e.g. a new file about to be created) before the final
    // comparison.
    const realResolved = realpathBestEffort(path.resolve(cwd || process.cwd(), target)).toLowerCase();
    const realRoot = realpathBestEffort(path.resolve(dataRoot)).toLowerCase();
    return realResolved === realRoot || realResolved.startsWith(realRoot + path.sep.toLowerCase());
  } catch {
    return false;
  }
}

function loadPolicy() {
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  return JSON.parse(raw);
}

function firstMatchingClass(policy, command) {
  const normalized = String(command).replace(/\s+/g, ' ');
  // git-force is a specialization of git-push; test it before git-push so the
  // more specific class wins.
  const order = Object.keys(policy.approvalClasses).sort((a, b) => (a === 'git-force' ? -1 : b === 'git-force' ? 1 : 0));
  for (const className of order) {
    const cls = policy.approvalClasses[className];
    for (const pattern of cls.patterns) {
      if (new RegExp(pattern, 'i').test(normalized)) {
        return { className, reason: cls.reason };
      }
    }
  }
  return null;
}

function matchesSensitivePath(policy, text) {
  if (typeof text !== 'string' || text === '') return false;
  return policy.sensitivePaths.patterns.some((p) => new RegExp(p, 'i').test(text));
}

/**
 * Sensitive-path patterns are anchored to path boundaries, so a command like
 * `cat .env` must be checked token-by-token as well as whole-string (for
 * embedded paths like `cat ./config/.env`).
 */
function commandTouchesSensitivePath(policy, command) {
  if (matchesSensitivePath(policy, command)) return true;
  return String(command)
    .split(/[\s;|&<>()]+/)
    .filter((t) => t !== '')
    .some((token) => matchesSensitivePath(policy, token));
}

function computeFingerprint(toolName, toolInput) {
  // Bash uses the exact same normalization as update-state.mjs's
  // --request-approval --target, so a pre-bound approval's fingerprint can
  // be compared for an exact match against the command actually attempted.
  if (toolName === 'Bash') return fingerprintText(toolInput.command ?? '');
  const descriptor = JSON.stringify(deepRedact({ tool: toolName, input: toolInput ?? {} }));
  return crypto.createHash('sha256').update(descriptor, 'utf8').digest('hex');
}

function computeTargetLabel(toolName, toolInput) {
  if (toolName === 'Bash') return redactAndTruncate(String(toolInput.command ?? '').replace(/\s+/g, ' '), 300);
  if (toolInput && typeof toolInput.file_path === 'string') return redactAndTruncate(toolInput.file_path, 300);
  if (toolInput && typeof toolInput.notebook_path === 'string') return redactAndTruncate(toolInput.notebook_path, 300);
  return redactAndTruncate(JSON.stringify(deepRedact(toolInput ?? {})), 300);
}

function isApprovalUsable(approval, { className, projectRootHash, runId, environment, nowMs, fingerprint }) {
  if (approval.actionClass !== className) return false;
  if (approval.status !== 'approved') return false;
  // Absent binding fields mean "not bound to this dimension" (pre-0.1.1
  // approvals, or a caller that never set one); present fields must match
  // exactly. A mismatch on any bound dimension refuses consumption.
  if (approval.projectRootHash && approval.projectRootHash !== projectRootHash) return false;
  if (approval.runId && approval.runId !== runId) return false;
  if (approval.environment && approval.environment !== environment) return false;
  if (approval.expiresAt && Date.parse(approval.expiresAt) < nowMs) return false;
  // A caller who requested approval with --target pre-binds the exact
  // action: only an attempt whose own fingerprint matches may consume it. A
  // different or modified command in the same actionClass must be refused
  // and requires its own fresh approval.
  if (approval.fingerprint && approval.fingerprint !== fingerprint) return false;
  return true;
}

/**
 * Classify one tool call against KRYLO's shared risk policy. Host-neutral:
 * takes a plain { toolName, toolInput, cwd, dataRoot } input and returns one
 * of:
 *
 *   { action: 'pass', category: 'pass' | 'mcp-pass' }
 *   { action: 'deny', category: '<policy-class>', reason: '...' }
 *   { action: 'require-approval', category: '<actionClass>', actionClass: '<actionClass>', reason: '...' }
 *
 * Never throws for a well-formed input; never calls process.exit or writes
 * to stdout. A caller must catch and fail toward its own safe default (a
 * deterministic deny, not an unconfirmed-safe "ask") for a malformed input
 * (missing/invalid dataRoot, unreadable policy file, etc).
 */
export function classifyRiskAction({ toolName, toolInput, cwd, dataRoot } = {}) {
  const name = String(toolName ?? '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const resolvedDataRoot = typeof dataRoot === 'string' && dataRoot.trim() !== '' ? dataRoot : getDataRoot();
  const policy = loadPolicy();

  if (touchesDataRoot({ toolName: name, toolInput: input, cwd, dataRoot: resolvedDataRoot })) {
    return { action: 'deny', category: 'data-root-protection', reason: DATA_ROOT_REASON };
  }

  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';

    if (commandTouchesSensitivePath(policy, command)) {
      return {
        action: 'deny',
        category: 'sensitive-path',
        reason: `${policy.sensitivePaths.reason} This command touches a protected secret path.`,
      };
    }

    const match = firstMatchingClass(policy, command);
    if (match) {
      return { action: 'require-approval', category: match.className, actionClass: match.className, reason: match.reason };
    }

    return { action: 'pass', category: 'pass' };
  }

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const target = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : '';
    if (matchesSensitivePath(policy, target)) {
      return {
        action: 'deny',
        category: 'sensitive-path',
        reason: `${policy.sensitivePaths.reason} This file target is a protected secret path.`,
      };
    }
    return { action: 'pass', category: 'pass' };
  }

  if (isMcpToolName(name)) {
    const match = classifyMcpTool(name);
    if (match) {
      return { action: 'require-approval', category: match.className, actionClass: match.className, reason: match.reason };
    }
    return { action: 'pass', category: 'mcp-pass' };
  }

  return { action: 'pass', category: 'pass' };
}

/**
 * Atomically find and spend the one usable approval for this class, scoped
 * to the exact project + run + (optional) environment. State is reloaded
 * fresh under an exclusive per-run lock so two concurrent evaluations for the
 * same class can never both consume the same single-use approval.
 *
 * `securityProfile` is taken as an explicit input (falling back to the
 * host-neutral `KRYLO_SECURITY_PROFILE` runtime variable when omitted) rather
 * than always reading the environment internally, so a caller can bind an
 * approval consumption to a specific profile value without relying on
 * process-global state.
 *
 * No transport may bypass these checks: actionClass exact match, status ===
 * 'approved', projectRootHash/runId/environment binding when present, expiry,
 * exact fingerprint binding when present, exclusive per-run file lock,
 * status -> 'consumed', consumedAt timestamp, single save under the lock.
 */
export function consumeMatchingApproval({ runId, actionClass, toolName, toolInput, projectRootHash, securityProfile } = {}) {
  return withFileLock(runLockPath(runId), () => {
    const reloaded = loadState(runId);
    if (!reloaded.ok) return { consumed: false };
    const freshState = reloaded.value;
    const environment = securityProfile !== undefined && securityProfile !== null
      ? securityProfile
      : (process.env.KRYLO_SECURITY_PROFILE || null);
    const nowMs = Date.now();
    const fingerprint = computeFingerprint(toolName, toolInput ?? {});

    const approvals = Array.isArray(freshState.riskApprovals) ? freshState.riskApprovals : [];
    const approval = approvals.find((a) => isApprovalUsable(a, { className: actionClass, projectRootHash, runId, environment, nowMs, fingerprint }));
    if (!approval) return { consumed: false };

    approval.status = 'consumed';
    approval.consumedAt = new Date().toISOString();
    // Preserve a pre-bound fingerprint/target (set by --request-approval
    // --target); an untargeted approval records what actually consumed it,
    // for audit only — it is never used to authorize a second action.
    approval.fingerprint = approval.fingerprint || fingerprint;
    approval.target = approval.target || computeTargetLabel(toolName, toolInput ?? {});
    const saved = saveState(freshState);
    return { consumed: saved.ok, approvalId: approval.id };
  });
}
