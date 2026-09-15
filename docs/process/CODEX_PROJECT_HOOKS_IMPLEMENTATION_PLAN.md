# Codex Project-Scoped Hook Enforcement Implementation Plan

- Plan date: 2026-08-27 (checkpoint continues immediately after `docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md`)
- Repository: `FreeJaguar/KRYLO`
- Baseline branch: isolated `feat/codex-vscode-enforcement`, created from `feat/multi-host-0.2` @ `79f2625676ac4ee9ae866184b8b4f78762a6672c`
- Governing ADR: `docs/adr/0032-codex-project-scoped-hook-enforcement.md`
- Governing design: `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 10.4
- Scope: closes the single disclosed follow-up named in `docs/codex-capability-matrix.md` ("Full VS Code project-scoped hook setup"). Everything else in that matrix is unchanged and out of scope.

## 1. What already exists (not re-implemented)

- `plugins/krylo/scripts/setup/install-codex.mjs`: `--target skill` (standalone Skill copy to `$HOME/.agents/skills/krylo-run/`) and `--target rules` (project-scoped `.rules` generation). Both already implement the dry-run/apply/ownership/backup/rollback/idempotency contract this plan reuses verbatim for `--target hooks`.
- `plugins/krylo/scripts/host/codex/context.mjs` / `hook-transport.mjs`, `scripts/security/risk-gate-codex.mjs`, `scripts/security/user-prompt-submit-codex.mjs`, `scripts/runtime/posttool-telemetry-codex.mjs`: the real enforcement scripts the new launcher delegates to, unchanged.
- `plugins/krylo/hooks/codex-hooks.json`: the plugin-bundled hook registration this checkpoint's project-scoped file deliberately does not duplicate logic from (both ultimately invoke the same scripts).

## 2. Task 1: Platform re-verification

Done before any code change; recorded in ADR-0032. Current stable Codex is `rust-v0.152.1` (installed binary here remains `0.120.0`). Confirmed via direct source inspection at the current stable tag: `tool_name` is no longer const-locked to `"Bash"` (already-forward-compatible, no code change needed); unsupported `permissionDecision` values (`ask`, legacy `approve`) fail OPEN, not merely "hook fails" -- strengthens the existing never-emit-ask design; `deny` remains fully supported and unchanged. Confirmed via current official docs (`learn.chatgpt.com/docs/hooks`): project hooks live at `<repo>/.codex/hooks.json`; `PLUGIN_ROOT`/`PLUGIN_DATA` are plugin-hook-only; hook command paths resolve from the git root; no `${VAR}`-style templating is documented for `command`/`commandWindows` strings for project hooks.

## 3. Task 2: Standalone Skill install now bundles a real runtime

`planSkillInstall`/`removeSkill` in `install-codex.mjs` extended: alongside the existing `codex/skills/krylo-run/` copy, also copy `scripts/`, `references/`, `schemas/`, `policies/` (verbatim, `copyDirRecursive`, already implemented) into the same destination root. No change to `context.mjs`: its existing `PLUGIN_ROOT_FROM_SOURCE` (`import.meta.url`-relative) fallback already resolves correctly once the scripts physically exist at the new location.

## 4. Task 3: Project-scoped hook launcher

New file, generated verbatim by `install-codex.mjs` at apply time: `<project>/.codex/krylo/codex-project-hook-launcher.mjs`. Argv-selected target (`user-prompt-submit` | `pre-tool-use` | `post-tool-use`). Resolves the real runtime root via `KRYLO_STANDALONE_ROOT` override, then `path.join(os.homedir(), '.agents', 'skills', 'krylo-run')` (mirrors `context.mjs`'s own algorithm). Re-executes the corresponding real script from there with `spawnSync`, argv array, `shell:false`, inheriting stdin/stdout/stderr and exit code exactly. If the runtime cannot be located: `pre-tool-use` denies (fail-closed, matches `emitCodexPreToolDeny` output shape directly, since it cannot even determine whether a run is active without the real script); `user-prompt-submit`/`post-tool-use` exit 0 silently (non-security-boundary, matches the established inactive-run no-op contract).

## 5. Task 4: `--target hooks` in `install-codex.mjs`

`planHooksInstall(apply, projectDir)` / `removeHooks(apply, projectDir)`:

- Read `<project>/.codex/hooks.json` (default `{}`) and sidecar `<project>/.codex/krylo-hooks-meta.json`.
- Classify each of the three KRYLO-managed events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`) independently: `absent` (no sidecar record, safe to append), `krylo-owned` (sidecar record deep-equals the live array entry, safe to replace with a backup), `ambiguous` (sidecar record exists but no longer matches live content -- refuse that event's slot).
- Dry-run by default; `--apply` writes `hooks.json`, the sidecar, and `.codex/krylo/codex-project-hook-launcher.mjs`.
- Backup (`hooks.json.backup-<timestamp>`) only on the replace path.
- Report git-tracked/untracked state of `hooks.json` via `git ls-files --error-unmatch <path>` (argv array, `shell:false`). Never touches `.gitignore`.
- `--remove`: deletes only the sidecar-recorded KRYLO entries (refusing per the same ambiguous-ownership rule), reports the backup path if one exists for manual restore.

## 6. Task 5: Tests (TDD, written with each task, not deferred)

`plugins/krylo/tests/setup/install-codex.test.mjs` (extended) and a new `plugins/krylo/tests/setup/install-codex-hooks.test.mjs`, plus a new `plugins/krylo/tests/hooks/codex-project-hook-launcher.test.mjs`, covering at minimum every category the task requires: dry-run makes no filesystem changes; explicit apply; fresh install; foreign hooks-file/ambiguous-entry refusal; KRYLO-owned update with backup; idempotent re-apply; uninstall/rollback/preservation of foreign entries; malformed `hooks.json`; project paths with spaces; Windows command/path contract (`commandWindows` presence, backslash form) and POSIX contract; ordinary non-KRYLO session inert (launcher no-op when no run active); exact `$krylo-run` activation only (reuses existing `user-prompt-submit-codex.test.mjs` coverage through the launcher); prefix collisions (`$krylo-runner`) remain inert; session/run isolation (reuses existing Core isolation tests, exercised through the launcher); PreToolUse hard-deny remains enforced through the launcher; require-approval fail-closed remains enforced through the launcher; missing-runtime fails safe; hook entrypoint tampering (launcher script itself added to `risk-policy.mjs`'s hook-entrypoint-protection list if it is ever a plausible direct-invocation target); no regression to Claude host behavior (full existing Claude suite unchanged).

## 7. Task 6: Documentation

Update: `docs/codex-capability-matrix.md` (resolve the "Documented follow-up" entry with real evidence categories; add current-stable-version drift findings), `ARCHITECTURE.md`/`PRODUCT_SPEC.md`/`SECURITY.md`/`THREAT_MODEL.md` only where behavior genuinely changed, `docs/process/FILE_MANIFEST.md`, `README.md` if the setup CLI surface changed user-visible instructions. `CLAUDE.md` stays at or below 130 physical lines (no change expected; verify by line count after all edits).

## 8. Task 7: Validation

`git diff --check`; `npm run syntax`; `npm run validate:runtime`; focused new/changed test files; full `npm test`; `codex execpolicy check` re-validation (unchanged, `--target rules` untouched); Claude regression (full suite, unchanged files); release-manifest regeneration only if this branch's own governance test requires it before this checkpoint closes (it is an isolated feature branch, not a push/release branch -- verified against the actual test's scope before deciding). Independent Verifier, Reviewer, Security Reviewer against the final diff; fix Critical/High findings in scope; do not reopen unrelated Foundation/Cross-Harness/Ecosystem items.

## 9. Explicitly out of scope for this checkpoint

Cross-Harness, Weekly Upstream Watch, Monthly Ecosystem Radar, 0.2.0 release preparation, any push/PR/merge/tag/release/publish/deploy, the model-facing `SKILL.md` `${PLUGIN_ROOT}` standalone-session UX question (a separate, pre-existing, disclosed gap -- the hook launcher does not depend on it, since hook scripts resolve their own root via `import.meta.url`, not via the model's own shell environment), revisiting ADR-0029's `require-approval`/session-bootstrap design based on the newly-confirmed `allow`+`updatedInput` drift evidence (recorded, not acted on).
