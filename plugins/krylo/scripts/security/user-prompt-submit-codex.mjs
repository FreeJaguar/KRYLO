#!/usr/bin/env node
// KRYLO Codex UserPromptSubmit hook: host-authoritative run bootstrap.
//
// This is the ONLY place a KRYLO Codex run is created. It replaces the
// removed model-side session bootstrap (docs/adr/0029-codex-host-packaging-and-approval-boundary.md's
// third review-finding round): a model can never choose, invent, or supply
// the run's session identity. The authoritative identity is
// payload.session_id, provided directly by this Codex lifecycle hook --
// confirmed a required field of the official UserPromptSubmit input schema
// (codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json,
// tag rust-v0.120.0) -- never a model-supplied argument, and never
// `process.env.CODEX_THREAD_ID` alone (shell environment variables are
// visible to, and potentially influenced by, the command surface; that
// variable is diagnostic/consistency-only, never a root of trust here).
//
// Inert for every ordinary Codex prompt: only a prompt whose first
// non-whitespace token is EXACTLY `$krylo-run` (with a real token boundary,
// never a loose substring match) is treated as an explicit KRYLO
// invocation. This must stay fast and side-effect-free for the overwhelming
// majority of prompts that are not KRYLO invocations at all -- Codex has no
// Skill-scoped hook lifecycle, so this hook fires for every user prompt in
// every ordinary Codex session, not only ones that ever use $krylo-run.
//
// Reuses Shared Core directly (createInitialState/saveState/
// writeActiveRunPointer/readActiveRunPointer from scripts/lib/state.mjs,
// the exact same functions scripts/runtime/init-run.mjs itself calls) --
// no duplicated run-initialization logic. On success, returns a small,
// non-secret hookSpecificOutput.additionalContext confirming the run is
// active; this is coordination context for the model, never authorization.
//
// Idempotent: an already-active, non-terminal run bound to this EXACT
// session_id is never silently duplicated or overwritten by a second
// invocation in the same session -- the existing run is reused instead.
//
// Fails safe on every malformed/ambiguous/unpersistable input: no partial
// state is ever left with an active-run pointer referencing it, and an
// ordinary (non-KRYLO) prompt is never affected by a failed bootstrap
// attempt for a DIFFERENT session.

import crypto from 'node:crypto';
import path from 'node:path';

import { readStdinJson } from '../lib/hook-utils.mjs';
import {
  createInitialState,
  saveState,
  writeActiveRunPointer,
  readActiveRunPointer,
  loadState,
  computeProjectRootHash,
} from '../lib/state.mjs';
import { bootstrapCodexRuntimeEnvironment } from '../host/codex/context.mjs';
import { evaluateCodexRuntimeCompatibility } from '../host/codex/runtime-compat.mjs';

// Exactly `$krylo-run` as the first non-whitespace token, followed by
// whitespace or end-of-string -- never a substring match, so
// "explain $krylo-run", "`$krylo-run` is mentioned in docs", and
// "$krylo-runner foo" are all correctly NOT an invocation.
const INVOCATION_RE = /^\s*\$krylo-run(?=\s|$)/;

export function parseInvocation(prompt) {
  if (typeof prompt !== 'string') return null;
  const match = INVOCATION_RE.exec(prompt);
  if (!match) return null;
  return { task: prompt.slice(match[0].length).trim() };
}

function emitAdditionalContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }));
  process.exit(0);
}

