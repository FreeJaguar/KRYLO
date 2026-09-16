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
