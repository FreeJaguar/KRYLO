import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test('resolveCodexDataRoot: KRYLO_DATA_ROOT and PLUGIN_DATA each still win outright over derivation', () => {
  const { root, pluginRoot } = makeFakeInstall();
  try {
    assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot, KRYLO_DATA_ROOT: '/explicit' }), path.resolve('/explicit'));
    assert.equal(resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: '/explicit-2' }), path.resolve('/explicit-2'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// REGRESSION (independent review, F2). resolveCodexDataRoot() originally
// derived from resolveCodexPluginRoot(env), which honours env.PLUGIN_ROOT --
// so an attacker-controlled PLUGIN_ROOT (a generic-sounding variable name
// unrelated tooling might set) pointing at a directory shaped like a real
// Codex install could redirect KRYLO's entire control plane (run state,
// question grants, risk approvals) to a location the attacker controls. The
// derivation now always uses the module's own self-derived
// PLUGIN_ROOT_FROM_SOURCE, so env.PLUGIN_ROOT is not merely a lower
// priority than KRYLO_DATA_ROOT/PLUGIN_DATA -- it has NO effect on
// derivation at all. Proven here directly: a correctly-shaped, genuinely
// EXISTING attacker-controlled install must not be found.
test('resolveCodexDataRoot: env.PLUGIN_ROOT can never redirect derivation, even when it names a real, correctly-shaped directory', () => {
  const { root, pluginRoot, dataRoot } = makeFakeInstall();
  try {
    const result = resolveCodexDataRoot({ PLUGIN_ROOT: pluginRoot });
    assert.notEqual(result, dataRoot, 'an attacker-shaped PLUGIN_ROOT must never be trusted for derivation');
    assert.equal(result, path.join(os.homedir(), '.krylo', 'data'), 'must fall through to the safe default instead');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The genuine, non-attacker success path: a REAL install whose own on-disk
// location matches Codex's layout, exercised with NO environment override at
// all -- the actual shape of the model's own exec environment, confirmed
// live in docs/adr/0041-codex-live-hook-verification-round-two.md. Copies
// context.mjs and its one real dependency into a fixture shaped exactly like
// a real Codex plugin-cache install, then dynamically imports the COPY so
// its own self-derived PLUGIN_ROOT_FROM_SOURCE (computed from where that
// file actually lives on disk) genuinely matches the pattern -- proving the
// real mechanism, not a stand-in for it.
test('resolveCodexDataRoot: a genuine install location self-derives the correct data root with zero environment input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-real-layout-'));
  try {
    const fixturePluginRoot = path.join(root, 'plugins', 'cache', 'krylo-marketplace', 'krylo', '0.2.0');
    const fixtureDataRoot = path.join(root, 'plugins', 'data', 'krylo-krylo-marketplace');
    fs.mkdirSync(path.join(fixturePluginRoot, 'scripts', 'host', 'codex'), { recursive: true });
    fs.mkdirSync(path.join(fixturePluginRoot, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(fixtureDataRoot, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', 'scripts', 'host', 'codex', 'context.mjs'),
      path.join(fixturePluginRoot, 'scripts', 'host', 'codex', 'context.mjs'),
    );
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'host-context.mjs'),
      path.join(fixturePluginRoot, 'scripts', 'lib', 'host-context.mjs'),
    );
    const copiedContextUrl = pathToFileURL(path.join(fixturePluginRoot, 'scripts', 'host', 'codex', 'context.mjs'));
    const copied = await import(copiedContextUrl.href);
    // No env at all: the exact shape of the model's own exec environment.
    assert.equal(copied.resolveCodexDataRoot({}), fixtureDataRoot);
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
