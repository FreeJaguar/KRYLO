// Unit tests for host-dispatch.mjs's detectHost(): the single routing
// decision every runtime CLI call (read-state.mjs, update-state.mjs,
// init-run.mjs, cleanup.mjs) makes to pick a host adapter. Until this file,
// nothing tested it directly -- indirect coverage always went through the
// hook-fixture helpers' Codex-only env variant, which forces KRYLO_HOST=codex
// explicitly and so never exercised the plain inference path a real Codex
// model-issued shell command actually runs under.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectHost } from '../../scripts/lib/host-dispatch.mjs';

test('detectHost: an explicit KRYLO_HOST override always wins, over any other signal', () => {
  assert.equal(detectHost({ KRYLO_HOST: 'codex' }), 'codex');
  assert.equal(detectHost({ KRYLO_HOST: 'claude' }), 'claude');
  assert.equal(detectHost({ KRYLO_HOST: 'claude', PLUGIN_ROOT: '/x' }), 'claude', 'override beats a Codex-native signal');
  assert.equal(detectHost({ KRYLO_HOST: 'garbage', PLUGIN_ROOT: '/x' }), 'codex', 'an unrecognized override value is not honored');
});

test('detectHost: PLUGIN_ROOT and PLUGIN_DATA are each sufficient Codex signals', () => {
  assert.equal(detectHost({ PLUGIN_ROOT: '/some/path' }), 'codex');
  assert.equal(detectHost({ PLUGIN_DATA: '/some/path' }), 'codex');
  assert.equal(detectHost({ PLUGIN_ROOT: '   ' }), 'claude', 'whitespace-only is not a real value');
  assert.equal(detectHost({ PLUGIN_DATA: '' }), 'claude', 'empty string is not a real value');
});

// REGRESSION (live verification). A real, hook-trust-enabled $krylo-run
// session was driven end to end against the installed Codex binary.
// UserPromptSubmit correctly bootstrapped a run in the Codex-native data
// root (PLUGIN_DATA was genuinely present for that HOOK subprocess). But the
// model's own subsequent read-state.mjs call -- issued exactly as the
// krylo-run Skill instructs, via the real absolute script path, no env vars
// set -- ran in a shell with NEITHER PLUGIN_ROOT NOR PLUGIN_DATA (both are
// scoped to Codex's own hook-command environment, never the model's `exec`
// environment) and silently fell through to 'claude', reading back a
// completely unrelated Claude-host run active on the same machine at the
// time. CODEX_THREAD_ID, by contrast, was directly confirmed present in that
// same model exec environment.
test('detectHost: CODEX_THREAD_ID alone is sufficient, closing the gap PLUGIN_ROOT/PLUGIN_DATA cannot reach', () => {
  assert.equal(detectHost({ CODEX_THREAD_ID: '01a0aa73-9c72-7213-9d0a-22a3a7010ece' }), 'codex');
  assert.equal(detectHost({ CODEX_THREAD_ID: '   ' }), 'claude', 'whitespace-only is not a real value');
});

test('detectHost: with no signal of any kind, the default remains claude', () => {
  assert.equal(detectHost({}), 'claude');
  assert.equal(detectHost({ PATH: '/usr/bin', HOME: '/home/x' }), 'claude', 'ordinary ambient env vars must not trip detection');
});

test('detectHost: KRYLO_HOST is checked before any inferred signal, in either direction', () => {
  assert.equal(detectHost({ KRYLO_HOST: 'claude', CODEX_THREAD_ID: 'x' }), 'claude');
  assert.equal(detectHost({ KRYLO_HOST: 'codex' }), 'codex');
});

