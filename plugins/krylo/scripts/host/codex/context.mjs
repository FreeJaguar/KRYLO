// Codex-only runtime environment adapter. This is the single place allowed
// to read PLUGIN_ROOT, PLUGIN_DATA, and the Codex hook payload's
// session_id/turn_id/permission_mode fields directly. It normalizes them
// into the host-neutral KRYLO_* runtime variables and HostIdentity shape
// that Shared Core consumes -- mirrors scripts/host/claude/context.mjs
// exactly, so Shared Core never has to know which host it is running under.
//
// permission_mode here is always the Codex HOOK-PAYLOAD vocabulary
// (default | acceptEdits | plan | dontAsk | bypassPermissions), confirmed
// against current official Codex docs during the Codex Host Implementation
// Plan's own reconciliation pass (docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md
// Section 2.5). It is NOT the Codex CLI's own --ask-for-approval vocabulary
// (untrusted | on-request | never | ...), which hooks never observe.
//
// Codex plugin hooks receive Claude-compatible aliases (CLAUDE_PLUGIN_ROOT,
// CLAUDE_PLUGIN_DATA) alongside the native PLUGIN_ROOT/PLUGIN_DATA. Per the
// task's own instruction, KRYLO Codex code prefers the native variables and
// never reads the Claude-named aliases.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostIdentity } from '../../lib/host-context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_FROM_SOURCE = path.resolve(HERE, '..', '..', '..');

// A KRYLO Codex run is only ever CREATED by the UserPromptSubmit hook
// (scripts/security/user-prompt-submit-codex.mjs), bound to payload.session_id
// from that hook's own event -- never to anything read here. This function
// exists for the LATER step: once a run already exists, resolving which
// existing run a bare CLI call (read-state.mjs/update-state.mjs, invoked
// directly by the model's own shell after the hook already bootstrapped a
// run) should read or update, when the caller supplies no explicit
// --session. env.CODEX_THREAD_ID is the platform-injected shell-execution
// environment variable confirmed by codex-rs/core/src/exec_env.rs to carry
// the same underlying ThreadId as session_id -- used here purely as a
// lookup convenience, mirroring exactly how resolveClaudeSessionId already
// falls back to env.CLAUDE_SESSION_ID for the identical purpose. Without
// this, every session-less CLI call fell back to readActiveRunPointer's
// ADR-0020 "most recently updated pointer" heuristic, which a fresh
// independent Reviewer found lets one Codex session's CLI calls silently
// mutate a DIFFERENT concurrent Codex session's run in the same project --
// exactly the cross-session collision this checkpoint's own isolation
// requirement (Section 6E) forbids. This is still never used to CREATE or
// bind a run's identity (that stays exclusively the hook's job), so it
// carries no more trust than the identical, already-accepted Claude
// pattern.
export function resolveCodexSessionId({ explicitSessionId, hookPayload, env = process.env } = {}) {
  for (const value of [explicitSessionId, hookPayload?.session_id, env.CODEX_THREAD_ID]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// PLUGIN_DATA (native plugin install) wins when present. A standalone
// (non-plugin, VS Code project-hook bridge) run has no PLUGIN_DATA at all --
// its documented fallback is a KRYLO-owned directory under the user's home,
// per docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 7.3. This
// must never fall back to the Claude data root or the application repository.
export function resolveCodexDataRoot(env = process.env) {
  if (typeof env.KRYLO_DATA_ROOT === 'string' && env.KRYLO_DATA_ROOT.trim() !== '') {
    return path.resolve(env.KRYLO_DATA_ROOT);
  }
  if (typeof env.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim() !== '') {
    return path.resolve(env.PLUGIN_DATA);
  }
  return path.join(os.homedir(), '.krylo', 'data');
}

export function resolveCodexPluginRoot(env = process.env) {
  if (typeof env.PLUGIN_ROOT === 'string' && env.PLUGIN_ROOT.trim() !== '') {
    return path.resolve(env.PLUGIN_ROOT);
  }
  return PLUGIN_ROOT_FROM_SOURCE;
}

export function createCodexHostIdentity({ explicitSessionId, hookPayload, projectRoot = process.cwd(), env = process.env } = {}) {
  const hostSessionId = resolveCodexSessionId({ explicitSessionId, hookPayload, env });
  if (!hostSessionId) throw new Error('Codex host session id is unavailable');
  return createHostIdentity({
    host: 'codex',
    hostSessionId,
    ...(typeof hookPayload?.turn_id === 'string' && hookPayload.turn_id.trim() !== '' ? { hostTurnId: hookPayload.turn_id.trim() } : {}),
    projectRoot,
    pluginRoot: resolveCodexPluginRoot(env),
    dataRoot: resolveCodexDataRoot(env),
    ...(typeof hookPayload?.model === 'string' && hookPayload.model.trim() !== '' ? { resolvedModel: hookPayload.model.trim() } : {}),
    ...(typeof hookPayload?.permission_mode === 'string' && hookPayload.permission_mode.trim() !== '' ? { permissionMode: hookPayload.permission_mode.trim() } : {}),
  });
}

export function bootstrapCodexStorageEnvironment({ env = process.env } = {}) {
  env.KRYLO_HOST = 'codex';
  env.KRYLO_DATA_ROOT = resolveCodexDataRoot(env);
  return env;
}

export function applyCodexRuntimeEnvironment(identity, env = process.env) {
  bootstrapCodexStorageEnvironment({ env });
  env.KRYLO_HOST_SESSION_ID = identity.hostSessionId;
  return env;
}

export function bootstrapCodexRuntimeEnvironment(options = {}) {
  const identity = createCodexHostIdentity(options);
  applyCodexRuntimeEnvironment(identity, options.env ?? process.env);
  return identity;
}
