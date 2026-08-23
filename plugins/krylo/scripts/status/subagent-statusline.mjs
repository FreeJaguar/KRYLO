#!/usr/bin/env node
// KRYLO subagent status-line renderer (docs/08-status-lines.md, ADR-0016).
//
// Renders agent rows and a run summary from local run state only. Never
// displays prompts, commands, tool arguments, source code, secrets, or
// external content. Prints nothing when no KRYLO run is active.

import { readActiveRunPointerForCwd, loadState } from '../lib/state.mjs';
import { bootstrapClaudeStorageEnvironment, resolveClaudeSessionId } from '../host/claude/context.mjs';

function elapsedSeconds(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 1000));
}

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function agentStateLabel(agent, nowMs = Date.now()) {
  if (agent.status !== 'running') return agent.status;
  const seconds = elapsedSeconds(agent.startedAt, new Date(nowMs).toISOString());
  if (seconds < 20) return 'starting';
  if (seconds < 90) return 'working';
  if (seconds < 300) return 'still working';
  return 'long task';
}

export function renderStatus(state, detail = 'normal', nowMs = Date.now()) {
  const lines = [];
  const proven = state.acceptanceCriteria.filter((c) => c.status === 'proven' || c.status === 'not-applicable').length;
  const total = state.acceptanceCriteria.length;
  const runningAgents = state.agents.filter((a) => a.status === 'running');

  const summaryParts = [
    `KRYLO ${state.phase}`,
    `cycle ${state.orbit.cycle}/${state.orbit.budget}`,
    `${proven}/${total} AC`,
  ];
  if (detail === 'detailed') {
    const toolTotal = Object.values(state.toolCounters).reduce((a, b) => a + b, 0);
    summaryParts.push(`${toolTotal} tool calls`);
  }
  if (runningAgents.length > 0) summaryParts.push(`${runningAgents.length} agent(s) running`);
  lines.push(summaryParts.join(' | '));

  if (detail !== 'minimal') {
    for (const agent of state.agents) {
      if (agent.status === 'completed' && detail !== 'detailed') continue;
      const model = agent.resolvedModel ?? agent.configuredModel;
      const label = agent.taskLabel ? ` | ${String(agent.taskLabel).slice(0, 40)}` : '';
      const clock = agent.startedAt ? ` ${formatClock(elapsedSeconds(agent.startedAt, agent.endedAt ?? undefined))}` : '';
      lines.push(`* ${agent.type} | ${model} | ${agentStateLabel(agent, nowMs)}${clock}${label}`);
    }
  }

  return lines.join('\n');
}

async function main() {
  // Consume stdin defensively: statusline payloads are Claude-defined JSON
  // (may include session_id) but must never be trusted to be well-formed.
  let stdinRaw = '';
  try {
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) {
        stdinRaw += chunk;
        if (stdinRaw.length > 65536) break;
      }
    }
  } catch {
    // ignore
  }

  bootstrapClaudeStorageEnvironment();

  let hookPayload = null;
  try {
    const parsed = JSON.parse(stdinRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hookPayload = parsed;
  } catch {
    // Absent or unparsable stdin just means no session id is available from
    // it; the pointer lookup below falls back to the most recent Claude
    // pointer for this project.
  }
  const hostSessionId = resolveClaudeSessionId({ hookPayload });

  // No hostSessionId is not an error here: it falls back to the most
  // recently updated pointer inside the `claude` host directory for this
  // project only (readActiveRunPointer never crosses into another host's
  // directory), matching the pre-multi-host statusline behavior.
  const pointer = readActiveRunPointerForCwd(process.cwd(), { host: 'claude', hostSessionId });
  if (!pointer.ok || !pointer.value?.runId) process.exit(0);
  const loaded = loadState(pointer.value.runId);
  if (!loaded.ok) process.exit(0);

  const detail = process.env.KRYLO_STATUS_DETAIL ?? 'normal';
  process.stdout.write(renderStatus(loaded.value, detail));
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(() => process.exit(0));
}
