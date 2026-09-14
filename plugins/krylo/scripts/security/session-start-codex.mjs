#!/usr/bin/env node
// KRYLO Codex SessionStart hook. docs/adr/0033-codex-lifecycle-enforcement.md.
//
// Deliberately narrow: this file NEVER creates, activates, or mutates a
// KRYLO run under any circumstance -- $krylo-run via UserPromptSubmit
// (scripts/security/user-prompt-submit-codex.mjs) remains the ONLY place a
// run is ever created. This fires for every ordinary Codex session
// (Codex has no Skill-scoped hook lifecycle), so the overwhelmingly common
// path must stay a fast, side-effect-free no-op.
//
// The one safe, useful role: when an active, non-terminal KRYLO run is
// ALREADY genuinely bound to this exact session_id and project (e.g. a
// resumed session), emit a short factual reminder via
// hookSpecificOutput.additionalContext -- informational only, never a
// decision, and never fabricated when nothing is actually active.

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeCodexHookPayload, emitCodexSessionStartContext, allowCodexSilently } from '../host/codex/hook-transport.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowCodexSilently();
  const normalized = normalizeCodexHookPayload(input.value);
  if (!normalized.ok) allowCodexSilently();

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowCodexSilently();

  emitCodexSessionStartContext(
    `KRYLO run ${run.state.runId} is already active for this session. Follow the krylo-run Skill workflow; do not initialize another run.`,
  );
}

main().catch(() => allowCodexSilently());
