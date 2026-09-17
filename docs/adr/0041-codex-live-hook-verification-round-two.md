# ADR-0041: Codex live hook verification, round two -- five defects found by actually running it

## Status

Accepted

## Context

ADR-0035 attempted live verification of the Codex host's hooks and reached only as far as `UserPromptSubmit`: every session in that checkpoint ended at `ERROR: Your workspace is out of credits` before the model ever produced a turn. `SessionStart`, `SessionEnd`, `Stop`, and the `PreToolUse` deny path all remained fixture-verified only, and the Codex capability matrix disclosed that gap explicitly in four separate rows.

Credits were restored. This ADR is what actually happened when the verification ran to completion: it found five distinct, previously-undiscovered defects, several of them load-bearing enough that the entire `$krylo-run` Codex workflow could not have completed a single real invocation before this checkpoint. None of them were reachable by reasoning about the code; each was found by running it and then explaining why the result was wrong.

## Finding 1: the installed hooks config was silently rejected, wholesale

The very first live probe printed:

```
warning: failed to parse plugin hooks config ...codex-hooks.json: unknown field `$comment`, expected `description` or `hooks`
```

The installed Codex plugin cache (`~/.codex/plugins/cache/krylo-marketplace/krylo/0.2.0/hooks/codex-hooks.json`) still held the OLD flat shape (`$comment` at the top level, event names as direct top-level keys) from before an earlier checkpoint restructured the committed file to `{description, hooks: {...}}`. Codex rejected the whole file for the unrecognized top-level key, which means **every one of KRYLO's Codex hooks -- UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd -- was silently non-functional** on this installation. The `hook: SessionStart` / `SessionStart Completed` lines visible in that first probe were Codex's own built-in session lifecycle notification, unrelated to KRYLO, since the config parse had already failed.

This mirrors the exact class of drift already described in ADR-0034's compatibility gate story: an installed plugin cache going stale relative to its source, invisibly. Unlike a version-mismatch, a parse failure here has no gate checking for it at all -- the fix was `codex plugin add krylo@krylo-marketplace` (verified afterward: the installed hooks file's top-level keys became exactly `['description', 'hooks']`, and all 12 of this machine's other plugin registrations in `config.toml` remained intact).

**Consequence for setup documentation:** `install-codex.mjs`/`/krylo:doctor` do not currently detect this class of drift for a plugin-bundled install (only for the project-scoped hooks path). Recorded as a follow-up, not fixed in this checkpoint.

## Finding 2: hooks beyond SessionStart require a persisted "hook trust" grant that `codex exec` can never establish

With the cache fixed, `UserPromptSubmit` and `Stop` still never fired -- confirmed directly: `read-state.mjs`, queried against every session id from six consecutive live probes, returned `no-current-run` for every single one. Only `SessionStart` ever printed as `Completed`.

The CLI's own `--dangerously-bypass-hook-trust` flag documents the mechanism: hooks require "persisted hook trust" before they run, and this flag runs them "without review for this invocation... intended only for automation that already vets hook sources." With it set, `UserPromptSubmit` and `Stop` immediately began firing. `config.toml`'s `[hooks.state.*]` section confirmed the shape: keyed entries recording a `trusted_hash` per plugin/hooks-file/event, present for other installed plugins (`superpowers@claude-plugins-official`, a bare `~/.codex/hooks.json`) but **absent entirely for `krylo@krylo-marketplace`**, for every event including `session_start` -- meaning `SessionStart` alone is exempt from the trust requirement (or defaults to allowed absent an entry), while every other event is silently skipped without it.

No subcommand exists to grant this trust non-interactively (`codex plugin`, `codex hooks`, and `codex --help` were all checked). The mechanism appears to require establishing trust once through the interactive TUI, which a headless `codex exec` invocation -- exactly how this project's own `SKILL.md` documents `$krylo-run` being used -- can never satisfy on a first run.

