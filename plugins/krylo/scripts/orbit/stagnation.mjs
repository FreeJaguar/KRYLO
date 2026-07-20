#!/usr/bin/env node
// KRYLO stagnation assessment (docs/03-orbit-loop.md).
//
// Library: assessStagnation(state). CLI: prints the assessment for the
// current run as JSON.

import { fileURLToPath } from 'node:url';

/**
 * Assess Orbit progress health.
 *  - change-strategy: a failure fingerprint repeated, or a strategy change is
 *    already required.
 *  - isolate-or-stop: three or more cycles without measurable progress.
 */
export function assessStagnation(state) {
  const orbit = state.orbit ?? {};
  const stagnationData = orbit.stagnation ?? { cyclesWithoutProgress: 0, lastProgressCycle: 0 };
  const fingerprints = Array.isArray(orbit.fingerprints) ? orbit.fingerprints : [];

  const repeatedFingerprints = fingerprints.filter((f) => f.count >= 2).map((f) => f.hash);
  const requiredStrategyChange = orbit.requiredStrategyChange === true || repeatedFingerprints.length > 0;
  const cyclesWithoutProgress = stagnationData.cyclesWithoutProgress ?? 0;
  const stagnant = cyclesWithoutProgress >= 3;

  let recommendation = 'continue';
  if (requiredStrategyChange) recommendation = 'change-strategy';
  if (stagnant) recommendation = 'isolate-or-stop';

  return {
    stagnant,
    cyclesWithoutProgress,
    repeatedFingerprints,
    requiredStrategyChange,
    recommendation,
  };
}

async function cli() {
  const { readActiveRunPointerForCwd, loadState } = await import('../lib/state.mjs');
  const pointer = readActiveRunPointerForCwd();
  if (!pointer.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no-current-run' }));
    process.exit(1);
  }
  const loaded = loadState(pointer.value.runId);
  if (!loaded.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: loaded.error }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...assessStagnation(loaded.value) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch(() => process.exit(1));
}
