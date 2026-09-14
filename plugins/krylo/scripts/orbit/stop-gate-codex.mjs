#!/usr/bin/env node
// KRYLO Codex deterministic Stop gate (Stop hook).
// docs/adr/0033-codex-lifecycle-enforcement.md.
//
// Structural mirror of scripts/orbit/stop-gate.mjs (the Claude adapter):
// identical decide-then-mutate sequence, identical lock scope, identical
// completion/budget/stagnation policy imported from the SAME host-neutral
// scripts/orbit/stop-policy.mjs -- zero Orbit/completion policy is
// reimplemented here, per docs/adr/0023-multi-host-product-and-shared-core.md's
// architectural rule. Only the Hook payload parsing and output shaping
// differ (this file's own scripts/host/codex/hook-transport.mjs imports).
//
// Fail mode: fail SAFE for completion claims, but never trap the user -- any
// internal error, malformed payload, or unresolvable identity allows the
// stop. This is deliberately the SAME direction the real Codex rust-v0.152.1
// Stop handler itself already fails toward on invalid/incomplete hook
// output (should_block: false) -- confirmed directly against that tag's own
// stop.rs unit tests, not assumed. Emitting nothing here therefore matches
// what the platform would do anyway if this script crashed outright.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeCodexHookPayload, emitCodexStopBlock, allowCodexSilently } from '../host/codex/hook-transport.mjs';
import { loadState, saveState, completionEval } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { assessStagnation } from './stagnation.mjs';
import { buildStopDelta, finalizeStopTerminal } from './stop-policy.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowCodexSilently();
  const normalized = normalizeCodexHookPayload(input.value);
  if (!normalized.ok) allowCodexSilently();
  const payload = normalized.payload;

  // Never fight the platform's own stop-loop guard. Confirmed present on
  // the current stable release's Stop input schema (stop_hook_active,
  // boolean, required) -- same field name and semantics as Claude's.
  if (payload.stop_hook_active) allowCodexSilently();

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowCodexSilently();

  const runId = run.state.runId;

  // Identical locking/re-read discipline to the Claude gate: the unlocked
  // resolveActiveRun() read above could be stale, so state is re-loaded
  // fresh once the lock is held, and every mutation happens inside it.
  let outcome = { kind: 'allow' };
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;

      // Covers all six terminal states uniformly -- a single shared field,
      // no per-state branching needed (VERIFIED_COMPLETE, SAFE_BLOCKED,
      // USER_DECISION_REQUIRED, RISK_APPROVAL_REQUIRED,
      // ITERATION_LIMIT_REACHED, CANCELLED_BY_USER).
      if (state.terminalState !== null) return;

      const evalResult = completionEval(state);
      if (evalResult.complete) return;

      if (state.orbit.cycle >= state.orbit.budget || state.orbit.stopBlocks >= state.orbit.budget) {
        finalizeStopTerminal(state, 'ITERATION_LIMIT_REACHED', 'ITERATION_LIMIT');
        return;
      }

      if (assessStagnation(state).recommendation === 'isolate-or-stop') {
        finalizeStopTerminal(state, 'SAFE_BLOCKED', 'BLOCKED');
        return;
      }

      state.orbit.stopBlocks += 1;
      state.orbit.cycle += 1;
      const saved = saveState(state);
      if (!saved.ok) return;
      recordEvent(runId, { event: 'stop-block', cycle: saved.value.orbit.cycle });
      outcome = { kind: 'block', delta: buildStopDelta(saved.value, evalResult) };
    });
  } catch {
    // Fail safe for completion claims, but never trap the user.
  }

  if (outcome.kind === 'block') emitCodexStopBlock(outcome.delta);
  allowCodexSilently();
}

main().catch(() => allowCodexSilently());
