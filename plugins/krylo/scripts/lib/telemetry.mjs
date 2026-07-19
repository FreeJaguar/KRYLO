// Local-only, fail-open telemetry. Never throws, never blocks the caller,
// and only ever persists a fixed whitelist of fields (docs/22-privacy-and-telemetry.md).

import fs from 'node:fs';
import path from 'node:path';

import { telemetryPath } from './paths.mjs';

const ALLOWED_FIELDS = [
  'ts',
  'event',
  'agentId',
  'agentType',
  'configuredModel',
  'resolvedModel',
  'toolName',
  'durationMs',
  'status',
  'category',
  'hash',
  'cycle',
  'terminalState',
  'label',
];

/**
 * Append a whitelisted telemetry event for runId as one JSONL line.
 * Any field not in ALLOWED_FIELDS is silently dropped. Disabled entirely
 * when CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY === 'false'. Never throws.
 */
export function recordEvent(runId, event) {
  try {
    if (process.env.CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY === 'false') {
      return { ok: true, skipped: 'disabled' };
    }
    if (!runId || typeof event !== 'object' || event === null) {
      return { ok: false, skipped: 'invalid-input' };
    }

    const filtered = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in event) filtered[key] = event[key];
    }
    if (!('ts' in filtered)) filtered.ts = new Date().toISOString();

    const filePath = telemetryPath(runId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(filtered)}\n`, 'utf8');
    return { ok: true };
  } catch {
    // Telemetry is fail-open: a write failure must never propagate.
    return { ok: false, skipped: 'error' };
  }
}
