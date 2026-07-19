#!/usr/bin/env node
// KRYLO risk gate (PreToolUse, matcher: Bash|Write|Edit|NotebookEdit).
//
// Classifies commands and file targets against policies/production-policy.json.
// Production, destructive, publish, release, push, merge, IAM/secret, payment,
// and external-message actions are denied pending explicit user approval.
// Sensitive files (.env, keys, credential stores) are protected.
//
// Decision text references ONLY the policy class and its reason — never the
// matched command or path content (prompt-injection and secret-leak safety).
//
// Fail mode: fail SAFE (ask) while a run is active; silent pass-through when
// no KRYLO run is active for this project.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStdinJson, resolveActiveRun, emitPreToolDecision, allowSilently } from '../lib/hook-utils.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, '..', '..', 'policies', 'production-policy.json');

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

function hasApprovedOverride(state, className) {
  const approvals = Array.isArray(state.riskApprovals) ? state.riskApprovals : [];
  return approvals.find((a) => a.actionClass === className && a.status === 'approved') || null;
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

    if (toolName === 'Bash') {
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (command === '') allowSilently();

      if (commandTouchesSensitivePath(policy, command)) {
        recordEvent(state.runId, { event: 'risk-gate', category: 'sensitive-path', status: 'denied' });
        emitPreToolDecision('deny', `${policy.sensitivePaths.reason} This command touches a protected secret path.`);
      }

      const match = firstMatchingClass(policy, command);
      if (match) {
        const approved = hasApprovedOverride(state, match.className);
        if (approved) {
          recordEvent(state.runId, { event: 'risk-gate', category: match.className, status: 'approved-override' });
          emitPreToolDecision('allow', `Action class ${match.className} was approved by the user (${approved.id}).`);
        }
        recordEvent(state.runId, { event: 'risk-gate', category: match.className, status: 'denied' });
        emitPreToolDecision(
          'deny',
          `${match.reason} Record it with update-state.mjs --request-approval ${match.className} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`,
        );
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
