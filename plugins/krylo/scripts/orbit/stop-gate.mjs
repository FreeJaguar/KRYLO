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

import { readStdinJson, resolveActiveRun, allowSilently } from '../lib/hook-utils.mjs';
import { saveState, clearActiveRunPointerForState, completionEval } from '../lib/state.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { assessStagnation } from './stagnation.mjs';

function buildDelta(state, evalResult) {
  const parts = [];

  const unmet = state.acceptanceCriteria.filter((c) => !['proven', 'not-applicable'].includes(c.status));
  if (unmet.length > 0) {
    parts.push(`Unmet acceptance criteria: ${unmet.map((c) => `${c.id} (${c.status}) ${c.description}`).join('; ')}.`);
  } else if (!evalResult.complete) {
    parts.push(`Completion gate not satisfied: ${evalResult.reasons.join('; ')}.`);
  }

  const openFindings = state.findings.filter(
    (f) => (f.severity === 'critical' || f.severity === 'high') && f.status === 'open',
  );
  if (openFindings.length > 0) {
    parts.push(`Open critical/high findings: ${openFindings.length}.`);
  }

  const repeated = state.orbit.fingerprints.filter((f) => f.count >= 2);
  if (repeated.length > 0) {
    parts.push(
      `Repeated failure fingerprints: ${repeated.map((f) => `${f.hash} (x${f.count}, ${f.category})`).join(', ')}. ` +
      'Change strategy - do not repeat the failed approach.',
    );
  }

  const remaining = Math.max(0, state.orbit.budget - state.orbit.cycle);
  parts.push(`Remaining Orbit budget: ${remaining} of ${state.orbit.budget}.`);
  parts.push(
    'Record evidence with update-state.mjs --add-evidence, mark criteria with --set-criterion AC-n=proven --evidence EV-n, ' +
    'or finish with an explicit terminal state (--terminal SAFE_BLOCKED | USER_DECISION_REQUIRED | RISK_APPROVAL_REQUIRED | CANCELLED_BY_USER).',
  );

  return parts.join(' ');
}

function finalize(state, terminalState, phase) {
  state.terminalState = terminalState;
  state.phase = phase;
  saveState(state);
  clearActiveRunPointerForState(state);
  recordEvent(state.runId, { event: 'terminal', terminalState, cycle: state.orbit.cycle });
}

async function main() {
  const input = await readStdinJson();
  const payload = input.ok ? input.value : {};

  // Never fight the platform's own stop-loop guard.
  if (payload.stop_hook_active) allowSilently();

  const run = resolveActiveRun(payload);
  if (!run.active) allowSilently();

  const state = run.state;

  // Completion gate satisfied: allow the stop. The model remains responsible
  // for setting VERIFIED_COMPLETE explicitly through update-state.mjs.
  const evalResult = completionEval(state);
  if (evalResult.complete) allowSilently();

  // Budget exhaustion: deterministic terminal state, allow the stop.
  if (state.orbit.cycle >= state.orbit.budget || state.orbit.stopBlocks >= state.orbit.budget) {
    finalize(state, 'ITERATION_LIMIT_REACHED', 'ITERATION_LIMIT');
    allowSilently();
  }

  // Stagnation: no useful action remains — stop safely.
  if (assessStagnation(state).recommendation === 'isolate-or-stop') {
    finalize(state, 'SAFE_BLOCKED', 'BLOCKED');
    allowSilently();
  }

  // Otherwise force continuation with the Orbit delta. Every block consumes
  // budget, so this loop is strictly bounded.
  state.orbit.stopBlocks += 1;
  state.orbit.cycle += 1;
  const saved = saveState(state);
  if (!saved.ok) allowSilently();
  recordEvent(state.runId, { event: 'stop-block', cycle: state.orbit.cycle });

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: buildDelta(saved.value, evalResult),
  }));
  process.exit(0);
}

main().catch(() => allowSilently());
