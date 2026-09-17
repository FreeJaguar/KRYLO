#!/usr/bin/env node
// KRYLO Codex project-scoped hook launcher
// (docs/adr/0032-codex-project-scoped-hook-enforcement.md).
//
// Installed verbatim into <project>/.codex/krylo/ by install-codex.mjs
// --target hooks, and referenced from <project>/.codex/hooks.json by a
// plain project-relative command path. Contains NO policy of its own: it
// exists only because current official Codex docs confirm PLUGIN_ROOT/
// PLUGIN_DATA are plugin-bundled-hook-only, so a project-scoped hook has no
// portable Codex-native way to reference an installed runtime's location
// without embedding a machine-specific absolute path directly into
// shareable repository configuration -- which
// docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 10.4
// explicitly forbids. This file locates the real, already-installed KRYLO
// standalone runtime (the same location install-codex.mjs --target skill
// copies scripts/references/schemas/policies into) using the identical
// portable algorithm scripts/host/codex/context.mjs already uses, then
// re-executes the exact real hook script for the given event with
// inherited stdin/stdout/stderr -- a redirector, never a second copy of
// Core policy source. Exit code is inherited for user-prompt-submit/
// post-tool-use (a crash there is real, visible diagnostic signal); for
// pre-tool-use/stop/session-start/session-end the exit code is instead
// normalized to each event's own confirmed-safe outcome on failure (deny
// for pre-tool-use, silent allow for the other three) -- see the
// SILENT_ON_FAILURE_EVENTS comment below for why.
//
// krylo-hook-launcher-version: 0.3.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const EVENT_SCRIPTS = {
  'user-prompt-submit': ['security', 'user-prompt-submit-codex.mjs'],
  'pre-tool-use': ['security', 'risk-gate-codex.mjs'],
  'post-tool-use': ['runtime', 'posttool-telemetry-codex.mjs'],
  stop: ['orbit', 'stop-gate-codex.mjs'],
  'session-start': ['security', 'session-start-codex.mjs'],
  'session-end': ['status', 'session-end-codex.mjs'],
};

function resolveStandaloneRoot() {
  const override = process.env.KRYLO_STANDALONE_ROOT;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.agents', 'skills', 'krylo-run');
}

