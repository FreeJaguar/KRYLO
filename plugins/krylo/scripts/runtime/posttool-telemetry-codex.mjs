#!/usr/bin/env node
// KRYLO Codex tool-usage telemetry (PostToolUse hook). Mirrors
// scripts/runtime/posttool-telemetry.mjs (the Claude adapter) exactly --
// only the tool NAME and duration are recorded, never arguments, output, or
// file contents. Fail open: always exit 0, never any output. Records
// evidence/telemetry only AFTER the tool ran; never treated as a security
// boundary (the tool has already executed by the time this fires).

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeCodexHookPayload, allowCodexSilently } from '../host/codex/hook-transport.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowCodexSilently();
  const normalized = normalizeCodexHookPayload(input.value);
  if (!normalized.ok) allowCodexSilently();
  const payload = normalized.payload;

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowCodexSilently();

  const runId = run.state.runId;
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : 'unknown';

  let counterSaveFailed = false;
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;
      state.toolCounters[toolName] = (state.toolCounters[toolName] ?? 0) + 1;
      const saved = saveState(state);
      if (!saved.ok) counterSaveFailed = true;
    });
  } catch {
    counterSaveFailed = true;
  }

  const duration = Number(payload.duration_ms ?? payload.durationMs);
  recordEvent(runId, {
    event: 'tool',
    toolName,
    ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
    ...(counterSaveFailed ? { status: 'counter-not-persisted' } : {}),
  });

  allowCodexSilently();
}

main().catch(() => allowCodexSilently());