// REGRESSION (independent review, F1). Adding CODEX_THREAD_ID as a signal
// closed one gap and opened its mirror: CODEX_THREAD_ID is Codex-exclusive
// under ORDINARY use, but nothing rules out a Claude session inheriting a
// stray value (a nested terminal opened from inside an active Codex thread,
// a devcontainer or tmux session that forwards its environment). Claude's
// own hooks bootstrap directly through the Claude adapter and never call
// detectHost() at all, but the shared runtime CLIs (read-state.mjs,
// update-state.mjs, init-run.mjs, cleanup.mjs) do -- so a leaked
// CODEX_THREAD_ID would route a genuine Claude session's own CLI calls to
// the Codex adapter's data root, find no active run there, and the risk and
// stop gates would then silently stop enforcing: a governed session with
// dead enforcement, the same failure shape ADR-0041 closed, in the opposite
// direction. A genuine Claude-native signal must win.
// REGRESSION (fourth independent review, F1). KRYLO_HOST is the
// highest-priority branch, and this checkpoint newly instructs the model to
// set it inline on every runtime CLI call -- making a model-controllable
// value the first input to a security-relevant routing decision. Untrusted
// content carrying a prompt-injection payload could set it to the opposite
// host and reach the same dead-enforcement state the rest of this work
// exists to prevent. A contradiction is now refused loudly instead.
test('detectHost: an explicit KRYLO_HOST contradicting a genuine native signal is refused, not silently honored', () => {
  assert.throws(
    () => detectHost({ KRYLO_HOST: 'codex', CLAUDE_SESSION_ID: 'a-real-claude-session' }),
    /contradicts a genuine Claude-native session signal/,
    'a prompt-injected KRYLO_HOST=codex inside a real Claude session must fail loudly, never route',
  );
  assert.throws(
    () => detectHost({ KRYLO_HOST: 'codex', CLAUDE_PLUGIN_ROOT: '/x' }),
    /contradicts/,
    'any native signal counts, not just the session id',
  );
});

test('detectHost: every legitimate KRYLO_HOST use still works, with no conflicting signal present', () => {
  // A Codex adapter's own bootstrap, and the Codex-only test helper, both
  // set KRYLO_HOST=codex in an environment with no Claude signal at all.
  assert.equal(detectHost({ KRYLO_HOST: 'codex' }), 'codex');
  assert.equal(detectHost({ KRYLO_HOST: 'codex', CODEX_THREAD_ID: 'x' }), 'codex', 'agreeing signals are not a contradiction');
  // KRYLO_HOST=claude alongside Claude's own signals is the normal Claude
  // bootstrap and must never be treated as a conflict.
  assert.equal(detectHost({ KRYLO_HOST: 'claude', CLAUDE_SESSION_ID: 'x' }), 'claude');
  assert.equal(detectHost({ KRYLO_HOST: 'claude' }), 'claude');
});

// REGRESSION (fourth independent review, F7). The Claude-native override was
// originally applied to the CODEX_THREAD_ID branch alone, leaving the two
// stronger Codex variables inconsistent with it -- even though this
// codebase's own comment describes PLUGIN_ROOT as a generic-sounding name
// unrelated tooling might set. All three now yield to a genuine native
// signal uniformly.
test('detectHost: PLUGIN_ROOT and PLUGIN_DATA also yield to a genuine Claude-native signal', () => {
  assert.equal(detectHost({ PLUGIN_ROOT: '/x', CLAUDE_SESSION_ID: 'real' }), 'claude');
  assert.equal(detectHost({ PLUGIN_DATA: '/x', CLAUDE_SESSION_ID: 'real' }), 'claude');
  // Without a Claude signal they still select codex, as before.
  assert.equal(detectHost({ PLUGIN_ROOT: '/x' }), 'codex');
  assert.equal(detectHost({ PLUGIN_DATA: '/x' }), 'codex');
});

test('detectHost: a genuine Claude-native signal outranks a merely-present CODEX_THREAD_ID', () => {
  assert.equal(
    detectHost({ CODEX_THREAD_ID: 'leaked-from-a-parent-codex-thread', CLAUDE_SESSION_ID: 'real-claude-session' }),
    'claude',
    'CLAUDE_SESSION_ID is the same signal resolveClaudeSessionId() already trusts for identity; it must also win host detection',
  );
  // Without a Claude-native signal alongside it, CODEX_THREAD_ID alone is
  // still trusted -- this must not become impossible to satisfy.
  assert.equal(detectHost({ CODEX_THREAD_ID: 'genuine-codex-session' }), 'codex');
});
