// Host-neutral Stop-hook decision helpers, shared verbatim by
// scripts/orbit/stop-gate.mjs (Claude) and scripts/orbit/stop-gate-codex.mjs
// (Codex, docs/adr/0033-codex-lifecycle-enforcement.md). Extracted from the
// original Claude-only stop-gate.mjs so the Codex adapter reuses this exact
// logic rather than reimplementing it, per docs/adr/0023-multi-host-product-and-shared-core.md's
// architectural rule (no independent copy of completion/Orbit/approval
// policy in a host adapter). No host-specific import here at all -- every
// function below takes only already-loaded state and returns plain data or
// mutates state via the same host-neutral scripts/lib/state.mjs functions
// every other caller uses.

import { saveState, clearActiveRunPointerForState } from '../lib/state.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

export function buildStopDelta(state, evalResult) {
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

/**
 * Persist a terminal state. Only clears the active-run pointer and records
 * the "terminal" telemetry event if the save actually succeeded -- a failed
 * save (e.g. a pre-migration backup write failure, scripts/lib/state.mjs's
 * saveState()) must never be followed by clearing the pointer or reporting
 * a terminal event for a state.json that still says the run is active.
 * Doing so would leave the run with no persisted terminal state while
 * resolveActiveRun() (and therefore every other gate) now treats it as
 * gone, silently disabling KRYLO enforcement for the rest of the session.
 */
export function finalizeStopTerminal(state, terminalState, phase) {
  state.terminalState = terminalState;
  state.phase = phase;
  const saved = saveState(state);
  if (!saved.ok) return;
  clearActiveRunPointerForState(saved.value);
  recordEvent(saved.value.runId, { event: 'terminal', terminalState, cycle: saved.value.orbit.cycle });
}