**This is the most severe of the five findings in terms of blast radius.** A real user's very first `$krylo-run` invocation via `codex exec` would bootstrap nothing, enforce nothing, and give **zero visible signal that anything was wrong** -- `SessionStart Completed` prints normally, and the model proceeds as an ordinary, ungoverned chat session believing it is operating under KRYLO. Disclosed here as a confirmed platform behavior; not fixed in this checkpoint, since there is no non-interactive alternative to disclose in its place beyond the dangerous bypass flag itself. `docs/codex-capability-matrix.md` and setup documentation should carry this prerequisite explicitly rather than leave it undiscoverable.

## Finding 3: `${PLUGIN_ROOT}` in the Skill body is not a shell-resolvable variable, and every command in it depends on it

With hook trust bypassed, `UserPromptSubmit` bootstrapped correctly and the model reached its own turn. `krylo-run/SKILL.md` instructs every runtime CLI call as `node "${PLUGIN_ROOT}/scripts/runtime/....mjs" ...`. Confirmed by reading the model's own loaded Skill content back verbatim (it genuinely contains the raw, unsubstituted token) and then by direct probe: the model's own PowerShell `exec` call resolved `$env:PLUGIN_ROOT` to an **empty string**, producing `Cannot find module 'C:\scripts\runtime\...'`.

`PLUGIN_ROOT` is populated only inside the environment Codex constructs for its OWN registered hook commands (`hooks/codex-hooks.json`'s `command`/`commandWindows` templating) -- confirmed by grepping the hooks config, where it appears exclusively inside those fields. It is never exposed to the shell the model's own `exec` tool calls run in, which is a materially different execution context. The project-scoped hook launcher (`codex/project-hooks/codex-project-hook-launcher.mjs`) already documents this exact constraint in its own header comment and solves it with a fixed conventional install location; the plugin-bundled Skill never received the equivalent fix, because the plugin-bundled path has no fixed location (it is versioned, under the Codex plugin cache).

**Fix:** `user-prompt-submit-codex.mjs`'s `additionalContext` now includes `identity.pluginRoot` as a literal, absolute value on every success path (fresh bootstrap and idempotent reuse), and `SKILL.md` instructs substituting it verbatim rather than resolving it from the environment. Regression-tested (`tests/hooks/user-prompt-submit-codex.test.mjs`): the literal value is asserted present in both message shapes.

## Finding 4: fixing Finding 3 exposed cross-host state corruption

Fixing PLUGIN_ROOT alone let the model correctly invoke `read-state.mjs` -- and that call, run in a shell with neither `PLUGIN_ROOT` nor `PLUGIN_DATA` present, fell through `host-dispatch.mjs`'s `detectHost()` to `'claude'` and its default data root, **silently reading back a completely unrelated Claude-host run active on the same machine at the time** (this investigation's own driving Claude session). The model's follow-on `update-state.mjs --terminal SAFE_BLOCKED` call would have overwritten that unrelated run's terminal state; a concurrent file lock on the same state file -- held by this very investigation issuing its own `update-state.mjs` calls at the same moment -- is the only reason it did not. Confirmed by direct inspection: the run this live session actually created was found at `~/.codex/plugins/data/krylo-krylo-marketplace/runs/<runId>` (the real, Codex-native `PLUGIN_DATA`-derived location the hook subprocess resolves), never at the Claude default the model's own commands were reading.

`detectHost()` is designed to treat native Codex-only env vars as conclusive proof of a Codex invocation, on the correct premise that Claude Code never sets them -- but its two signals (`PLUGIN_ROOT`, `PLUGIN_DATA`) are both scoped to Codex's own hook-command environment, never the model's own `exec` environment, a distinction the original design did not draw.

**Fix, part one:** `detectHost()` now also recognizes `CODEX_THREAD_ID` -- confirmed directly present in the model's own `exec` environment via a separate probe, and already trusted elsewhere in this codebase (`resolveCodexSessionId`'s identical fallback, for the identical reason) -- as a sufficient, Codex-exclusive signal. Regression-tested in a new `tests/unit/host-dispatch.test.mjs`, including the exact session id from the live reproduction.

