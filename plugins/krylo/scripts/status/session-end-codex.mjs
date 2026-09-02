#!/usr/bin/env node
// KRYLO Codex SessionEnd hook. docs/adr/0033-codex-lifecycle-enforcement.md.
//
// SessionEnd has NO output schema on the current stable Codex release
// (confirmed: no session-end.command.output.schema.json exists at all) and
// a confirmed ~1-3 second platform teardown budget -- this handler can
// never influence control flow and must stay fast: at most one locked
// state read, and only when that run is active and NON-terminal, one
// telemetry write. Never a bulk operation, never
// scripts/runtime/cleanup.mjs (wrong scope entirely -- that utility is
// sessionless and sweeps every run in the data root by retention age, not
// "the exact bound run" this hook is scoped to).
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
import { loadState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
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

  const runId = run.state.runId;

  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;
      // Already terminal: the run ended correctly through its own path
      // (Stop gate finalize, or the model's own --terminal call). Nothing
      // to record.
      if (state.terminalState !== null) return;
      recordEvent(runId, { event: 'session-end', cycle: state.orbit.cycle });
    });
  } catch {
    // Best-effort, never a security boundary -- fail silently.
  }

  allowCodexSilently();
}

main().catch(() => allowCodexSilently());
