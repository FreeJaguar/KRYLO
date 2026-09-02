# Codex Runtime Compatibility Gate -- Implementation Plan

Companion to `docs/adr/0034-codex-runtime-compatibility-gate.md` and `docs/process/CODEX_RUNTIME_COMPATIBILITY_GATE_DESIGN.md`. TDD, one logical commit per task.

## Reused, unchanged

- `scripts/lib/version-compare.mjs` (`parseCodexVersion`, `compareParsed` not needed -- exact match only).
- `scripts/lib/spawn-platform.mjs` (`platformSpawnTarget`).
- `scripts/lib/state.mjs` (`createInitialState`, `saveState`).
- `scripts/security/risk-policy.mjs`'s `touchesPluginInstallation()` (new contract file lives under `pluginRoot`, zero code change needed there).
- `tests/fixtures/cross-harness/fake-worker.{sh,cmd}`'s wrapper SHAPE (not the file itself -- a new, purpose-named fixture pair).

## New files

1. `plugins/krylo/policies/codex-runtime-compatibility.json` -- the reviewed contract (see design doc for exact shape). One `supported` entry: `0.120.0`.
2. `plugins/krylo/scripts/host/codex/runtime-compat.mjs` -- `loadCompatibilityContract()`, `probeCodexVersion()`, `evaluateCodexRuntimeCompatibility()`.
3. `plugins/krylo/tests/fixtures/codex-runtime-compat/fake-codex-cli.mjs` + `.sh` + `.cmd` -- deterministic fake CLI, `FAKE_CODEX_VERSION_OUTPUT`/`FAKE_CODEX_EXIT_CODE`/`FAKE_CODEX_DELAY_MS` env-controlled.
4. `plugins/krylo/tests/unit/runtime-compat.test.mjs` -- pure unit coverage of the decision table.

## Modified files

1. `plugins/krylo/scripts/security/user-prompt-submit-codex.mjs` -- gate call inserted per the design doc's integration section.
2. `plugins/krylo/scripts/security/risk-policy.mjs` -- `HOOK_ENTRYPOINT_FILENAMES` gains `'runtime-compat.mjs'`.
3. `plugins/krylo/tests/hooks/user-prompt-submit-codex.test.mjs` -- new gate-blocking/gate-passing cases, `KRYLO_CODEX_CLI_PATH` wired through `codexOnlyEnv()` in `tests/hooks/helpers.mjs`.
4. `plugins/krylo/tests/unit/risk-policy.test.mjs` -- new entrypoint-protection and policy-file-protection cases.
5. `docs/codex-capability-matrix.md`, `docs/07-hooks-and-observability.md`, `SECURITY.md`, `THREAT_MODEL.md`, `docs/process/FILE_MANIFEST.md`, `CHANGELOG.md` -- updated only where behavior actually changed.

## Task sequence

1. `parseCodexVersion`/contract-loading unit tests (malformed JSON, missing file, wrong schema version, non-array fields, missing `version` field) -- red, then `loadCompatibilityContract()`.
2. `probeCodexVersion()` unit tests against the fake-CLI fixture (success, non-zero exit, malformed stdout, missing executable, timeout) -- red, then implementation.
3. `evaluateCodexRuntimeCompatibility()` unit tests covering the full decision table -- red, then implementation (composes 1+2, adds exact-match lookup).
4. `risk-policy.mjs` entrypoint-protection regression test for `runtime-compat.mjs` -- red, then the one-line `HOOK_ENTRYPOINT_FILENAMES` addition; plus a policy-file-protection case for the new JSON file (should already pass via `touchesPluginInstallation()` -- a regression test proving it, not a code change).
5. `user-prompt-submit-codex.mjs` integration tests -- red (gate not wired yet): supported version bootstraps normally; unverified/blocked/probe-failed version reaches `SAFE_BLOCKED` with a finding and no active pointer; ordinary prompt unaffected; resume-of-active-run unaffected (gate not even consulted); model-supplied prompt content cannot influence the verdict. Then wire the gate into the hook.
6. Full regression: existing `stop-gate-codex.test.mjs`, `session-start-codex.test.mjs`, `session-end-codex.test.mjs`, `codex-project-hook-launcher.test.mjs`, `risk-gate-codex.test.mjs` (if present) re-run unmodified, confirmed still green.
7. Docs pass: capability matrix new row, `07-hooks-and-observability.md` note on the new pre-bootstrap check, `SECURITY.md`/`THREAT_MODEL.md` control entries, `FILE_MANIFEST.md`, `CHANGELOG.md`.
8. Full validation suite (see task's own VALIDATION section) + independent Verifier/Reviewer/Security Reviewer + `RELEASE_MANIFEST.json` regeneration as its own final commit.

## Minimum test coverage cross-reference

Every item in the task's own MINIMUM TEST COVERAGE list maps to a specific test above:

- supported/blocked/unverified-newer/unverified-older -> Task 3 (decision table).
- missing Codex/malformed version/executable failure/timeout -> Task 2.
- malformed registry/unsupported registry schema -> Task 1.
- model cannot override / prompt cannot alter -> Task 5 (the gate never reads `payload.prompt`; a test asserts a fabricated-compatibility-claim prompt has zero effect on the verdict).
- `$krylo-run` blocked when unverified / ordinary session stays ordinary / diagnostic fallback never autonomous -> Task 5.
- existing UserPromptSubmit isolation / PreToolUse hard-deny / require-approval fail-closed / Stop-SessionStart-SessionEnd / project-hook enforcement all remain intact -> Task 6 (unmodified regression, not new tests).
- Windows/POSIX paths and process spawning -> the fake-CLI fixture's OS-wrapper pair (Task 2/5), same proven shape as the existing Cross-Harness fixture.
- registry/tamper-sensitive files protected -> Task 4.
- Claude host unchanged -> Task 6 (no Claude file touched by this checkpoint at all).
