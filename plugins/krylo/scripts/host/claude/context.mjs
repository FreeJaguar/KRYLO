// Claude-only runtime environment adapter. This is the single place allowed
// to read CLAUDE_SESSION_ID, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_ROOT, and
// CLAUDE_PLUGIN_OPTION_* directly. It normalizes them into the host-neutral
// KRYLO_* runtime variables and HostIdentity shape that Shared Core consumes.
//
// Compatibility rule: a Claude run with no explicit override must resolve to
// the same physical data root as KRYLO 0.1.1 (~/.claude/plugins/data/krylo).
// An already-set KRYLO_DATA_ROOT always wins: it is never populated by a real
// Claude host before this adapter runs, so honoring it only affects callers
// (tests, or a future non-Claude host) that deliberately set it to isolate
// storage. Recomputing it unconditionally from CLAUDE_PLUGIN_DATA would
// silently redirect those callers' writes into the real Claude data root.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostIdentity } from '../../lib/host-context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_FROM_SOURCE = path.resolve(HERE, '..', '..', '..');

const OPTION_MAP = Object.freeze({
  CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: 'KRYLO_MAX_ORBIT_CYCLES',
  CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'KRYLO_SECURITY_PROFILE',
  CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY: 'KRYLO_LOCAL_TELEMETRY',
  CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS: 'KRYLO_TELEMETRY_RETENTION_DAYS',
  CLAUDE_PLUGIN_OPTION_STATUS_DETAIL: 'KRYLO_STATUS_DETAIL',
});

export function resolveClaudeSessionId({ explicitSessionId, hookPayload, env = process.env } = {}) {
  for (const value of [explicitSessionId, hookPayload?.session_id, env.CLAUDE_SESSION_ID]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

export function resolveClaudeDataRoot(env = process.env) {
  if (typeof env.KRYLO_DATA_ROOT === 'string' && env.KRYLO_DATA_ROOT.trim() !== '') {
    return path.resolve(env.KRYLO_DATA_ROOT);
  }
  if (typeof env.CLAUDE_PLUGIN_DATA === 'string' && env.CLAUDE_PLUGIN_DATA.trim() !== '') {
    return path.resolve(env.CLAUDE_PLUGIN_DATA);
  }
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'krylo');
}

export function resolveClaudePluginRoot(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim() !== '') {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT);
  }
  return PLUGIN_ROOT_FROM_SOURCE;
}

export function createClaudeHostIdentity({ explicitSessionId, hookPayload, projectRoot = process.cwd(), env = process.env } = {}) {
  const hostSessionId = resolveClaudeSessionId({ explicitSessionId, hookPayload, env });
  if (!hostSessionId) throw new Error('Claude host session id is unavailable');
  return createHostIdentity({
    host: 'claude',
    hostSessionId,
    ...(typeof hookPayload?.prompt_id === 'string' && hookPayload.prompt_id.trim() !== '' ? { hostTurnId: hookPayload.prompt_id.trim() } : {}),
    projectRoot,
    pluginRoot: resolveClaudePluginRoot(env),
    dataRoot: resolveClaudeDataRoot(env),
    ...(typeof hookPayload?.permission_mode === 'string' && hookPayload.permission_mode.trim() !== '' ? { permissionMode: hookPayload.permission_mode.trim() } : {}),
  });
}

export function bootstrapClaudeStorageEnvironment({ env = process.env } = {}) {
  env.KRYLO_HOST = 'claude';
  env.KRYLO_DATA_ROOT = resolveClaudeDataRoot(env);
  for (const [source, target] of Object.entries(OPTION_MAP)) {
    if (typeof env[source] === 'string') env[target] = env[source];
  }
  return env;
}

export function applyClaudeRuntimeEnvironment(identity, env = process.env) {
  bootstrapClaudeStorageEnvironment({ env });
  env.KRYLO_HOST_SESSION_ID = identity.hostSessionId;
  return env;
}

export function bootstrapClaudeRuntimeEnvironment(options = {}) {
  const identity = createClaudeHostIdentity(options);
  applyClaudeRuntimeEnvironment(identity, options.env ?? process.env);
  return identity;
}
