// Host adapter registry (design doc Shared Core boundary: "adapter
// registry" is explicitly a Shared Core responsibility, not a Claude-only or
// Codex-only concern). Runtime CLIs shared by every host (init-run.mjs,
// update-state.mjs, read-state.mjs, cleanup.mjs) call the functions here
// instead of hardcoding a specific host adapter import, so a Codex hook
// invoking the same CLI a Claude Skill invokes is routed to the correct
// adapter automatically. This module never reads a host-specific
// environment variable or Hook payload field itself (that stays exclusive
// to each host/<name>/context.mjs, per that module's own contract) -- it
// only inspects which NATIVE variable names are present, purely to decide
// which adapter to delegate to.
//
// Detection order, and why: current official Codex documentation confirms
// Codex plugin hooks receive both their own native plugin-root/plugin-data
// variables AND separate Claude-compatible alias variables, kept only for
// third-party hook compatibility -- so the presence of the ALIAS variables
// alone is NOT sufficient to prove this is a genuine Claude invocation. The
// native Codex variables, by contrast, are Codex-only: Claude Code never
// sets them. Their presence is therefore treated as conclusive proof of a
// Codex invocation, checked BEFORE falling back to Claude-signal detection.
// An explicit KRYLO_HOST override (tests, or a future host) always wins
// outright. Absent any signal at all, the default remains 'claude' --
// preserving every existing direct/manual invocation (a developer running a
// runtime CLI by hand with no host env vars set) exactly as it behaved
// before Codex support existed.
//
// CODEX_THREAD_ID is also checked, and this is a live-verification fix, not
// a design preference: PLUGIN_ROOT/PLUGIN_DATA are populated only inside the
// environment Codex builds for its OWN registered hook commands
// (hooks/codex-hooks.json's command/commandWindows templating) -- NEVER in
// the shell the model's own `exec` tool calls run in, which is a materially
// different execution context this module's original design did not
// distinguish. A real, hook-trust-enabled `$krylo-run` session was driven
// live end to end: `read-state.mjs`, invoked exactly as the krylo-run Skill
// instructs (via the real absolute script path, no env vars, no --session),
// silently resolved to the CLAUDE host and read back a COMPLETELY UNRELATED
// Claude-host run's state -- because neither PLUGIN_ROOT nor PLUGIN_DATA
// reaches that shell. The follow-on `update-state.mjs --terminal` call in
// that same session would have silently overwritten that unrelated run's
// terminal state had a concurrent file lock not happened to block it --
// cross-run state corruption, confirmed reachable, not merely theoretical.
// CODEX_THREAD_ID, by contrast, was directly confirmed present in that same
// model exec environment (it is the platform-injected shell-execution
// variable resolveCodexSessionId() already trusts as a session-identity
// fallback for the identical reason), so it closes exactly the gap
// PLUGIN_ROOT/PLUGIN_DATA cannot reach. Like the native variables above, it
// is Codex-specific and never set by Claude Code under ordinary use; the one
// acknowledged residual risk is a Claude session launched FROM WITHIN an
// active Codex terminal inheriting a stray value, a narrow, disclosed edge
// case no variable-presence check can fully rule out.

import {
  bootstrapClaudeRuntimeEnvironment,
  bootstrapClaudeStorageEnvironment,
  resolveClaudeSessionId,
  hasNativeClaudeSignal,
} from '../host/claude/context.mjs';
import {
  bootstrapCodexRuntimeEnvironment,
  bootstrapCodexStorageEnvironment,
  resolveCodexSessionId,
} from '../host/codex/context.mjs';

