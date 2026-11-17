#!/usr/bin/env node
// KRYLO question gate (PreToolUse, matcher: AskUserQuestion).
//
// Routine questions are blocked while a KRYLO run is active. One exceptional
// question is allowed when the workflow has explicitly granted a token for an
// approved category via: update-state.mjs --grant-question <category>.
//
// Fail mode: once this script is running, every internal failure fails OPEN
// (allow) — asking a human is always safe. A failure to START (Node or the
// plugin missing, the script crashing on import) is different: the run
// skill declares `onFailure: "block"` on this hook, so Claude Code blocks
// the AskUserQuestion call instead (docs/adr/0042-claude-host-reverified-on-2-1-318.md,
// a deliberate choice for consistency with the risk gate). The model can
// still ask in plain text; it only loses the structured question tool.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, emitClaudePreToolDecision, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
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

  const runId = run.state.runId;

  // Consume under the run's exclusive lock, re-reading state fresh once
  // acquired (security-hardening checkpoint, SECURITY BLOCKER 2): the same
  // synchronization domain approval consumption uses, so two concurrent
  // AskUserQuestion calls can never both consume the same single-use token,
  // and this can never race a concurrent migration-persist or another
  // mutation and silently lose it.
  let consumedCategory = null;
  let lockFailed = false;
  // The run resolved a moment ago, but its state could not be read under
  // the lock -- either the reload failed or saveState() refused because the
  // file on disk could not be read (ADR-0045). The policy was then never
  // evaluated, so this is not a denial: it takes the same fail-open path as
  // a lock failure below (docs/adr/0046-unreadable-state-followups-and-lock-deadline.md).
  let stateUnreadable = false;
  // A throw from inside the held lock is the save itself failing (a rename
  // that outlasted its ADR-0045 retry budget), not lock contention. It takes
  // the same fail-open path, labelled as what it is, the way the telemetry
  // hooks record save-failed (ADR-0046).
  let lockHeld = false;
  let saveThrew = false;
  try {
    withFileLock(runLockPath(runId), () => {
      lockHeld = true;
      const reloaded = loadState(runId);
      if (!reloaded.ok) {
        stateUnreadable = true;
        return;
      }
      const state = reloaded.value;
      const grants = Array.isArray(state.questionGate.grants) ? state.questionGate.grants : [];
      const available = grants.find((g) => g.status === 'available');
      if (!available) return;
      // `used` was already counted at grant time by update-state.mjs.
      available.status = 'consumed';
      available.consumedAt = new Date().toISOString();
      const saved = saveState(state);
      // Only report the token as consumed if it was actually persisted --
      // otherwise the token remains available on disk and must not be
      // treated (or logged) as spent.
      if (saved.ok) consumedCategory = available.category;
      else if (saved.error === 'state-unreadable') stateUnreadable = true;
    });
  } catch {
    // Lock contention: this hook's own documented fail mode is "fail OPEN
    // (allow) -- asking a human is always safe". Falling through to the
    // normal deny-with-regrant-hint path below would instead tell the model
    // to burn a NEW question-budget grant purely because of transient lock
    // contention, silently exhausting a scarce, human-reviewed budget for a
    // reason that has nothing to do with policy. Fail open explicitly here
    // instead, with its own distinct reason.
    if (lockHeld) saveThrew = true;
    else lockFailed = true;
  }

  if (consumedCategory) {
    recordEvent(runId, { event: 'question-gate', category: consumedCategory, status: 'allowed' });
    emitClaudePreToolDecision('allow', `KRYLO exceptional question token consumed (${consumedCategory}).`);
  }

  if (lockFailed) {
    recordEvent(runId, { event: 'question-gate', status: 'allowed-lock-contention' });
    emitClaudePreToolDecision('allow', 'KRYLO question gate could not evaluate this request due to transient contention; allowed per its fail-open policy. Do not grant a new token for this.');
  }

  if (stateUnreadable) {
    // Same reasoning as the lock-failure case: denying here would tell the
    // model to spend a new human-reviewed grant for a reason that has
    // nothing to do with policy. Any available grant stays unspent on disk.
    recordEvent(runId, { event: 'question-gate', status: 'allowed-state-unreadable' });
    emitClaudePreToolDecision('allow', 'KRYLO question gate could not read the run state to evaluate this request; allowed per its fail-open policy. Do not grant a new token for this.');
  }

  if (saveThrew) {
    recordEvent(runId, { event: 'question-gate', status: 'allowed-save-failed' });
    emitClaudePreToolDecision('allow', 'KRYLO question gate could not save the run state while evaluating this request; allowed per its fail-open policy. Do not grant a new token for this.');
  }

  recordEvent(runId, { event: 'question-gate', status: 'denied' });
  emitClaudePreToolDecision('deny', GRANT_HINT);
}

main().catch(() => {
  // Fail open: never trap the session because the gate itself failed.
  allowClaudeSilently();
});
