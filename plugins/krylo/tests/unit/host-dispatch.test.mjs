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
