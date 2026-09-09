// Host-neutral identity and run-context contracts shared by every KRYLO host
// (Claude Code today, Codex in a future host adapter). Nothing in this module
// may read a host-specific environment variable or Hook payload field; hosts
// normalize their own inputs into these shapes before calling into Shared
// Core.

import path from 'node:path';

export const HOST_NAMES = Object.freeze(['claude', 'codex']);

const RUN_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function optionalString(value, field, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} must be a non-empty string when present`);
  } else if (value.length > 256) {
    errors.push(`${field} must be at most 256 characters`);
  }
}

export function validateHostIdentity(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['host identity must be an object'] };
  }
  if (!HOST_NAMES.includes(value.host)) errors.push('host is not supported');
  if (typeof value.hostSessionId !== 'string' || value.hostSessionId.trim() === '') errors.push('hostSessionId must be a non-empty string');
  else if (value.hostSessionId.length > 256) errors.push('hostSessionId must be at most 256 characters');
  for (const field of ['projectRoot', 'pluginRoot', 'dataRoot']) {
    if (typeof value[field] !== 'string' || !path.isAbsolute(value[field])) errors.push(`${field} must be an absolute path`);
  }
  for (const field of ['hostTurnId', 'configuredModel', 'resolvedModel', 'permissionMode']) optionalString(value[field], field, errors);
  return { valid: errors.length === 0, errors };
}

export function createHostIdentity(input) {
  const identity = {
    host: input?.host,
    hostSessionId: typeof input?.hostSessionId === 'string' ? input.hostSessionId.trim() : input?.hostSessionId,
    projectRoot: typeof input?.projectRoot === 'string' ? path.resolve(input.projectRoot) : input?.projectRoot,
    pluginRoot: typeof input?.pluginRoot === 'string' ? path.resolve(input.pluginRoot) : input?.pluginRoot,
    dataRoot: typeof input?.dataRoot === 'string' ? path.resolve(input.dataRoot) : input?.dataRoot,
    ...(input?.hostTurnId ? { hostTurnId: String(input.hostTurnId) } : {}),
    ...(input?.configuredModel ? { configuredModel: String(input.configuredModel) } : {}),
    ...(input?.resolvedModel ? { resolvedModel: String(input.resolvedModel) } : {}),
    ...(input?.permissionMode ? { permissionMode: String(input.permissionMode) } : {}),
  };
  const result = validateHostIdentity(identity);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return Object.freeze(identity);
}

export function validateHostContext(value) {
  const identityResult = validateHostIdentity(value);
  const errors = [...identityResult.errors];
  if (typeof value?.runId !== 'string' || !RUN_ID_RE.test(value.runId)) errors.push('runId is invalid');
  return { valid: errors.length === 0, errors };
}

export function bindRunId(identity, runId) {
  const context = { ...identity, runId };
  const result = validateHostContext(context);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return Object.freeze(context);
}
