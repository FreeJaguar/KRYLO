# Codex Lifecycle Enforcement Implementation Plan

- Plan date: 2026-09-02
- Repository: `FreeJaguar/KRYLO`
- Baseline branch: isolated `feat/codex-lifecycle-enforcement`, created from `feat/codex-vscode-enforcement` @ `84de91d8fdd03ca87c4dfc635769d90eb9b56f21`
- Governing ADR: `docs/adr/0033-codex-lifecycle-enforcement.md`
- Governing design: `docs/process/CODEX_LIFECYCLE_ENFORCEMENT_DESIGN.md`

## 1. What already exists (reused, not reimplemented)

- `scripts/orbit/stop-gate.mjs`: the exact decision logic Section 3 of the design doc reuses. `scripts/orbit/stagnation.mjs`'s `assessStagnation`, `scripts/lib/state.mjs`'s `completionEval`/`loadState`/`saveState`/`clearActiveRunPointerForState`: all host-neutral, unchanged.
- `scripts/host/claude/hook-transport.mjs`'s `emitClaudeStopBlock`/`allowClaudeSilently`: the exact output-shape precedent `emitCodexStopBlock` mirrors.
- `scripts/host/codex/context.mjs`/`hook-transport.mjs`, `scripts/lib/hook-utils.mjs`'s `resolveActiveRun`/`readStdinJson`: unchanged, reused directly.
- `plugins/krylo/hooks/codex-hooks.json`, `codex/project-hooks/codex-project-hook-launcher.mjs`, `install-codex.mjs --target hooks`: extended, not replaced (ADR-0032's own event tables gain three more rows).
- `risk-policy.mjs`'s `HOOK_ENTRYPOINT_FILENAMES`, `touchesCodexProjectHooks()`: extended (new filenames added to the list; the directory-scoped `.codex/krylo/` check already covers any new file placed there with no further change).

## 2. Task 1: ADR and design docs

`docs/adr/0033-codex-lifecycle-enforcement.md` (next unused number, verified against the real `docs/adr/` listing, not assumed), `docs/process/CODEX_LIFECYCLE_ENFORCEMENT_DESIGN.md`, this implementation plan.

## 3. Task 2: Codex Hook transport additions

`scripts/host/codex/hook-transport.mjs`:
- `emitCodexStopBlock(reason)`: `{"decision":"block","reason":reason}`, exit 0. No `continue` field (confirmed precedence: `continue:false` overrides `decision:"block"`, ADR-0033).
- `emitCodexSessionStartContext(text)`: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":text}}`, exit 0.
- `allowCodexSilently()`: already exists, reused for every SessionEnd exit path (SessionEnd has no output schema at all -- confirmed 404 on `session-end.command.output.schema.json`).

## 4. Task 3: Stop gate (security-critical)

New `scripts/orbit/stop-gate-codex.mjs`, structural mirror of `scripts/orbit/stop-gate.mjs`: same imports from `scripts/lib/state.mjs`/`scripts/orbit/stagnation.mjs`/`scripts/lib/lock.mjs`/`scripts/lib/paths.mjs`/`scripts/lib/telemetry.mjs`, same `finalize()`/`buildDelta()` helpers (`buildDelta` reused verbatim, or imported/shared if extraction is cheap and safe -- decided during implementation without breaking the Claude gate). Adds the `stop_hook_active` check (Codex's own field, same semantics as Claude's) before `resolveActiveRun`. Emits via `emitCodexStopBlock`/`allowCodexSilently` instead of the Claude equivalents.

## 5. Task 4: SessionStart handler

New `scripts/security/session-start-codex.mjs`. Parses the Codex `SessionStart` payload (`session_id`, `cwd`; `source`/`model`/`permission_mode` read but not required for the decision), resolves the active run read-only, emits `additionalContext` only when active+non-terminal+session-matched, otherwise silent allow. Never imports anything capable of creating or mutating run state.

## 6. Task 5: SessionEnd handler

New `scripts/status/session-end-codex.mjs`. Single locked read of the resolved active run; if non-terminal, one `recordEvent()` write; otherwise no-op. No import of `scripts/runtime/cleanup.mjs`. Kept intentionally minimal given the confirmed ~1-3 second platform timeout (ADR-0033).

## 7. Task 6: Registration (plugin-bundled and project-scoped)

- `plugins/krylo/hooks/codex-hooks.json`: add `Stop`, `SessionStart`, `SessionEnd` entries, `command`/`commandWindows` pointing at the three new scripts via `${PLUGIN_ROOT}`/`%PLUGIN_ROOT%`, matching the existing three entries' exact convention. Update the file's own header comment to reflect six registered events instead of three.
- `install-codex.mjs`: extend `HOOK_EVENTS`, `EVENT_LAUNCHER_ARG` in the same file (already generic over the array, so `krylOwnedEntryFor`/`classifyEventOwnership`/`planHooksInstall`/`removeHooks` need no further per-event special-casing -- verified during implementation, not assumed).
- `codex-project-hook-launcher.mjs`: extend `EVENT_SCRIPTS` with `stop`/`session-start`/`session-end` argv keys, following the existing missing-runtime fail-direction convention per event (Stop follows PreToolUse's existing "cannot safely determine, so..." pattern, but resolved toward the SAFE-for-Stop direction confirmed in ADR-0033: silent allow, not deny -- Stop and PreToolUse have opposite safe-fail directions, and the launcher must encode the correct one for each).

## 8. Task 7: Hook-entrypoint tamper protection

`risk-policy.mjs`'s `HOOK_ENTRYPOINT_FILENAMES`: add `stop-gate-codex.mjs`, `session-start-codex.mjs`, `session-end-codex.mjs`.

## 9. Task 8: Tests (TDD, land with each task above)

Per the design doc Section 6. New files: `tests/hooks/stop-gate-codex.test.mjs`, `tests/hooks/session-start-codex.test.mjs`, `tests/hooks/session-end-codex.test.mjs`. Extended: `tests/setup/install-codex-hooks.test.mjs`, `tests/hooks/codex-project-hook-launcher.test.mjs`, `tests/unit/risk-policy.test.mjs`.

## 10. Task 9: Documentation

Update: `docs/codex-capability-matrix.md` (resolve the three deferred rows with real evidence categories), `docs/07-hooks-and-observability.md` (Codex Hook transport section), `ARCHITECTURE.md`/`PRODUCT_SPEC.md`/`SECURITY.md`/`THREAT_MODEL.md` only where behavior genuinely changed, `docs/process/FILE_MANIFEST.md`, `CHANGELOG.md` (`[Unreleased]`), `README.md` only if user-visible setup instructions changed. `CLAUDE.md` verified at/below 130 physical lines (no edit expected).

## 11. Task 10: Validation and review

`git diff --check`, `npm run syntax`, `npm run validate:runtime`, focused new/changed test files, full `npm test`, `claude plugin validate --strict`, `codex execpolicy check` (rules unchanged, sanity re-run only), release-manifest regeneration (from an already-committed HEAD, learned from the prior checkpoint's own mistake -- generate only after the corresponding code/doc commit lands). Independent Verifier, Reviewer, Security Reviewer against the final diff; fix Critical/High findings in scope; re-review after any review-driven fix before stopping.

## 12. Explicitly out of scope

`SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact` for Codex. Any change to `require-approval`/`PreToolUse` semantics. Any change to ADR-0032's ownership/merge mechanism beyond adding three more managed events. Live authenticated Codex session testing (environment-blocked). Push/merge/tag/release/publish/deploy.
