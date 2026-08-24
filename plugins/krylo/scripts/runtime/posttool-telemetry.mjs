#!/usr/bin/env node
// KRYLO tool-usage telemetry (PostToolUse hook).
//
// Increments the per-run tool-name counter and records a local telemetry
// event. Only the tool NAME and duration are recorded — never arguments,
// output, or file contents. Fail open: always exit 0, never any output.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
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

  const runId = run.state.runId;
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : 'unknown';

  // Mutate under the run's exclusive lock, re-reading state fresh once
  // acquired -- the same per-run synchronization domain approval
  // consumption and every other real mutator uses (security-hardening
  // checkpoint, SECURITY BLOCKER 2), so this can never race a concurrent
  // migration-persist or another mutation and silently lose either side.
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;
      state.toolCounters[toolName] = (state.toolCounters[toolName] ?? 0) + 1;
      saveState(state);
    });
  } catch {
    // Fail open: telemetry must never block or crash the tool call.
  }

  const duration = Number(payload.duration_ms ?? payload.durationMs);
  recordEvent(runId, {
    event: 'tool',
    toolName,
    ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
  });

  allowClaudeSilently();
}

main().catch(() => allowClaudeSilently());
