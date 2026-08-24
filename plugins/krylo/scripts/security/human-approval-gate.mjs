#!/usr/bin/env node
// KRYLO human-approval gate (UserPromptSubmit).
//
// SECURITY BLOCKER 1 (security-hardening checkpoint, docs/adr/
// 0024-host-controlled-human-approval-boundary.md): the model must never be
// able to turn its own pending risk-approval request into an approved human
// authorization. runtime/update-state.mjs's model-accessible CLI path
// (`--resolve-approval <id>=approved`) is deliberately refused for exactly
// this reason -- this hook is the ONLY path that can grant one.
//
// UserPromptSubmit fires "before Claude processes" a submitted prompt: it
// receives the raw prompt text on stdin before the model ever sees or acts
// on it, so the model cannot itself fabricate, replay, or retroactively
// edit this event's content. A payload carrying agent_id/agent_type (a
// subagent's own task context) is explicitly ignored, so a model-spawned
// subagent's task description cannot be used to synthesize a confirmation
// either -- only a genuine top-level prompt submission is honored.
//
// This hook never blocks, delays, or alters the prompt itself, and never
// prints anything Claude could see: it always exits 0 silently, whether or
// not a confirmation phrase matched, so it can never interfere with
// ordinary chat during a KRYLO run.
//
// Residual scope, stated plainly: this proves the confirmation phrase was
// present in the raw text of a genuine top-level prompt submission, which
// the model cannot originate on its own within its own turn. It does not
// cryptographically prove that a human (rather than some other automated
// caller driving the Claude Code session) is on the other end of that
// prompt -- no such proof is available in current official Claude Code
// documentation. That trust boundary is inherent to Claude Code itself, not
// specific to this mechanism.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState, applyApprovalResolution } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

// Matches e.g. "KRYLO-APPROVE ra-3" or "KRYLO-DENY ra-12", case-insensitive,
// anywhere in the message. A human confirming a pending approval types this
// exact phrase (KRYLO's Stop-gate / RISK_APPROVAL_REQUIRED report tells them
// the exact approval id to reference).
const CONFIRMATION_RE = /\bKRYLO-(APPROVE|DENY)\s+(ra-\d+)\b/gi;

function resolveOneApproval(runId, id, status) {
  try {
    withFileLock(runLockPath(runId), () => {
      const loaded = loadState(runId);
      if (!loaded.ok) return;
      const result = applyApprovalResolution(loaded.value, id, status);
      if (!result.ok) return;
      const saved = saveState(loaded.value);
      if (!saved.ok) return;
      recordEvent(runId, { event: 'human-approval-gate', category: result.approval.actionClass, status });
    });
  } catch {
    // Lock contention or any other failure here must never crash the hook
    // or interfere with the user's own prompt; the model observes the
    // approval is still pending on its next check and can ask the human to
    // retype the confirmation.
  }
}

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowClaudeSilently();
  const payload = input.value;

  // Only a genuine top-level prompt submission may grant an approval: a
  // subagent's own task context (agent_id/agent_type present) is ignored
  // entirely, before the prompt text is even inspected.
  if (payload && (payload.agent_id || payload.agent_type)) allowClaudeSilently();

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : '';
  const matches = prompt.trim() === '' ? [] : [...prompt.matchAll(CONFIRMATION_RE)];
  if (matches.length === 0) allowClaudeSilently();

  const normalized = normalizeClaudeHookPayload(payload);
  if (!normalized.ok) allowClaudeSilently();

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const runId = run.state.runId;
  for (const match of matches) {
    const [, verb, id] = match;
    // Approval ids are always minted lowercase ("ra-<n>"); the regex's `i`
    // flag matches case-insensitively but preserves the matched text's own
    // case, so a human typing "RA-1" must still resolve to the real "ra-1".
    resolveOneApproval(runId, id.toLowerCase(), verb.toUpperCase() === 'APPROVE' ? 'approved' : 'denied');
  }

  allowClaudeSilently();
}

main().catch(() => {
  // Never let an unexpected failure here surface to the user or the model:
  // this hook is a silent side channel, not a gate on the prompt itself.
  allowClaudeSilently();
});
