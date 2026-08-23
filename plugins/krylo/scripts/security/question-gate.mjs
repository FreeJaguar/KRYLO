#!/usr/bin/env node
// KRYLO question gate (PreToolUse, matcher: AskUserQuestion).
//
// Routine questions are blocked while a KRYLO run is active. One exceptional
// question is allowed when the workflow has explicitly granted a token for an
// approved category via: update-state.mjs --grant-question <category>.
//
// Fail mode: fail OPEN (allow) — asking a human is always safe.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, emitClaudePreToolDecision, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { saveState } from '../lib/state.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

const GRANT_HINT =
  'KRYLO question policy blocks routine questions. Prefer a safe, conventional, reversible default and record the assumption. ' +
  'Only for these categories, grant a one-use token first with update-state.mjs --grant-question <category>: ' +
  'missing-credential, destructive-production-action, material-business-decision, legal-or-compliance, privacy, financial, high-impact-security, no-safe-default.';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowClaudeSilently();
  const normalized = normalizeClaudeHookPayload(input.value);
  if (!normalized.ok) allowClaudeSilently();
  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const state = run.state;
  const grants = Array.isArray(state.questionGate.grants) ? state.questionGate.grants : [];
  const available = grants.find((g) => g.status === 'available');

  if (available) {
    // `used` was already counted at grant time by update-state.mjs.
    available.status = 'consumed';
    available.consumedAt = new Date().toISOString();
    const saved = saveState(state);
    recordEvent(state.runId, { event: 'question-gate', category: available.category, status: 'allowed' });
    if (!saved.ok) {
      // State could not be persisted; still allow — the question is safe.
      emitClaudePreToolDecision('allow', `KRYLO exceptional question token consumed (${available.category}); state persistence failed.`);
    }
    emitClaudePreToolDecision('allow', `KRYLO exceptional question token consumed (${available.category}).`);
  }

  recordEvent(state.runId, { event: 'question-gate', status: 'denied' });
  emitClaudePreToolDecision('deny', GRANT_HINT);
}

main().catch(() => {
  // Fail open: never trap the session because the gate itself failed.
  allowClaudeSilently();
});