**Fix, part two:** the `UserPromptSubmit` bootstrap message instructs the model to set `KRYLO_HOST=codex` inline on every runtime CLI call, as defense in depth beyond the ambient `CODEX_THREAD_ID` signal.

## Finding 5: the first fix for Finding 4 was itself unusable, and the real fix needed no input from the model at all

The obvious complete fix -- hand the model `identity.dataRoot` as a second literal value, and instruct `KRYLO_DATA_ROOT=<literal>` inline alongside `KRYLO_HOST=codex` -- was implemented, tested, and then found live to fail differently: **any Bash/PowerShell command whose text contains the real data-root path is unconditionally denied** by this project's own `touchesDataRoot()` sensitive-path protection (`risk-policy.mjs`), which exists specifically to stop a model from bypassing the runtime scripts and reaching KRYLO's control-plane state directly, and which is deliberately blunt ("deny outright rather than attempting to classify") rather than trying to distinguish a legitimate reference from a malicious one. The live transcript showed the model correctly constructing and issuing the exact instructed command, and KRYLO's own Codex-side `risk-gate-codex.mjs` correctly denying it with that exact message -- a genuine confirmation that the sensitive-path control works identically on the Codex host as on Claude, and an equally genuine confirmation that the fix built on top of it could never work.

Carving a safe exception into that control -- "allow this path substring only when the invoking program is `node` and the script argument is one of KRYLO's own runtime CLIs, with nothing else chained" -- is its own security review; against a shell surface this project's own history (ADR-0022's `2.1.223` floor, raised specifically because "a crafted command could hide parts of itself from permission checks") treats as genuinely adversarial, it was not attempted here.

**The actual fix needs nothing from the model at all.** `resolveCodexPluginRoot()` already self-derives correctly with zero env vars, from its own `import.meta.url` -- the model only ever needs the plugin-root value because it has no other way to construct the invocation path in the first place, an unavoidable need. The data root has no equivalent unavoidable need, so `host/codex/context.mjs` gained `deriveCodexDataRootFromPluginRoot()`: from an empirically observed real installation, the pattern `.../plugins/cache/<marketplace>/<plugin>/<version>` (plugin root) has a sibling `.../plugins/data/<plugin>-<marketplace>` (data root). `resolveCodexDataRoot()` now tries this derivation as a fallback tier below the existing `KRYLO_DATA_ROOT`/`PLUGIN_DATA` overrides, and only when the derived path names a directory that genuinely already exists (`fs.existsSync` plus `isDirectory()`) -- a layout that does not match (a different install method, a future Codex version) falls straight through to the pre-existing home-directory default rather than pointing at a guess. This is disclosed as a best-effort hint about Codex's own undocumented on-disk layout, not a contract KRYLO controls.

The `identity.dataRoot` literal and the `KRYLO_DATA_ROOT` instruction were removed from the hook message and from `SKILL.md`, replaced with an explicit, active warning never to reference a data-root path in any command.

## Verified live, end to end, after all five fixes

A final live session (hook trust bypassed, `--sandbox workspace-write`) drove the complete loop through the real installed binary:

