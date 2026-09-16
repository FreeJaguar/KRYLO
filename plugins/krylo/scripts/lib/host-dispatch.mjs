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
} from '../host/claude/context.mjs';
import {
  bootstrapCodexRuntimeEnvironment,
  bootstrapCodexStorageEnvironment,
  resolveCodexSessionId,
} from '../host/codex/context.mjs';

export function detectHost(env = process.env) {
  if (env.KRYLO_HOST === 'codex' || env.KRYLO_HOST === 'claude') return env.KRYLO_HOST;
  if (typeof env.PLUGIN_ROOT === 'string' && env.PLUGIN_ROOT.trim() !== '') return 'codex';
  if (typeof env.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim() !== '') return 'codex';
  if (typeof env.CODEX_THREAD_ID === 'string' && env.CODEX_THREAD_ID.trim() !== '') return 'codex';
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
