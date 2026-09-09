// Deterministic run-state schema migration. Shared Core module: must stay
// host-neutral (no Claude-specific environment reads). Only migrates the one
// known prior schema version; anything else is refused, never guessed.

export const CURRENT_STATE_SCHEMA_VERSION = '1.1.0';

export function migrateStateDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid-state-document' };
  }
  if (input.schemaVersion === CURRENT_STATE_SCHEMA_VERSION) {
    return { ok: true, migrated: false, value: structuredClone(input) };
  }
  if (input.schemaVersion !== '1.0.0') {
    return { ok: false, error: 'unsupported-schema-version', fromVersion: input.schemaVersion ?? null };
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    return { ok: false, error: 'legacy-session-id-missing', fromVersion: '1.0.0' };
  }

  const copy = structuredClone(input);
  const sessionId = copy.sessionId;
  delete copy.sessionId;
  copy.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
  copy.host = {
    name: 'claude',
    sessionId,
  };
  copy.delegation = {
    externalWorker: false,
    depth: 0,
  };
  return { ok: true, migrated: true, fromVersion: '1.0.0', value: copy };
}
