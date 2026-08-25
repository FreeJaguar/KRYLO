#!/usr/bin/env node
// KRYLO Codex PermissionRequest hook. Fires only when Codex's own state was
// already about to prompt for approval (current official docs: it "cannot
// be treated as a mechanism that creates an approval request for an
// otherwise non-prompting action"). Used here strictly as defense in depth:
// re-runs the same host-neutral classification and denies outright if the
// action is a KRYLO hard-deny (sensitive path, data root, hook entrypoint,
// oversized command) -- any deny from any matching hook wins, per current
// official docs, so this can only make a hard-deny stricter, never weaker.
//
// For every other case (require-approval, or pass), this hook returns NO
// decision at all -- it does not auto-allow (that would risk widening
// Codex's own prompt into a silent approval) and it does not invent an
// approval event KRYLO itself never classified as require-approval. Codex's
// own normal prompt flow continues untouched.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import {
  normalizeCodexHookPayload,
  emitCodexPermissionRequestDecision,
  allowCodexSilently,
} from '../host/codex/hook-transport.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { classifyRiskAction } from './risk-policy.mjs';

function normalizeCodexToolName(rawName) {
  if (rawName === 'shell' || rawName === 'exec_command') return 'Bash';
  return rawName;
}

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

  const state = run.state;

  try {
    const toolName = normalizeCodexToolName(String(payload.tool_name ?? ''));
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

    const decision = classifyRiskAction({
      toolName,
      toolInput,
      cwd,
      dataRoot: normalized.identity.dataRoot,
      pluginRoot: normalized.identity.pluginRoot,
    });

    if (decision.action === 'deny') {
      recordEvent(state.runId, { event: 'permission-request-codex', category: decision.category, status: 'denied' });
      emitCodexPermissionRequestDecision('deny', decision.reason);
    }

    // require-approval and pass: no opinion, let Codex's own prompt (or lack
    // of one) continue exactly as it would without KRYLO installed.
    allowCodexSilently();
  } catch {
    // "No opinion" (let Codex's own prompt continue) rather than risk
    // misclassifying based on a partial/exception state. This hook only
    // ever adds an ADDITIONAL deny on top of Codex's own prompt flow; it
    // never independently authorizes anything, so failing to "no opinion"
    // here cannot itself create a fail-open gap PreToolUse did not already
    // have its own chance to catch for tool-call-shaped actions.
    allowCodexSilently();
  }
}

main().catch(() => {
  allowCodexSilently();
});
