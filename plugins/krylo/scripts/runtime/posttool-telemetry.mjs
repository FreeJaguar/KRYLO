#!/usr/bin/env node
// KRYLO tool-usage telemetry (PostToolUse hook).
//
// Increments the per-run tool-name counter and records a local telemetry
// event. Only the tool NAME and duration are recorded — never arguments,
// output, or file contents. Fail open: always exit 0, never any output.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { saveState } from '../lib/state.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowClaudeSilently();
  const normalized = normalizeClaudeHookPayload(input.value);
  if (!normalized.ok) allowClaudeSilently();
  const payload = normalized.payload;

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const state = run.state;
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : 'unknown';

  state.toolCounters[toolName] = (state.toolCounters[toolName] ?? 0) + 1;
  saveState(state);

  const duration = Number(payload.duration_ms ?? payload.durationMs);
  recordEvent(state.runId, {
    event: 'tool',
    toolName,
    ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
  });

  allowClaudeSilently();
}

main().catch(() => allowClaudeSilently());
