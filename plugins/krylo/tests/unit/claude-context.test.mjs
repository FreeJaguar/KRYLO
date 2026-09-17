import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  resolveClaudeSessionId,
  resolveClaudeDataRoot,
  createClaudeHostIdentity,
  applyClaudeRuntimeEnvironment,
  bootstrapClaudeStorageEnvironment,
  hasNativeClaudeSignal,
} from '../../scripts/host/claude/context.mjs';

// REGRESSION (independent review, F1). host-dispatch.mjs's detectHost()
// needs to know whether THIS host's own signal is genuinely present, to
// outrank a same-machine signal belonging to a different host that was
// merely inherited by accident. Shared Core is forbidden from reading this
// host's env vars directly (validate-runtime.mjs's hostIsolation check), so
// this boolean is the only channel -- covered here directly, in the one
// file allowed to read the underlying variables.
test('hasNativeClaudeSignal: true when any native signal is present, false otherwise', () => {
  assert.equal(hasNativeClaudeSignal({ CLAUDE_SESSION_ID: 'x' }), true);
  assert.equal(hasNativeClaudeSignal({ CLAUDE_PLUGIN_ROOT: '/x' }), true);
  assert.equal(hasNativeClaudeSignal({ CLAUDE_PLUGIN_DATA: '/x' }), true);
  assert.equal(hasNativeClaudeSignal({ CLAUDE_SESSION_ID: '   ' }), false, 'whitespace-only is not a real value');
  assert.equal(hasNativeClaudeSignal({}), false);
  assert.equal(hasNativeClaudeSignal({ CODEX_THREAD_ID: 'x' }), false, 'a different host\'s own signal must not count');
});

test('an already-set KRYLO_DATA_ROOT overrides the Claude-derived data root and is never silently recomputed', () => {
  const isolatedRoot = path.resolve('tmp-isolated-krylo-data');
  assert.equal(
    resolveClaudeDataRoot({ KRYLO_DATA_ROOT: isolatedRoot }),
    isolatedRoot,
  );
  assert.equal(
    resolveClaudeDataRoot({ KRYLO_DATA_ROOT: isolatedRoot, CLAUDE_PLUGIN_DATA: path.resolve('other-root') }),
    isolatedRoot,
  );
  const env = { KRYLO_DATA_ROOT: isolatedRoot };
  bootstrapClaudeStorageEnvironment({ env });
  assert.equal(env.KRYLO_DATA_ROOT, isolatedRoot);
});

test('explicit Claude session wins over Hook and legacy environment values', () => {
  const session = resolveClaudeSessionId({
    explicitSessionId: 'explicit',
    hookPayload: { session_id: 'hook' },
    env: { CLAUDE_SESSION_ID: 'legacy-env' },
  });
  assert.equal(session, 'explicit');
});

test('Hook session_id wins over legacy environment fallback', () => {
  const session = resolveClaudeSessionId({
    hookPayload: { session_id: 'hook' },
    env: { CLAUDE_SESSION_ID: 'legacy-env' },
  });
  assert.equal(session, 'hook');
});

test('legacy CLAUDE_SESSION_ID is isolated as the final Claude-only fallback', () => {
  const session = resolveClaudeSessionId({ env: { CLAUDE_SESSION_ID: 'legacy-env' } });
  assert.equal(session, 'legacy-env');
});

test('Claude data root preserves the 0.1.1 fallback path', () => {
  assert.equal(
    resolveClaudeDataRoot({}),
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'krylo'),
  );
});

test('CLAUDE_PLUGIN_DATA is translated to KRYLO_DATA_ROOT even for sessionless storage utilities', () => {
  const env = { CLAUDE_PLUGIN_DATA: path.resolve('tmp-data') };
  bootstrapClaudeStorageEnvironment({ env });
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data'));
});

test('Claude run bootstrap also records normalized host session identity', () => {
  const env = { CLAUDE_PLUGIN_DATA: path.resolve('tmp-data') };
  const identity = createClaudeHostIdentity({
    explicitSessionId: 's1',
    projectRoot: '.',
    env,
  });
  applyClaudeRuntimeEnvironment(identity, env);
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data'));
  assert.equal(env.KRYLO_HOST, 'claude');
  assert.equal(env.KRYLO_HOST_SESSION_ID, 's1');
});

test('Claude plugin options map only into KRYLO internal option names', () => {
  const env = {
    CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: '2',
    CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'local-only',
    CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY: 'false',
    CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS: '7',
    CLAUDE_PLUGIN_OPTION_STATUS_DETAIL: 'detailed',
  };
  const identity = createClaudeHostIdentity({ explicitSessionId: 's2', projectRoot: '.', env });
  applyClaudeRuntimeEnvironment(identity, env);
  assert.equal(env.KRYLO_MAX_ORBIT_CYCLES, '2');
  assert.equal(env.KRYLO_SECURITY_PROFILE, 'local-only');
  assert.equal(env.KRYLO_LOCAL_TELEMETRY, 'false');
  assert.equal(env.KRYLO_TELEMETRY_RETENTION_DAYS, '7');
  assert.equal(env.KRYLO_STATUS_DETAIL, 'detailed');
});
