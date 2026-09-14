# ADR-0035: Live Codex hook verification, and the two defects it found

## Status

Accepted

## Context

Every Codex checkpoint so far (ADR-0029, ADR-0032, ADR-0033, ADR-0034) disclosed the same environment-blocked gap in `docs/codex-capability-matrix.md`: no authenticated Codex session was available, so whether KRYLO's Codex hooks actually fire had never been observed — only inferred from schema and source inspection. Each ADR was explicit that this was disclosed, not assumed closed ("Do not claim Codex hook enforcement is confirmed live until that test runs").

That test has now run. An authenticated Codex CLI became available on the development machine (`codex login status` → "Logged in using ChatGPT"), and this checkpoint ran the deferred smoke test against a real session.

It found that **KRYLO's Codex host had never actually worked** — on any build, on Windows — for two independent reasons, both of which silently disabled the entire hook set including the `PreToolUse` risk gate. Both are fixed here, and both are now proven fixed by a real session.

## Method (what was actually run, and where)

- **Isolated by construction.** A temporary `CODEX_HOME` (with only `auth.json` copied in), a throwaway project directory, an isolated `KRYLO_DATA_ROOT`, and — for the standalone-runtime path — an isolated `KRYLO_TEST_HOME`. The real `~/.codex` was never written to by this checkpoint. One deviation is disclosed under "Process note" below.
- **Non-interactive, read-only.** Every session was `codex exec --sandbox read-only --skip-git-repo-check`. Hook trust, which is otherwise an interactive `/hooks` review flow with no CLI equivalent on this build, was granted for the sandbox only via `--dangerously-bypass-hook-trust`; project trust via a `[projects."…"] trust_level = "trusted"` entry in the sandbox `config.toml`.
- **Binary identity, stated explicitly.** Two Codex CLIs are installed on this machine: the native installer's (`…/AppData/Local/Programs/OpenAI/Codex/bin/codex`, `0.153.4`, which a bare `codex` in an interactive shell resolves to) and npm's (`…/AppData/Roaming/npm/…/@openai/codex`, `0.154.0`, which KRYLO's own `spawn-platform.mjs` resolution selects). **Every result below was observed against `codex-cli 0.154.0`**, the one KRYLO itself probes. That divergence is itself a finding (see below).

## Finding 1 (critical): the hooks config shape changed, and a rejected config is dropped in full

The first real session emitted, before any model call:

```text
warning: failed to parse plugin hooks config …\hooks\codex-hooks.json:
  unknown field `$comment`, expected `description` or `hooks` at line 2 column 12
```

The current build accepts exactly two top-level keys — `description` and `hooks` — with the event map nested under `hooks`. KRYLO's file used a flat top-level event map plus a `$comment` key. The parse fails at the first unrecognized key and **the entire file is discarded**: every registration, `PreToolUse`'s risk gate included. This is precisely the fail-open outcome that file's own comment warned about for a different reason (an unrecognized *event*), reached instead through an unrecognized *top-level key* — and the `$comment` that carried the warning was itself the trigger.

The same rejection applies to the project-scoped `.codex/hooks.json` that `install-codex.mjs --target hooks` writes (ADR-0032), confirmed by a separate controlled run that varied shape and project-trust independently:

```text
warning: failed to parse hooks config …\project\.codex\hooks.json:
  unknown field `UserPromptSubmit`, expected `description` or `hooks` at line 2 column 20
```

So ADR-0032's entire VS Code enforcement path was silently inert as well. A document carrying only `hooks` (no `description`) is accepted — verified — so the nesting, not the description, is what matters.

## Finding 2 (critical): `%PLUGIN_ROOT%` is never expanded, and Windows prefers `commandWindows`

With the shape fixed, hooks began firing — and failed:

```text
hook: SessionStart
hook: SessionStart Failed
hook: UserPromptSubmit
hook: UserPromptSubmit Failed
```

A diagnostic probe hook (recording its own `argv`, `cwd`, environment and stdin) established the mechanism directly, across three controlled variants:

| Variant | Field used | Placeholder | Observed `argv` |
|---|---|---|---|
| A | `command` + `commandWindows` | `%PLUGIN_ROOT%` in `commandWindows` | literal `%PLUGIN_ROOT%` |
| B | `command` only | `${PLUGIN_ROOT}` | fully expanded real path |
| C | `command` + `commandWindows` | `${PLUGIN_ROOT}` in both | fully expanded real path (and `commandWindows` is the one chosen) |

Codex performs its **own** `${PLUGIN_ROOT}` templating and never invokes a shell, so the cmd.exe-style `%PLUGIN_ROOT%` form is passed through as a literal string. On Windows it prefers `commandWindows` when present. KRYLO supplied `${PLUGIN_ROOT}` in `command` and `%PLUGIN_ROOT%` in `commandWindows` — so on Windows every hook resolved to a path literally named `%PLUGIN_ROOT%\scripts\…`, which does not exist, and every hook failed. Variant C is the fix.

## Confirmed working, with evidence

- **Hooks fire.** `hook: SessionStart Completed` / `hook: UserPromptSubmit Completed` observed live. `features list` on this build shows `hooks  stable  true` (the old `codex_hooks  under development  false` row that ADR-0029 recorded as an unresolved discrepancy is gone; a separate `plugin_hooks` row now reads `removed`).
- **`PLUGIN_ROOT` and `PLUGIN_DATA` are injected** into the hook process, exactly as ADR-0029 assumed.
- **Codex also injects `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`** aliases with the same values. KRYLO's `detectHost()` already anticipated precisely this ("the presence of the ALIAS variables alone is NOT sufficient to prove this is a genuine Claude invocation") and checks the Codex-native variables first, so a Codex session is still correctly identified as Codex. That documented assumption is now confirmed against a real session rather than assumed.
- **The `UserPromptSubmit` payload matches** what `user-prompt-submit-codex.mjs` expects: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `prompt`.
- **End-to-end bootstrap works on both paths.** A real `$krylo-run …` prompt produced a real on-disk KRYLO run bound to the genuine host session id — via the plugin-bundled path (`run-b4e04766a032`) and, separately, via the project-scoped launcher plus standalone runtime (`run-6df0dd14c3a5`).
- **The Codex Runtime Compatibility Gate (ADR-0034) works live.** Both runs terminated `SAFE_BLOCKED` with a `high` finding naming the unreviewed runtime (`0.154.0`), and wrote the bootstrap-failure marker — which also constitutes live confirmation of the marker fix recorded in ADR-0034's own "Correction" section.

## Still not verified (disclosed, not assumed)

- **`PreToolUse` deny has not been observed live.** Triggering it requires the model to attempt a tool call, and every session in this checkpoint ended at `ERROR: Your workspace is out of credits. Add credits to continue.` before the model ran. Everything up to and including `UserPromptSubmit` executes before that point, which is why the bootstrap results above are real; the gate's own decision path remains fixture-verified only.
- **Hook trust and project trust were bypassed/preconfigured**, not exercised through their real interactive review flows.
- **`Stop`, `PostToolUse`, `SessionEnd` firing** were likewise not reached (all are post-model-call events).
- **Nothing here was verified against `0.153.4` or `0.120.0`.** The shapes proven above are `0.154.0`'s. Whether the nested shape also parses on `0.120.0` — the only version in KRYLO's reviewed compatibility contract — is **unknown**, and this checkpoint deliberately did not change that contract (per ADR-0034: adding or moving a supported version is a reviewed, human-made decision, not a side effect).

## Decision

1. `plugins/krylo/hooks/codex-hooks.json` moves to the accepted shape (`description` + nested `hooks`) and uses `${PLUGIN_ROOT}` in `commandWindows` as well as `command`.
2. `install-codex.mjs`'s project-hook install/remove read and write the same nested shape, preserving every unrelated top-level key and unrelated event entry exactly as before.
3. A pre-existing project `hooks.json` in the **legacy flat shape is refused**, with a precise explanation, rather than silently half-migrated into a hybrid document that the build would still reject in full. KRYLO does not rewrite the structure of a file it does not own.
4. Both defects get structural regression tests (`tests/governance/hook-scoping.test.mjs`): the top-level shape is asserted exactly, and `%PLUGIN_ROOT%` is banned outright with the reason stated.

## Consequences

- KRYLO's Codex host goes from "never actually functional on Windows" to "bootstrap proven live on both hook paths", on the build KRYLO itself probes.
- The capability matrix's long-standing `blocked by platform` and `Unresolved discrepancy` rows are replaced with observed evidence — including the negative results above, which remain disclosed.
- **The dual-install version divergence is now a documented operational hazard**: a human running `codex` interactively may be on `0.153.4` while KRYLO's compatibility gate probes npm's `0.154.0`. Any future contract change must name the exact binary its evidence came from.
- No change to the compatibility contract, the approval boundary, the risk-gate classification logic, or any Claude-host behavior.

## Process note (disclosed rather than omitted)

One `install-codex.mjs --target skill --apply` was run without `KRYLO_TEST_HOME`, so it targeted the real `~/.agents/skills` rather than the sandbox — contrary to this checkpoint's own isolation rule. Verified afterwards: the live install was unchanged (`SKILL.md` mtime unchanged, no new `.backup-*`, no leftover `.new-*` staging directory), because the atomic staging path introduced for exactly this class of risk left the existing install untouched. The step was then redone correctly under an isolated `KRYLO_TEST_HOME`.

## Supersedes

None. Corrects a factual capability claim in `docs/codex-capability-matrix.md` and closes the live-verification gap ADR-0029/0032/0033/0034 each disclosed. Does not modify ADR-0034's compatibility contract or its decision.

## Superseded by

None.