// Exactly the PreToolUse deny shape scripts/host/codex/hook-transport.mjs's
// emitCodexPreToolDeny() produces -- duplicated here (not imported) on
// purpose: if the real runtime cannot be located at all, this file cannot
// safely import anything from it either.
function denyPreToolUse(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// PreToolUse is the ONLY event among the six above where "fail toward
// denying" is the safe direction -- confirmed directly against
// rust-v0.152.1's own pre_tool_use.rs unit tests: a PreToolUse hook that
// fails to emit valid output FAILS OPEN (the tool call proceeds), so this
// launcher must never let a crash/missing-runtime/spawn-failure silently
// allow a tool call through.
//
// "stop" is the one event where a crash must ALSO resolve to a specific,
// deliberate outcome rather than surfacing the real failure: stop-gate-codex.mjs's
// own confirmed-safe fail-toward-ending property
// (docs/adr/0033-codex-lifecycle-enforcement.md) means this launcher must
// exit 0/no-output on any "stop" failure too, never emit a block decision
// it cannot back with a real classification, and never risk Codex's own
// hook-failure handling doing something other than "let the session end"
// (unverified, so the launcher does not rely on it either way).
//
// Every OTHER event (user-prompt-submit, post-tool-use, session-start,
// session-end) is a non-security-boundary lifecycle/telemetry event with
// nothing to block -- for these, a genuine crash (as opposed to a merely
// missing runtime, handled separately below) is real, useful diagnostic
// signal that should surface, not be silently discarded: propagate the
// real exit code, matching this launcher's own original, pre-Stop-checkpoint
// behavior for user-prompt-submit/post-tool-use (a fresh independent
// Reviewer found and reproduced that an earlier version of this file
// accidentally widened the "always exit 0" override to these two
// pre-existing events as well, hiding a corrupted bootstrap-hook install
// with no signal at all -- out of scope for this checkpoint to change).
const SILENT_ON_FAILURE_EVENTS = new Set(['stop', 'session-start', 'session-end']);

function main() {
  const event = process.argv[2];
  const isPreToolUse = event === 'pre-tool-use';
  const silentOnFailure = SILENT_ON_FAILURE_EVENTS.has(event);
  try {
    const scriptRel = EVENT_SCRIPTS[event];
    if (!scriptRel) {
      // Unrecognized/malformed launcher invocation. This launcher's argv
      // cannot itself tell whether the caller expected a PreToolUse-shaped
      // response, so fail-safe means the conservative (deny-shaped)
      // output -- a non-PreToolUse caller simply receives an output it
      // never reads.
      denyPreToolUse('KRYLO project hook launcher received an unrecognized event and denied as a fail-safe.');
      return;
    }

    const root = resolveStandaloneRoot();
    const scriptPath = path.join(root, 'scripts', ...scriptRel);
    if (!fs.existsSync(scriptPath)) {
      if (isPreToolUse) {
        // PreToolUse is the security boundary: with no real script to
        // delegate to, this launcher cannot determine whether a KRYLO run
        // is even active, so it cannot safely no-op. Deny, matching this
        // codebase's established fail-closed philosophy elsewhere.
        denyPreToolUse(
          `KRYLO standalone runtime is not installed or was removed (expected under ${root}). `
          + 'Run install-codex.mjs --target skill --apply to (re)install it, or remove these '
          + 'project hooks with install-codex.mjs --target hooks --remove --apply if KRYLO is no longer in use here.',
        );
        return;
      }
      // Every other event (stop, session-start, session-end,
      // user-prompt-submit, post-tool-use): a missing runtime here means no
      // run can ever have been created or need continuing (matching this
      // launcher's original, pre-Stop-checkpoint behavior for
      // user-prompt-submit/post-tool-use unchanged), so a silent no-op
      // matches the same inactive-run/safe-ending contract the real hooks
      // already implement, without pure UX noise. This is distinct from a
      // genuine crash further below, which DOES stay visible for
      // user-prompt-submit/post-tool-use.
      process.exit(0);
      return;
    }

    const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit', shell: false });
    if (result.status === 0) {
      process.exit(0);
      return;
    }
    // Nonzero exit, or a null status (spawnSync could not even launch the
    // real script -- a permission error, or the path exists but is not
    // executable content): every real hook script's own contract
    // guarantees exit 0 always means either a valid decision was already
    // written to inherited stdout, or an intentional silent-allow -- so
    // anything else means it crashed before reaching that point (corrupted
    // install, syntax error, etc.).
    if (isPreToolUse) {
      denyPreToolUse("KRYLO project hook launcher's real enforcement script did not complete normally and denied as a fail-safe.");
      return;
    }
    // For stop/session-start/session-end: never propagate a raw crash exit
    // code. This launcher has no independent basis to know how Codex's own
    // hook-run-failure handling would interpret a nonzero/null status, so
    // the only verified-safe choice is the same clean "no decision" exit
    // the real script's own worst-case fail path already produces -- these
    // three events have no decision to communicate and nothing to block.
    // For user-prompt-submit/post-tool-use, propagate the real exit code:
    // these are pre-existing events outside this checkpoint's scope, and a
    // crash here is genuine diagnostic signal (a corrupted install) that
    // must stay visible, not be silently discarded.
    if (silentOnFailure) {
      process.exit(0);
      return;
    }
    process.exit(typeof result.status === 'number' ? result.status : 1);
  } catch {
    if (isPreToolUse) {
      denyPreToolUse('KRYLO project hook launcher hit an unexpected error and denied as a fail-safe.');
      return;
    }
    if (silentOnFailure) {
      process.exit(0);
      return;
    }
    process.exit(1);
  }
}

main();
