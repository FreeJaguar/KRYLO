#!/usr/bin/env node
// KRYLO Codex SessionEnd hook. docs/adr/0033-codex-lifecycle-enforcement.md.
//
// SessionEnd has NO output schema on the current stable Codex release
// (confirmed: no session-end.command.output.schema.json exists at all) and
// a confirmed ~1-3 second platform teardown budget -- this handler can
// never influence control flow and must stay fast: one already-loaded
// state read (via resolveActiveRun(), which only ever returns active:true
// for a genuinely non-terminal run -- see its own terminalState check in
// scripts/lib/hook-utils.mjs), and, only then, one telemetry write. Never
// a bulk operation, never scripts/runtime/cleanup.mjs (wrong scope
// entirely -- that utility is sessionless and sweeps every run in the data
// root by retention age, not "the exact bound run" this hook is scoped to).
//
// Deliberately takes NO lock. This performs no state mutation at all
// (recordEvent() is an independent, already-atomic append, safe for
// concurrent unlocked writes exactly like every other unlocked telemetry
// call in this codebase) -- a fresh independent Reviewer and Security
// Reviewer both found and reproduced that an earlier version's
// withFileLock() wrapper here was actively harmful: SessionEnd can be
// killed by the platform's own teardown deadline WHILE HOLDING that lock
// (the lock's up-to-6-second retry budget already exceeds the confirmed
// ~1-3 second SessionEnd timeout on its own), and scripts/lib/lock.mjs has
// no staleness recovery -- so an orphaned lock file would then make every
// LATER locked operation on that same run (Stop, update-state.mjs) wait
// the full retry budget and fail with lock-timeout, permanently degrading
// a run that should have kept working. A microsecond-scale race against a
// concurrent terminal-state transition is an accepted, harmless residual
// for a purely informational, best-effort telemetry marker -- never a
// security boundary.
//
// Never mutates terminalState, never deletes evidence/findings/criteria:
// a session ending is not the same as the run being finished, and
// fabricating a terminal state the model never actually reached would
// destroy the audit trail's honesty. This is also never a guaranteed
// crash-recovery mechanism -- SessionEnd runs during GRACEFUL teardown
// only; an abrupt/forced termination may simply never fire it, and no
// KRYLO correctness property depends on it firing.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeCodexHookPayload, allowCodexSilently } from '../host/codex/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowCodexSilently();
  const normalized = normalizeCodexHookPayload(input.value);
  if (!normalized.ok) allowCodexSilently();

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowCodexSilently();

  try {
    recordEvent(run.state.runId, { event: 'session-end', cycle: run.state.orbit.cycle });
  } catch {
    // Best-effort, never a security boundary -- fail silently.
  }

  allowCodexSilently();
}

main().catch(() => allowCodexSilently());
