#!/usr/bin/env node
// KRYLO deterministic Stop gate (Stop hook).
//
// The runtime, not the model, decides whether a run may end. While a KRYLO
// run is active with unmet criteria and remaining budget, stopping is blocked
// with a compact Orbit delta. The gate is strictly bounded: every block
// consumes budget, and exhaustion or stagnation ends the run in an explicit
// terminal state instead of looping.
//
// Fail mode: fail SAFE for completion claims, but never trap the user — any
// internal error allows the stop.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, emitClaudeStopBlock, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState, completionEval } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { assessStagnation } from './stagnation.mjs';
import { buildStopDelta, finalizeStopTerminal } from './stop-policy.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowClaudeSilently();
  const normalized = normalizeClaudeHookPayload(input.value);
  if (!normalized.ok) allowClaudeSilently();
  const payload = normalized.payload;

  // Never fight the platform's own stop-loop guard.
  if (payload.stop_hook_active) allowClaudeSilently();

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const runId = run.state.runId;

  // The whole decide-then-mutate sequence runs under the run's exclusive
  // lock, re-reading state fresh once acquired (security-hardening
  // checkpoint, SECURITY BLOCKER 2): completion/budget/stagnation decisions
  // must see current data, and the resulting mutation (stopBlocks/cycle
  // increment, or a terminal-state finalize) can never race a concurrent
  // migration-persist or another mutation. Only the final Claude Hook output
  // call happens outside the lock.
  let outcome = { kind: 'allow' };
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;

      // The unlocked resolveActiveRun() read above could be stale: another
      // process may have finalized this run and cleared its pointer between
      // that read and acquiring this lock. Re-check under the lock so a
      // spurious stopBlocks/cycle increment is never applied to an already-
      // terminal run.
      if (state.terminalState !== null) return;

      // Completion gate satisfied: allow the stop. The model remains
      // responsible for setting VERIFIED_COMPLETE explicitly through
      // update-state.mjs.
      const evalResult = completionEval(state);
      if (evalResult.complete) return;

      // Budget exhaustion: deterministic terminal state, allow the stop.
      if (state.orbit.cycle >= state.orbit.budget || state.orbit.stopBlocks >= state.orbit.budget) {
        finalizeStopTerminal(state, 'ITERATION_LIMIT_REACHED', 'ITERATION_LIMIT');
        return;
      }

      // Stagnation: no useful action remains — stop safely.
      if (assessStagnation(state).recommendation === 'isolate-or-stop') {
        finalizeStopTerminal(state, 'SAFE_BLOCKED', 'BLOCKED');
        return;
      }

      // Otherwise force continuation with the Orbit delta. Every block
      // consumes budget, so this loop is strictly bounded.
      state.orbit.stopBlocks += 1;
      state.orbit.cycle += 1;
      const saved = saveState(state);
      if (!saved.ok) return;
      recordEvent(runId, { event: 'stop-block', cycle: saved.value.orbit.cycle });
      outcome = { kind: 'block', delta: buildStopDelta(saved.value, evalResult) };
    });
  } catch {
    // Fail safe for completion claims, but never trap the user: any
    // internal error (including lock contention) allows the stop.
  }

  if (outcome.kind === 'block') emitClaudeStopBlock(outcome.delta);
  allowClaudeSilently();
}

main().catch(() => allowClaudeSilently());
