#!/usr/bin/env node
// KRYLO agent-event capture (SubagentStart / SubagentStop hooks).
//
// Records agent identity, timing, status, and the resolved model when the
// platform explicitly provides one (never inferred). Whitelist extraction
// only; no prompts or task content are persisted beyond a short label.
// Fail open: always exit 0, no output.

import { readStdinJson, resolveActiveRun, eventName } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { redactAndTruncate } from '../lib/redact.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

function pickString(payload, keys) {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

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
  const event = eventName(payload);
  const agentType = pickString(payload, ['agent_type', 'subagent_type', 'agent_name', 'agentType']) ?? 'unknown';
  const configuredModel = pickString(payload, ['model', 'configured_model', 'configuredModel']) ?? 'unknown';
  const resolvedModel = pickString(payload, ['resolved_model', 'resolvedModel']); // explicit only, never inferred
  const now = new Date().toISOString();

  // Mutate under the run's exclusive lock, re-reading state fresh once
  // acquired (security-hardening checkpoint, SECURITY BLOCKER 2): both the
  // SubagentStart id (derived from the current agents.length) and the
  // SubagentStop lookup must see a consistent, current agents array, and
  // this can never race a concurrent migration-persist or another mutation.
  let recorded = null;
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;

      if (event === 'SubagentStart') {
        const id = `agent-${state.agents.length + 1}`;
        const agent = {
          id,
          type: agentType,
          configuredModel,
          resolvedModel: resolvedModel ?? null,
          status: 'running',
          startedAt: now,
          endedAt: null,
        };
        const label = pickString(payload, ['description', 'task_label', 'taskLabel']);
        if (label) agent.taskLabel = redactAndTruncate(label, 120);
        state.agents.push(agent);
        saveState(state);
        recorded = { event: 'agent-start', agentId: id, agentType, configuredModel, ...(resolvedModel ? { resolvedModel } : {}) };
      } else if (event === 'SubagentStop') {
        const running = [...state.agents].reverse().find((a) => a.status === 'running' && (a.type === agentType || agentType === 'unknown'));
        if (running) {
          const statusField = pickString(payload, ['status', 'result_status']);
          running.status = statusField === 'failed' ? 'failed' : 'completed';
          running.endedAt = now;
          if (resolvedModel && !running.resolvedModel) running.resolvedModel = resolvedModel;
          saveState(state);
          recorded = { event: 'agent-stop', agentId: running.id, agentType: running.type, status: running.status };
        }
      }
    });
  } catch {
    // Fail open: agent-event bookkeeping must never block or crash the hook.
  }

  if (recorded) recordEvent(runId, recorded);

  allowClaudeSilently();
}

main().catch(() => allowClaudeSilently());
