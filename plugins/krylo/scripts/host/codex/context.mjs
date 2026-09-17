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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostIdentity } from '../../lib/host-context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_FROM_SOURCE = path.resolve(HERE, '..', '..', '..');

// Best-effort derivation of the real Codex-native data root from the
// self-derived plugin root above, with NO input from the model at all.
//
// This exists because the obvious fix -- have the UserPromptSubmit hook hand
// the model the literal resolved data-root path, and instruct it to set
// KRYLO_DATA_ROOT inline on every runtime CLI call -- is UNUSABLE: a live
// verification session found that any Bash/PowerShell command whose text
// contains the real data-root path is unconditionally denied by this
// project's own sensitive-path protection (risk-policy.mjs's
// touchesDataRoot(), a deliberately blunt "deny outright rather than
// attempting to classify" control that exists to stop a model from
// bypassing the runtime scripts and manipulating control-plane state files
// directly). That control is correct to keep exactly as blunt as it is --
// carving a safe exception into it is its own security review, not a
// side-effect of this fix. So the model must never be told the literal data
// root at all, and the runtime scripts must find it themselves.
//
// The plugin root is self-derivable with zero env vars (PLUGIN_ROOT_FROM_SOURCE
// above, from this file's own on-disk location) because the model already
// needs SOME absolute path to construct `node "<path>/scripts/runtime/..."`
// in the first place -- that need can never be removed. The data root has no
// equivalent unavoidable need, so it should have no equivalent requirement.
//
// Empirically observed on a real installation (Codex CLI 0.154.0, plugin
// installed via `codex plugin add`):
//   plugin root: .../plugins/cache/<marketplace>/<plugin>/<version>
//   data root:   .../plugins/data/<plugin>-<marketplace>
// This is an assumption about Codex's own undocumented on-disk layout, not
// a contract KRYLO controls, so it is treated as a best-effort HINT, never
// as ground truth: the derived path is used only when it names a directory
// that genuinely already exists (fs.existsSync), so a layout that does not
// match this pattern (a different install method, a future Codex version)
// falls straight through to the pre-existing home-directory default rather
// than silently pointing at a wrong, possibly-nonexistent location.
export function deriveCodexDataRootFromPluginRoot(pluginRoot) {
  const segments = pluginRoot.split(path.sep);
  const cacheIndex = segments.lastIndexOf('cache');
  // Expect at least: [..., 'plugins', 'cache', marketplace, plugin, version].
  if (cacheIndex < 1 || segments.length < cacheIndex + 4) return null;
  if (segments[cacheIndex - 1] !== 'plugins') return null;
  const marketplace = segments[cacheIndex + 1];
  const plugin = segments[cacheIndex + 2];
  if (!marketplace || !plugin) return null;
  const pluginsDir = segments.slice(0, cacheIndex).join(path.sep);
  const candidate = path.join(pluginsDir, 'data', `${plugin}-${marketplace}`);
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

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
  // Neither env var is available: exactly the model's own `exec` shell
  // environment (see deriveCodexDataRootFromPluginRoot's comment above).
  // Try to find the SAME real data root a hook invocation for this same
  // plugin install would have used, before falling back to the
  // non-plugin-specific home directory default.
  //
  // Derived from PLUGIN_ROOT_FROM_SOURCE directly, NOT from
  // resolveCodexPluginRoot(env) -- an independent review found that calling
  // the env-aware resolver here let an attacker-controlled env.PLUGIN_ROOT
  // (a generic-sounding variable name unrelated tooling might set) redirect
  // this derivation to a directory of the attacker's own choosing, widening
  // the blast radius of that one variable from "points at the wrong plugin
  // install" to "points KRYLO's entire control plane -- run state, question
  // grants, risk approvals -- at a location the attacker controls". This
  // branch is reached only when BOTH PLUGIN_DATA and KRYLO_DATA_ROOT are
  // absent, which describes the model's own exec environment, where
  // PLUGIN_ROOT is equally absent (Finding 3) -- so env.PLUGIN_ROOT being
  // set here at all means either a genuine hook environment (which would
  // already have returned above via PLUGIN_DATA) or exactly the attacker
  // scenario this closes; there is no legitimate case that needs it.
  const derived = deriveCodexDataRootFromPluginRoot(PLUGIN_ROOT_FROM_SOURCE);
  if (derived) return derived;
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
