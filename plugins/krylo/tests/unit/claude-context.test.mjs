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
} from '../../scripts/host/claude/context.mjs';

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
