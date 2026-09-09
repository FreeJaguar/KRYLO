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
//
// A RECOGNIZED $krylo-run invocation that fails AFTER a real session_id and
// project root are known (host identity bootstrap, state persistence, or
// pointer write all failing) does NOT go silent: it writes a short-lived
// bootstrap-failure marker (scripts/lib/state.mjs's writeBootstrapFailureMarker)
// that risk-gate-codex.mjs's PreToolUse hook checks and denies against --
// otherwise this session would be indistinguishable, at PreToolUse time,
// from an ordinary session that never invoked KRYLO at all, and every
// action would be silently allowed while the user believed KRYLO was
// governing it. The marker is the actual (deterministic, PreToolUse-level)
// fail-closed boundary; the additionalContext text emitted alongside it is
// coordination context for the model only, same as every other emit in this
// file, never itself the enforcement mechanism.

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
  writeBootstrapFailureMarker,
  clearBootstrapFailureMarker,
} from '../lib/state.mjs';
import { bootstrapCodexRuntimeEnvironment, bootstrapCodexStorageEnvironment } from '../host/codex/context.mjs';

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

// Called ONLY after a prompt has already been recognized as an explicit
// $krylo-run invocation (parseInvocation returned non-null) AND we have a
// real projectRootHash + sessionId to scope a marker to. UserPromptSubmit
// has no verified deny/block output shape for the installed codex-cli
// 0.120.0 build (unlike PreToolUse's permissionDecision:"deny", which IS
// verified against this exact binary elsewhere in this codebase) -- so this
// does not itself block the prompt. Instead it (a) tells the model plainly
// that KRYLO did not initialize and this session is NOT governed, so a
// well-behaved model does not proceed as if it were, and (b) writes a
// bootstrap-failure marker that risk-gate-codex.mjs's PreToolUse hook
// checks and denies against -- the actual, deterministic fail-closed
// boundary, consistent with this codebase's established rule that
// UserPromptSubmit/additionalContext is coordination context for the
// model, never the enforcement mechanism itself.
function denyBootstrapFailure({ projectRootHash, sessionId, reason }) {
  // When THIS call is reached because bootstrapCodexRuntimeEnvironment()
  // itself just threw, KRYLO_DATA_ROOT was never set by that failed call --
  // an independent review found the marker would then be written under the
  // wrong (unconfigured-fallback) data root, one risk-gate-codex.mjs's own
  // successful bootstrap would never read back. bootstrapCodexStorageEnvironment()
  // is the simpler, non-throwing half of that same bootstrap (env/PLUGIN_DATA
  // resolution only, no session identity required) -- safe and idempotent to
  // call again here even when the fuller bootstrap already succeeded.
  bootstrapCodexStorageEnvironment();
  writeBootstrapFailureMarker({ projectRootHash, host: 'codex', hostSessionId: sessionId, reason });
  emitAdditionalContext(
    `KRYLO FAILED TO INITIALIZE for this session (${reason}). This session is NOT under KRYLO governance: `
    + 'do not proceed with the requested task as an autonomous KRYLO run. Report this failure to the user and stop. '
    + 'KRYLO will deny risk-gated actions in this session until this is resolved and $krylo-run is invoked again successfully.',
  );
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

  // Computed before the identity-bootstrap attempt below (a pure hash of
  // projectRoot, no dependency on `identity`) so a bootstrap failure can
  // still be recorded against the correct, real project+session scope.
  const projectRootHash = computeProjectRootHash(projectRoot);

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
    denyBootstrapFailure({ projectRootHash, sessionId, reason: 'host identity bootstrap failed' });
    return;
  }

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
    // Defensive cleanup: a marker from an EARLIER failed invocation in this
    // same session must not keep denying actions now that a real active run
    // was found for it.
    clearBootstrapFailureMarker({ projectRootHash, host: 'codex', hostSessionId: sessionId });
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

  // saveState() can both return {ok:false} (schema validation, or a failed
  // pre-migration backup write) AND throw (its own final writeJsonAtomic
  // call is unguarded, so a genuine I/O failure -- an unwritable/full/
  // broken data root, the single most realistic real-world failure mode
  // here -- propagates as an exception, not a clean return value). An
  // independent review found the `!saveResult.ok` check alone therefore
  // missed exactly the failure case it most needed to catch: a throw here
  // used to escape to the top-level main().catch() below and go fully
  // silent, even though a real invocation had already been recognized.
  let saveResult;
  try {
    saveResult = saveState(state);
  } catch {
    denyBootstrapFailure({ projectRootHash, sessionId, reason: 'run state could not be persisted' });
    return;
  }
  if (!saveResult.ok) {
    // No state persisted: never write a pointer to it. But the model was
    // just told (by the prompt it typed) that a KRYLO run should now be
    // active -- it must not be left believing that silently.
    denyBootstrapFailure({ projectRootHash, sessionId, reason: 'run state could not be persisted' });
    return;
  }

  try {
    writeActiveRunPointer({ runId, projectRootHash, host: 'codex', hostSessionId: sessionId });
  } catch {
    // State exists but no pointer was written -- the run is never resolved
    // as active by resolveActiveRun() (which requires a valid pointer), so
    // this is a harmless orphaned state file, not a dangling "active" run.
    // Still not silent, for the same reason as the saveState failure above.
    denyBootstrapFailure({ projectRootHash, sessionId, reason: 'run pointer could not be written' });
    return;
  }

  // A fresh, successful bootstrap supersedes any marker left by an earlier
  // failed invocation in this same session.
  clearBootstrapFailureMarker({ projectRootHash, host: 'codex', hostSessionId: sessionId });

  emitAdditionalContext(
    `KRYLO Codex run ${runId} is now active for this host session. Follow the krylo-run Skill workflow. Do not initialize another run.`,
  );
}

main().catch(() => {
  try { process.exit(0); } catch { /* already exiting */ }
});