function allowSilently() {
  process.exit(0);
}

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowSilently();
  const payload = input.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) allowSilently();

  const invocation = parseInvocation(payload.prompt);
  if (!invocation) allowSilently(); // not an explicit KRYLO invocation: inert, ordinary prompt unaffected

  // Every field below is `required` in the official UserPromptSubmit input
  // schema; a genuinely malformed/missing one means this payload cannot be
  // trusted to bootstrap a run safely -- fail safe by doing nothing, never
  // by guessing or falling back to a model-suppliable value.
  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() !== '' ? payload.session_id.trim() : null;
  const cwdRaw = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!sessionId || cwdRaw === '') allowSilently();

  let projectRoot;
  try {
    projectRoot = path.resolve(cwdRaw);
  } catch {
    allowSilently();
    return;
  }

  let identity;
  try {
    // explicitSessionId is passed explicitly (not left to fall back to
    // hookPayload alone) so the host-supplied session_id is unambiguously
    // what is used, matching the same precedence contract every other
    // Codex entrypoint already relies on.
    identity = bootstrapCodexRuntimeEnvironment({
      explicitSessionId: sessionId,
      hookPayload: payload,
      projectRoot,
    });
  } catch {
    allowSilently();
    return;
  }

  const projectRootHash = computeProjectRootHash(projectRoot);

  // Idempotency (required behavior C/D/I): reuse an already-active,
  // non-terminal run bound to this EXACT session and project rather than
  // silently creating a second one. Any lookup/parse failure here is
  // treated as "no existing run found" (fail safe toward attempting a
  // fresh, correctly-scoped bootstrap, never toward silently adopting the
  // wrong state). The emit itself happens OUTSIDE this try block: an
  // earlier version called emitAdditionalContext() (which writes to stdout
  // and calls process.exit) from inside the try -- a fresh independent
  // Reviewer found that a write failure there (e.g. a broken pipe) would be
  // swallowed by this function's own catch and fall through into creating a
  // second run for a session that already had one, silently contradicting
  // the "never silently duplicated" guarantee this comment documents.
  let existingRunId = null;
  try {
    const existingPointer = readActiveRunPointer({ projectRootHash, host: 'codex', hostSessionId: sessionId });
    if (existingPointer.ok && existingPointer.value?.runId) {
      const existingState = loadState(existingPointer.value.runId);
      if (
        existingState.ok
        && existingState.value.terminalState === null
        && existingState.value.host?.name === 'codex'
        && existingState.value.host?.sessionId === sessionId
        && existingState.value.project?.rootHash === projectRootHash
      ) {
        existingRunId = existingPointer.value.runId;
      }
    }
  } catch {
    // Fall through to a fresh bootstrap attempt below.
  }
  if (existingRunId) {
    emitAdditionalContext(
      `KRYLO Codex run ${existingRunId} is already active for this host session. `
      + 'Follow the krylo-run Skill workflow using this existing run; do not initialize another run.',
    );
    return;
  }

  const goalText = invocation.task !== ''
    ? invocation.task
    : '(no task text was supplied with $krylo-run -- ask the user what they want before doing anything else)';

  const runId = `run-${crypto.randomBytes(6).toString('hex')}`;
  // Lane/risk cannot be pre-classified by the model here (the run is
  // created before the model ever sees the prompt) -- a disclosed,
  // deliberate trade-off of host-authoritative bootstrap. `medium` risk
  // (Orbit budget 5) and the general-purpose `BUILD` lane are the same
  // conservative defaults `runtime/init-run.mjs` itself falls back to when
  // a caller omits `--risk`/`--lane`.
  const state = createInitialState({
    goalText,
    hostIdentity: identity,
    projectDir: projectRoot,
    lane: 'BUILD',
    risk: 'medium',
    kryloVersion: process.env.KRYLO_VERSION || 'unknown',
    runId,
  });

  // Codex Runtime Compatibility Gate (docs/adr/0034-codex-runtime-compatibility-gate.md):
  // admission control for a FULL AUTONOMOUS run, evaluated once per fresh
  // bootstrap attempt (never for the idempotent reuse above, and never for
  // an ordinary, non-$krylo-run prompt, which returns long before this
  // point). Overridable ONLY when KRYLO_CODEX_COMPAT_TEST_MODE=1 is ALSO
  // set -- a fresh independent Reviewer found the earlier, unconditional
  // version of cliPath/contractPath genuinely reachable in a production
  // invocation, meaning anything that could smuggle an env-var assignment
  // ahead of this hook process (e.g. a malicious project config injecting
  // KRYLO_CODEX_COMPAT_CONTRACT_PATH into the Codex-spawned hook
  // environment) could point the gate at an attacker-authored contract
  // claiming any version "supported", routing entirely around the real,
  // reviewed one -- exactly the write-protection risk-policy.test.mjs's
  // own regression case for that file exists to prevent, just reached a
  // different way. Requiring a SECOND, distinctly-named sentinel mirrors
  // cross-harness-run.mjs's own identical fix for the identical class of
  // finding (KRYLO_CROSS_HARNESS_TEST_MODE) -- disclosed honestly as
  // defense-in-depth, not a strong guarantee on its own: neither override
  // is ever read from `payload`/prompt content, so the model still has no
  // direct channel to influence the verdict; this hardens the separate,
  // narrower question of what a compromised/malicious hook ENVIRONMENT
  // could do. tests/hooks/user-prompt-submit-codex.test.mjs sets
  // KRYLO_CODEX_COMPAT_TEST_MODE=1 explicitly for every fixture-driven test.
  const compatTestModeEnabled = process.env.KRYLO_CODEX_COMPAT_TEST_MODE === '1';
  const cliPathOverride = compatTestModeEnabled ? process.env.KRYLO_CODEX_CLI_PATH : undefined;
  const contractPathOverride = compatTestModeEnabled ? process.env.KRYLO_CODEX_COMPAT_CONTRACT_PATH : undefined;
  const compatibility = evaluateCodexRuntimeCompatibility({
    cliPath: typeof cliPathOverride === 'string' && cliPathOverride.trim() !== '' ? cliPathOverride.trim() : 'codex',
    env: process.env,
    ...(typeof contractPathOverride === 'string' && contractPathOverride.trim() !== '' ? { contractPath: contractPathOverride.trim() } : {}),
  });

  if (!compatibility.trusted) {
    state.findings.push({
      id: 'finding-1',
      severity: 'high',
      status: 'open',
      summary: compatibility.reason.slice(0, 300),
      source: 'codex-runtime-compat',
    });
    state.terminalState = 'SAFE_BLOCKED';
    state.phase = 'BLOCKED';

    const blockedSaveResult = saveState(state);
    if (!blockedSaveResult.ok) allowSilently(); // not even the blocked audit record could be persisted

    emitAdditionalContext(
      `KRYLO Codex run ${runId} could not start autonomously: ${compatibility.reason} `
      + 'This run has been recorded as SAFE_BLOCKED for audit purposes only -- do not attempt the task autonomously; report this limitation to the user.',
    );
    return;
  }

  const saveResult = saveState(state);
  if (!saveResult.ok) allowSilently(); // no state persisted: never write a pointer to it

  try {
    writeActiveRunPointer({ runId, projectRootHash, host: 'codex', hostSessionId: sessionId });
  } catch {
    // State exists but no pointer was written -- the run is never resolved
    // as active by resolveActiveRun() (which requires a valid pointer), so
    // this is a harmless orphaned state file, not a dangling "active" run.
    allowSilently();
    return;
  }

  emitAdditionalContext(
    `KRYLO Codex run ${runId} is now active for this host session. Follow the krylo-run Skill workflow. Do not initialize another run.`,
  );
}

main().catch(() => {
  try { process.exit(0); } catch { /* already exiting */ }
});
