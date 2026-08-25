import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCodexSessionId,
  resolveCodexDataRoot,
  resolveCodexPluginRoot,
  createCodexHostIdentity,
  applyCodexRuntimeEnvironment,
  bootstrapCodexStorageEnvironment,
} from '../../scripts/host/codex/context.mjs';

test('an already-set KRYLO_DATA_ROOT overrides the Codex-derived data root and is never silently recomputed', () => {
  const isolatedRoot = path.resolve('tmp-isolated-krylo-codex-data');
  assert.equal(
    resolveCodexDataRoot({ KRYLO_DATA_ROOT: isolatedRoot }),
    isolatedRoot,
  );
  assert.equal(
    resolveCodexDataRoot({ KRYLO_DATA_ROOT: isolatedRoot, PLUGIN_DATA: path.resolve('other-root') }),
    isolatedRoot,
  );
});

test('explicit Codex session wins over hook payload session_id', () => {
  const session = resolveCodexSessionId({
    explicitSessionId: 'explicit',
    hookPayload: { session_id: 'hook' },
  });
  assert.equal(session, 'explicit');
});

test('hook payload session_id is used when no explicit override is supplied', () => {
  const session = resolveCodexSessionId({ hookPayload: { session_id: 'hook' } });
  assert.equal(session, 'hook');
});

test('Codex resolves no session id from environment alone -- unlike Claude, no legacy env var is documented, so an absent explicit/hook session id is unresolvable', () => {
  const session = resolveCodexSessionId({ hookPayload: {} });
  assert.equal(session, null);
});

test('PLUGIN_DATA (native plugin install) is used as the data root when KRYLO_DATA_ROOT is unset', () => {
  const pluginData = path.resolve('tmp-plugin-data');
  assert.equal(resolveCodexDataRoot({ PLUGIN_DATA: pluginData }), pluginData);
});

test('standalone (non-plugin) Codex run with no PLUGIN_DATA falls back to a KRYLO-owned home directory, never the Claude data root or the repo', () => {
  assert.equal(
    resolveCodexDataRoot({}),
    path.join(os.homedir(), '.krylo', 'data'),
  );
});

test('PLUGIN_ROOT is used as the plugin root when set (native plugin install)', () => {
  const pluginRoot = path.resolve('tmp-plugin-root');
  assert.equal(resolveCodexPluginRoot({ PLUGIN_ROOT: pluginRoot }), pluginRoot);
});

test('PLUGIN_ROOT absent (standalone run) falls back to the source-relative plugin root, not an invented path', () => {
  const resolved = resolveCodexPluginRoot({});
  assert.ok(path.isAbsolute(resolved));
  assert.ok(resolved.endsWith(path.join('plugins', 'krylo')) || resolved.includes('krylo'));
});

test('Claude-compatible environment aliases (CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA) are never read by the Codex adapter -- only native PLUGIN_ROOT/PLUGIN_DATA', () => {
  const env = { CLAUDE_PLUGIN_ROOT: path.resolve('claude-alias-root'), CLAUDE_PLUGIN_DATA: path.resolve('claude-alias-data') };
  assert.notEqual(resolveCodexPluginRoot(env), path.resolve('claude-alias-root'));
  assert.notEqual(resolveCodexDataRoot(env), path.resolve('claude-alias-data'));
});

test('Codex run bootstrap records normalized host session identity and host name', () => {
  const env = { PLUGIN_DATA: path.resolve('tmp-data') };
  const identity = createCodexHostIdentity({
    explicitSessionId: 's1',
    projectRoot: '.',
    env,
  });
  applyCodexRuntimeEnvironment(identity, env);
  assert.equal(identity.host, 'codex');
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data'));
  assert.equal(env.KRYLO_HOST, 'codex');
  assert.equal(env.KRYLO_HOST_SESSION_ID, 's1');
});

test('createCodexHostIdentity reads permission_mode from the hook-payload vocabulary (default/acceptEdits/plan/dontAsk/bypassPermissions), not a CLI approval_policy value', () => {
  const identity = createCodexHostIdentity({
    explicitSessionId: 's2',
    projectRoot: '.',
    hookPayload: { permission_mode: 'bypassPermissions', turn_id: 't1', model: 'gpt-5-codex' },
    env: {},
  });
  assert.equal(identity.permissionMode, 'bypassPermissions');
  assert.equal(identity.hostTurnId, 't1');
  assert.equal(identity.resolvedModel, 'gpt-5-codex');
});

test('missing session id throws rather than silently proceeding with an unidentified Codex session', () => {
  assert.throws(() => createCodexHostIdentity({ projectRoot: '.', hookPayload: {}, env: {} }));
});

test('bootstrapCodexStorageEnvironment sets KRYLO_HOST=codex even for a sessionless storage utility call', () => {
  const env = { PLUGIN_DATA: path.resolve('tmp-data-2') };
  bootstrapCodexStorageEnvironment({ env });
  assert.equal(env.KRYLO_HOST, 'codex');
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data-2'));
});
