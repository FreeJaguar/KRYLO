#!/usr/bin/env node
// KRYLO risk gate (PreToolUse, matcher: Bash|Write|Edit|NotebookEdit|mcp__.*).
//
// Classifies commands, file targets, and MCP tool calls against
// policies/production-policy.json and policies/mcp-policy.json (the latter
// integrated with the Tool Trust Registry in catalog/tools.json). Production,
// destructive, publish, release, push, merge, IAM/secret, payment, external-
// message, and other declared write classes are denied pending an explicit,
// scoped, single-use, expiring user approval (scripts/runtime/update-state.mjs
// --request-approval / --resolve-approval). Sensitive files (.env, keys,
// credential stores) are protected.
//
// Decision text references ONLY the policy class and its reason — never the
// matched command, path, or tool arguments (prompt-injection and secret-leak
// safety). The one exception is the approval's own audit trail (fingerprint +
// redacted target), which is never surfaced back to the model as free text.
//
// Fail mode: fail SAFE (ask) while a run is active; silent pass-through when
// no KRYLO run is active for this project.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readStdinJson, resolveActiveRun, emitPreToolDecision, allowSilently } from '../lib/hook-utils.mjs';
import { getDataRoot, runLockPath } from '../lib/paths.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { redactAndTruncate, deepRedact } from '../lib/redact.mjs';
import { fingerprintText } from '../lib/action-fingerprint.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { isMcpToolName, classifyMcpTool } from './mcp-classifier.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, '..', '..', 'policies', 'production-policy.json');

const DATA_ROOT_REASON =
  'The KRYLO runtime data directory (run state, approvals, pointers, wrapper config) is integrity-protected. ' +
  'It may only be modified through the KRYLO runtime scripts, never directly.';

/**
 * KRYLO's own control plane (state.json, current-run.json, wrapper-config.json)
 * must not be writable through direct tool calls, or a prompt-injected model
 * could self-approve gated actions or disable the gates entirely. Legitimate
 * mutations go through the runtime CLIs, which never embed the data-root path
 * in the command line.
 */
function touchesDataRoot(payload, cwd) {
  const dataRoot = getDataRoot();
  const variants = [
    dataRoot,
    dataRoot.split(path.sep).join('/'),
    '.claude/plugins/data/krylo',
    '.claude\\plugins\\data\\krylo',
    'current-run.json',
    'wrapper-config.json',
  ].map((v) => v.toLowerCase());

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const toolName = String(payload.tool_name ?? '');

  if (toolName === 'Bash') {
    const command = String(toolInput.command ?? '').toLowerCase();
    return variants.some((v) => command.includes(v));
  }

  const target = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof toolInput.notebook_path === 'string'
      ? toolInput.notebook_path
      : '';
  if (target === '') return false;
  const lower = target.toLowerCase();
  if (variants.some((v) => lower.includes(v))) return true;
  try {
    const resolved = path.resolve(cwd || process.cwd(), target).toLowerCase();
    const rootLower = path.resolve(dataRoot).toLowerCase();
    return resolved === rootLower || resolved.startsWith(rootLower + path.sep.toLowerCase());
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
 * Atomically find and spend the one usable approval for this class, scoped
 * to the exact project + run + (optional) environment. State is reloaded
 * fresh under an exclusive per-run lock so two concurrent PreToolUse calls
 * for the same class can never both consume the same single-use approval.
 */
function tryConsumeApproval(runId, className, { toolName, toolInput, projectRootHash }) {
  return withFileLock(runLockPath(runId), () => {
    const reloaded = loadState(runId);
    if (!reloaded.ok) return { consumed: false };
    const freshState = reloaded.value;
    const environment = process.env.KRYLO_SECURITY_PROFILE || null;
    const nowMs = Date.now();
    const fingerprint = computeFingerprint(toolName, toolInput);

    const approvals = Array.isArray(freshState.riskApprovals) ? freshState.riskApprovals : [];
    const approval = approvals.find((a) => isApprovalUsable(a, { className, projectRootHash, runId, environment, nowMs, fingerprint }));
    if (!approval) return { consumed: false };

    approval.status = 'consumed';
    approval.consumedAt = new Date().toISOString();
    // Preserve a pre-bound fingerprint/target (set by --request-approval
    // --target); an untargeted approval records what actually consumed it,
    // for audit only — it is never used to authorize a second action.
    approval.fingerprint = approval.fingerprint || fingerprint;
    approval.target = approval.target || computeTargetLabel(toolName, toolInput);
    const saved = saveState(freshState);
    return { consumed: saved.ok, approvalId: approval.id };
  });
}

function handleGatedMatch(state, match, action) {
  const result = tryConsumeApproval(state.runId, match.className, action);
  if (result.consumed) {
    recordEvent(state.runId, { event: 'risk-gate', category: match.className, status: 'approved-override' });
    emitPreToolDecision('allow', `Action class ${match.className} was approved by the user (${result.approvalId}) and is now spent.`);
  }
  recordEvent(state.runId, { event: 'risk-gate', category: match.className, status: 'denied' });
  emitPreToolDecision(
    'deny',
    `${match.reason} Record it with update-state.mjs --request-approval ${match.className} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
  );
}

async function main() {
  const input = await readStdinJson();
  const payload = input.ok ? input.value : {};

  const run = resolveActiveRun(payload);
  if (!run.active) allowSilently();

  const state = run.state;

  try {
    const policy = loadPolicy();
    const toolName = String(payload.tool_name ?? '');
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};

    if (touchesDataRoot(payload, typeof payload.cwd === 'string' ? payload.cwd : '')) {
      recordEvent(state.runId, { event: 'risk-gate', category: 'data-root-protection', status: 'denied' });
      emitPreToolDecision('deny', DATA_ROOT_REASON);
    }

    if (toolName === 'Bash') {
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (command === '') allowSilently();

      if (commandTouchesSensitivePath(policy, command)) {
        recordEvent(state.runId, { event: 'risk-gate', category: 'sensitive-path', status: 'denied' });
        emitPreToolDecision('deny', `${policy.sensitivePaths.reason} This command touches a protected secret path.`);
      }

      const match = firstMatchingClass(policy, command);
      if (match) {
        handleGatedMatch(state, match, { toolName, toolInput, projectRootHash: state.project.rootHash });
      }

      recordEvent(state.runId, { event: 'risk-gate', category: 'pass', status: 'allowed' });
      allowSilently();
    }

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const target = typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.notebook_path === 'string'
          ? toolInput.notebook_path
          : '';
      if (matchesSensitivePath(policy, target)) {
        recordEvent(state.runId, { event: 'risk-gate', category: 'sensitive-path', status: 'denied' });
        emitPreToolDecision('deny', `${policy.sensitivePaths.reason} This file target is a protected secret path.`);
      }
      recordEvent(state.runId, { event: 'risk-gate', category: 'pass', status: 'allowed' });
      allowSilently();
    }

    if (isMcpToolName(toolName)) {
      const match = classifyMcpTool(toolName);
      if (match) {
        handleGatedMatch(state, match, { toolName, toolInput, projectRootHash: state.project.rootHash });
      }
      recordEvent(state.runId, { event: 'risk-gate', category: 'mcp-pass', status: 'allowed' });
      allowSilently();
    }

    allowSilently();
  } catch {
    // Fail safe while a run is active: require the user to look at it.
    emitPreToolDecision('ask', 'KRYLO risk gate could not evaluate this action.');
  }
}

main().catch(() => {
  // Outer failure (before active-run resolution succeeded): pass through.
  allowSilently();
});