// A genuine signal that this session really IS the other host, read through
// hasNativeClaudeSignal() -- the one file (host/claude/context.mjs) this
// module's own governance guard (validate-runtime.mjs's hostIsolation
// check) allows to touch those variables. It outranks EVERY Codex-inferred
// signal below, and contradicting it explicitly is refused rather than
// silently honored.
//
// The reasoning, from two successive independent reviews. CODEX_THREAD_ID is
// Codex-exclusive under ORDINARY use, but nothing rules out a Claude session
// inheriting a stray value (a nested terminal opened inside an active Codex
// thread, a devcontainer or tmux session that forwards its environment).
// Claude's own hooks never call detectHost() at all -- they bootstrap
// directly through the Claude adapter -- but the shared runtime CLIs
// (read-state.mjs, update-state.mjs, init-run.mjs, cleanup.mjs) do. So a
// misrouted detection sends a genuine session's own CLI calls to the other
// adapter's data root, finds no active run there, and the risk and stop
// gates then silently stop enforcing: a governed session with dead
// enforcement, which is the exact failure this whole checkpoint exists to
// close.
//
// KRYLO_HOST gets the same treatment, and that is the later of the two
// findings. It is the highest-priority branch, and this checkpoint newly
// instructs the model to set it inline on every runtime CLI call -- which
// makes a model-controllable value the first thing a security-relevant
// routing decision consults. Untrusted content (issue text, PR comments,
// generated wikis, web content -- all explicitly untrusted per CLAUDE.md)
// carrying a prompt-injection payload could set it to the opposite host and
// reach the same dead-enforcement state on purpose. It cannot be dropped
// (the host adapters set it themselves after bootstrap, and tests and a
// future host rely on it), so instead a contradiction is now a loud,
// deterministic failure rather than a silent choice. Every legitimate use
// stays intact: an adapter's own bootstrap sets it consistently with that
// host's signals, the Codex-only test helper deletes the conflicting
// variable, and cross-harness workers inherit a strict allowlist (PATH,
// HOME, USERPROFILE, TEMP, TMP) that carries neither variable.
function refuseContradiction(requested) {
  throw new Error(
    `KRYLO_HOST=${requested} contradicts a genuine ${requested === 'codex' ? 'Claude' : 'Codex'}-native session signal in the same environment. `
    + 'Refusing to route this call rather than silently operating on the wrong host\'s run state. '
    + 'If this is a deliberate cross-host diagnostic, run it in an environment without the conflicting host signal.',
  );
}

export function detectHost(env = process.env) {
  const claudeNative = hasNativeClaudeSignal(env);

  if (env.KRYLO_HOST === 'codex' || env.KRYLO_HOST === 'claude') {
    if (env.KRYLO_HOST === 'codex' && claudeNative) refuseContradiction('codex');
    return env.KRYLO_HOST;
  }

  // Every inferred Codex signal yields to a genuine Claude-native one. An
  // earlier version applied that rule to CODEX_THREAD_ID alone, leaving the
  // two stronger variables inconsistent with it -- a review pointed out
  // that this module's own new comment describes PLUGIN_ROOT as "a
  // generic-sounding variable name unrelated tooling might set", which is
  // precisely the case for guarding it too.
  const codexInferred = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CODEX_THREAD_ID']
    .some((name) => typeof env[name] === 'string' && env[name].trim() !== '');
  if (codexInferred) return claudeNative ? 'claude' : 'codex';

  return 'claude';
}

/** Bootstrap the correct host's runtime environment and return its HostIdentity. */
export function bootstrapRuntimeEnvironment(options = {}) {
  const env = options.env ?? process.env;
  return detectHost(env) === 'codex'
    ? bootstrapCodexRuntimeEnvironment(options)
    : bootstrapClaudeRuntimeEnvironment(options);
}

/** Bootstrap only KRYLO_HOST/KRYLO_DATA_ROOT for a sessionless storage utility. */
export function bootstrapStorageEnvironment(options = {}) {
  const env = options.env ?? process.env;
  return detectHost(env) === 'codex'
    ? bootstrapCodexStorageEnvironment(options)
    : bootstrapClaudeStorageEnvironment(options);
}

/** Resolve a host session id using the correct host's own precedence rules. */
export function resolveSessionId(options = {}) {
  const env = options.env ?? process.env;
  return detectHost(env) === 'codex'
    ? resolveCodexSessionId(options)
    : resolveClaudeSessionId(options);
}