- `UserPromptSubmit` bootstrapped a real run at the correct, Codex-native `PLUGIN_DATA`-derived location.
- The model constructed `node "<literal pluginRoot>/scripts/runtime/read-state.mjs"` with `$env:KRYLO_HOST='codex'` inline, exactly as instructed, and it returned **the correct run**, `"host":{"name":"codex","sessionId":"<the real session id>"}` -- resolved entirely through self-derivation, no data-root string anywhere in the command.
- `PreToolUse` fired and allowed a benign command (`git status`), fired and **denied** `git push origin HEAD` with KRYLO's own production-policy reason text verbatim (the first-ever live confirmation of this deny path; ADR-0035 never reached it) and fired and allowed the two runtime CLI calls above.
- `PostToolUse` fired after every tool call.
- `Stop` fired, at least once returning `Blocked` (the run's terminal state was not yet set) and Completed once it was.

`update-state.mjs --terminal SAFE_BLOCKED` hit a transient `lock-timeout` against the real run's state file during this specific probe -- explained by this investigation's own concurrent `read-state.mjs`/`update-state.mjs` calls against the same file from a separate debugging session at the same time, not a defect in the lock itself (no lock implementation, no timeout duration change made). Confirmed the lock file did not remain afterward.

`SessionEnd` was never observed firing in any `codex exec` invocation in this checkpoint, hook trust bypassed or not. Disclosed as still unverified specifically for the non-interactive `exec` path; the capability matrix's existing description of a ~1-3 second platform teardown timeout for this event may mean `codex exec`'s own process exit does not wait for it the way an interactive session's would -- not confirmed either way in this checkpoint.

## Decision

Ship all fixes for Findings 3, 4, and 5 (the ones a code change can actually close). Disclose Findings 1 and 2 as confirmed platform behavior with no code-level fix available from KRYLO's side: Finding 1's mitigation is operational (`codex plugin add` to refresh a stale cache; a future `/krylo:doctor` check is a real follow-up, not done here); Finding 2 has no non-interactive alternative to `--dangerously-bypass-hook-trust` to offer.

## Round 3: an independent review found two more, inside the fixes above

Given how many defects the live-fire investigation itself had already surfaced, an independent review of this checkpoint's own diff was dispatched before merge -- explicitly because a subsystem that has already produced five defects across two rounds earns a third look, not the benefit of the doubt. It found two real, actionable ones, both fixed here.

**Finding 6 (the Finding 5 fix reopened Finding 4, narrower and worse).** `resolveCodexDataRoot()`'s derivation called `resolveCodexPluginRoot(env)`, which honours `env.PLUGIN_ROOT` when present. `PLUGIN_ROOT` is a generic-sounding name unrelated tooling might set in good faith, and an attacker who could set it to a directory shaped like a real Codex install (`.../plugins/cache/<marketplace>/<plugin>/<version>`, with a matching `.../plugins/data/<plugin>-<marketplace>` sibling they also control) could redirect KRYLO's entire control plane -- run state, question grants, risk approvals -- to a location they own. The branch is reached only when `PLUGIN_DATA`/`KRYLO_DATA_ROOT` are both absent, which is also exactly the model's own legitimate exec environment, where `PLUGIN_ROOT` is equally absent (Finding 3) -- so `env.PLUGIN_ROOT` being set there at all means either a genuine hook environment (already returned earlier, via `PLUGIN_DATA`) or exactly this attack; no legitimate case needs it. Fixed: derivation now always uses the module's own self-derived `PLUGIN_ROOT_FROM_SOURCE`, never the env-aware resolver -- the same principle that already made the plugin root itself safe to hand the model in Finding 3 now applies to the data root's own derivation. The review also found the existing regression test for this exact code path was itself exercising the now-closed vulnerable path (an env-supplied `PLUGIN_ROOT` triggering derivation), not the real mechanism -- corrected to a security regression proving `env.PLUGIN_ROOT` can never redirect it, plus a genuine end-to-end test that copies the real scripts into a fixture shaped like an actual Codex install and proves self-derivation succeeds with zero environment input, and the equivalent correction to the hook-level end-to-end test the same defect had compromised.

**Finding 7 (Finding 4's own fix left an asymmetric gap on the other host).** Adding `CODEX_THREAD_ID` as a host-detection signal closed one gap and opened its mirror: it is Codex-exclusive under ordinary use, but nothing rules out a Claude session inheriting a stray value (a nested terminal opened inside an active Codex thread, a devcontainer or tmux session that forwards its environment). Claude's own hooks never call `detectHost()` at all, but the shared runtime CLIs do -- so a leaked `CODEX_THREAD_ID` would route a genuine Claude session's own CLI calls to the Codex adapter's data root, find no active run there, and the risk and stop gates would then silently stop enforcing: a governed session with dead enforcement, Finding 4's own failure shape, in the opposite direction. Fixed: a genuine signal that a session really is on the other host now outranks `CODEX_THREAD_ID` alone. Reading that signal directly in `host-dispatch.mjs` would itself have violated this project's Shared-Core host-isolation rule -- enforced by an automated governance check (`validate-runtime.mjs`'s `hostIsolation`), not merely a comment, and it caught this on the first attempt -- so the check moved into the one file already allowed to read it (`host/claude/context.mjs`'s new `hasNativeClaudeSignal()`), exposed to Shared Core as a plain boolean, never the underlying variable. The Claude-side Skill also gained the identical inline host-pinning instruction the Codex Skill already carries from Finding 4, phrased in host-neutral terms to respect that same Skill's own ADR-0021 invariant (verified against the existing governance test enforcing it) against referencing the other host outside its Cross-Harness section.

The review's other four questions were answered without a further code change: the sensitive-path/data-root protection is enforced identically on both hosts (confirmed by tracing both risk gates into the same shared classifier); no other `PLUGIN_ROOT`/`PLUGIN_DATA` usage in the Codex adapter shares Finding 3's class of bug; and the undocumented hook-trust prerequisite (Finding 2) still appears nowhere a real user would see it before hitting it, which remains open exactly as this ADR already discloses.

## Consequences

- `host/codex/context.mjs`: `deriveCodexDataRootFromPluginRoot()` (new, exported for direct test), `resolveCodexDataRoot()` gains one fallback tier, now sourced from `PLUGIN_ROOT_FROM_SOURCE` only (Finding 6).
- `scripts/lib/host-dispatch.mjs`: `detectHost()` recognizes `CODEX_THREAD_ID`, outranked by a genuine Claude-native signal via `hasNativeClaudeSignal()` (Finding 7).
- `scripts/host/claude/context.mjs`: new `hasNativeClaudeSignal()`, the one place allowed to read that host's own env vars, so Shared Core never has to.
- `scripts/security/user-prompt-submit-codex.mjs`: both success messages carry the literal plugin root and an instruction to set `KRYLO_HOST=codex` inline; neither carries a data-root value, and both actively warn against referencing one.
- `codex/skills/krylo-run/SKILL.md`: updated to match, including the active warning against `KRYLO_DATA_ROOT`.
- `skills/run/SKILL.md` (Claude): gained the parallel `KRYLO_HOST=claude` inline instruction, phrased host-neutrally per ADR-0021.
- New tests: `tests/unit/host-dispatch.test.mjs` (6 cases, including Finding 7's regression); `tests/unit/claude-context.test.mjs` gains a direct `hasNativeClaudeSignal()` test; `tests/unit/codex-context.test.mjs` gains 8 cases covering the derivation function, its fallback ordering, Finding 6's security regression, and a genuine end-to-end self-derivation proof via a copied-fixture install; `tests/hooks/user-prompt-submit-codex.test.mjs`'s literal-path regressions assert the data root is ABSENT from both bootstrap messages, plus an end-to-end case that copies the real scripts into a fixture shaped like a genuine Codex install and proves a later call finds the run via self-derivation with zero environment override.
- No change to `codex-runtime-compatibility.json` or any reviewed-version contract.
- `docs/codex-capability-matrix.md` should be updated to move `SessionStart`, `PreToolUse` (both allow and deny), `PostToolUse`, `Stop`, and `UserPromptSubmit`'s full model-turn path from "fixture-verified only" to "verified live," and to add Finding 2's hook-trust prerequisite as a disclosed setup requirement. Left as an immediate follow-up rather than done in this same sweep, to keep this ADR's own record of what was tested separate from the matrix's cumulative summary.

## Supersedes

None. Extends ADR-0035's live-verification record with the results ADR-0035 could not reach, and fixes defects ADR-0029/0032's `${PLUGIN_ROOT}`/host-detection design did not anticipate.

## Superseded by

None.
