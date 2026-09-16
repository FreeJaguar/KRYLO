import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCodexSessionId,
  resolveCodexDataRoot,
  resolveCodexPluginRoot,
  deriveCodexDataRootFromPluginRoot,
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
    env: {},
  });
  assert.equal(session, 'explicit');
});

test('hook payload session_id is used when no explicit override is supplied', () => {
  const session = resolveCodexSessionId({ hookPayload: { session_id: 'hook' }, env: {} });
  assert.equal(session, 'hook');
});

test('Codex resolves no session id at all when neither explicit/hook session id NOR CODEX_THREAD_ID is present', () => {
  const session = resolveCodexSessionId({ hookPayload: {}, env: {} });
  assert.equal(session, null);
});

// CODEX_THREAD_ID is a lookup-only convenience for resolving an EXISTING
// run from a later, session-less CLI call (mirroring resolveClaudeSessionId's
// existing CLAUDE_SESSION_ID fallback) -- added after a fresh independent
// Reviewer and Security Reviewer both reproduced a cross-session CLI
// collision without it. It must never be read implicitly from the real
// process.env in a test that does not intend to exercise it, which is why
// every other case in this file passes an explicit env object.
test('CODEX_THREAD_ID resolves a session id only when no explicit/hook session id is supplied', () => {
  assert.equal(resolveCodexSessionId({ hookPayload: {}, env: { CODEX_THREAD_ID: 'thread-x' } }), 'thread-x');
  assert.equal(
    resolveCodexSessionId({ explicitSessionId: 'explicit', hookPayload: {}, env: { CODEX_THREAD_ID: 'thread-x' } }),
    'explicit',
    'CODEX_THREAD_ID must never override an explicit session id',
  );
  assert.equal(
    resolveCodexSessionId({ hookPayload: { session_id: 'hook' }, env: { CODEX_THREAD_ID: 'thread-x' } }),
    'hook',
    'CODEX_THREAD_ID must never override a hook-payload session id',
  );
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

// ---------------------------------------------------------------------------
// deriveCodexDataRootFromPluginRoot() / resolveCodexDataRoot()'s new
// self-derivation fallback tier (live verification, see the header comment
// above deriveCodexDataRootFromPluginRoot() in context.mjs for the full
// story: handing the model the literal data-root value and instructing it
// to set KRYLO_DATA_ROOT was tried first and found unusable, because any
// command referencing that path is denied by KRYLO's own sensitive-path
// protection). This is a best-effort HINT derived from an assumption about
// Codex's own undocumented on-disk layout, so every test here is anchored
// to a REAL temp directory structure and an EXISTENCE check, never to a
// path that is merely shaped correctly but does not exist.
// ---------------------------------------------------------------------------

function makeFakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-codex-layout-'));
  const pluginRoot = path.join(root, 'plugins', 'cache', 'some-marketplace', 'some-plugin', '1.0.0');
  const dataRoot = path.join(root, 'plugins', 'data', 'some-plugin-some-marketplace');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  return { root, pluginRoot, dataRoot };
}

test('deriveCodexDataRootFromPluginRoot: derives the real sibling data directory when it exists', () => {
  const { root, pluginRoot, dataRoot } = makeFakeInstall();
  try {
    assert.equal(deriveCodexDataRootFromPluginRoot(pluginRoot), dataRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deriveCodexDataRootFromPluginRoot: returns null when the shape matches but the directory does not actually exist', () => {
  // A plugin root that LOOKS like the convention but whose data sibling was
  // never created (e.g. a plugin that has never bootstrapped a hook yet)
  // must fall through, not point at a phantom directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-codex-layout-nodata-'));
  const pluginRoot = path.join(root, 'plugins', 'cache', 'some-marketplace', 'some-plugin', '1.0.0');
  fs.mkdirSync(pluginRoot, { recursive: true });
  try {
    assert.equal(deriveCodexDataRootFromPluginRoot(pluginRoot), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deriveCodexDataRootFromPluginRoot: returns null for a path that does not match the plugins/cache/.../.../... shape at all', () => {
  // This is the SAME shape a standalone (non-plugin) install's own source
  // tree has -- must never accidentally match and point somewhere wrong.
  assert.equal(deriveCodexDataRootFromPluginRoot(path.resolve('some', 'unrelated', 'path')), null);
  assert.equal(deriveCodexDataRootFromPluginRoot(path.resolve('plugins', 'krylo')), null, 'no "cache" segment at all');
  const { root, pluginRoot } = makeFakeInstall();
  try {
    // A "cache" segment present but NOT immediately preceded by "plugins".
    const wrongParent = pluginRoot.replace(path.join('plugins', 'cache'), path.join('other', 'cache'));
    fs.mkdirSync(wrongParent, { recursive: true });
    assert.equal(deriveCodexDataRootFromPluginRoot(wrongParent), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodexDataRoot: uses the derived data root as a fallback tier BELOW the explicit overrides', () => {
  const { root, pluginRoot, dataRoot } = makeFakeInstall();
  try {
    // KRYLO_DATA_ROOT and PLUGIN_DATA each still win outright over derivation.
    assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot, KRYLO_DATA_ROOT: '/explicit' }), path.resolve('/explicit'));
    assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: '/explicit-2' }), path.resolve('/explicit-2'));
    // With neither present -- the real shape of the model's own exec
    // environment, confirmed live -- derivation from PLUGIN_ROOT alone kicks
    // in and finds the real data root with no other input at all.
    assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot }), dataRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodexDataRoot: a non-matching or nonexistent layout falls through to the home-directory default, not a guess', () => {
  assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: path.resolve('some', 'unrelated', 'path') }), path.join(os.homedir(), '.krylo', 'data'));
  // The repo's own real on-disk layout (no "cache" segment) is exactly this
  // case, and this is also what a standalone (non-plugin) install falls
  // back to when PLUGIN_ROOT is entirely absent.
  assert.equal(resolveCodexDataRoot({}), path.join(os.homedir(), '.krylo', 'data'));
});
