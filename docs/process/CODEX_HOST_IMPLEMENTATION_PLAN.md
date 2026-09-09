# KRYLO Codex Host Implementation Plan

- Plan date: 2026-08-26
- Repository: `FreeJaguar/KRYLO`
- Baseline branch: `feat/multi-host-0.2`
- Baseline commit: `4f13b6b3b59fe48bf6b47484ea0882f3f18ab358`
- Current product version: `0.1.1` (stays `0.1.1` through this checkpoint)
- Governing design: `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` (approved architecture, dated 2026-08-20)
- Governing ADR: `docs/adr/0023-multi-host-product-and-shared-core.md`
- Scope: `MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Phase 3 (native Codex CLI host) and the CLI/plugin-relevant slice of Phase 4 (Codex VS Code bridge). Phases 5-7 (Cross-Harness, weekly Upstream Watch, monthly Ecosystem Radar) and Phase 9 (0.2.0 release) are explicitly out of scope for this checkpoint.

## 1. Verified installed runtime

```text
codex-cli 0.120.0
```

Feature flags observed via `codex -c service_tier=flex features list` (the user's real `~/.codex/config.toml` has an out-of-date `service_tier` value that fails schema validation on this CLI build; not modified by this plan -- see Section 9):

```text
plugins       stable             true
codex_hooks   under development  false   (see Section 2.3: current docs call this a deprecated alias)
```

`~/.codex` and the user's real Codex settings are never modified by this plan except through an explicit, reviewed, KRYLO-owned setup path with dry-run/backup/rollback (Section 8).

## 2. Reconciliation: design doc (2026-08-20) vs. current official documentation (re-verified 2026-08-26)

Sources: `developers.openai.com/codex/*` and its `learn.chatgpt.com/docs/*` mirror (redirect target). Quoted fragments below are from those pages, fetched during this checkpoint.

### 2.1 Plugin manifest -- confirmed accurate

`.codex-plugin/plugin.json` is the manifest entry point. Required: `name`, `version`, `description`. Common optional fields: `author`, `homepage`, `repository`, `license`, `keywords`, `skills`, `mcpServers`, `apps`, `hooks`, `interface`. Manifest-relative paths must start with `./`. If no explicit `hooks` field exists, Codex checks `hooks/hooks.json` automatically. Plugin hooks receive `PLUGIN_ROOT` and `PLUGIN_DATA`, plus the compatibility aliases `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. Confirmed exactly as the design doc and the task prompt describe.

### 2.2 Skill invocation control -- refined

SKILL.md frontmatter documented fields are only `name` and `description`. **Implicit invocation is controlled by a separate `agents/openai.yaml` file inside the skill directory**, not by a SKILL.md frontmatter field:

```yaml
policy:
  allow_implicit_invocation: false
```

This is the exact mechanism the design doc and task prompt anticipated (`agents/openai.yaml` with `allow_implicit_invocation: false`), now confirmed against the current official docs rather than assumed. Explicit invocation uses `$skill-name` (CLI and IDE both document `/skills` or typing `$` to mention a skill).

Known current platform rough edges (tracked as capability-matrix caveats, not blockers): several open `openai/codex` GitHub issues describe explicit-only skills not always being reliably discoverable/invocable in every surface (#19695, #23454, #10585) and one open `mattpocock/skills` issue about `disable-model-invocation` needing the `agents/openai.yaml` file specifically, not SKILL.md alone (#516). KRYLO's own setup and smoke tests must verify the actual installed behavior rather than assuming the documented contract is bug-free.

### 2.3 Hooks -- refined

Supported lifecycle events (confirmed): `SessionStart`, `SessionEnd`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`.

Common hook stdin fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions` -- see Section 2.5). Turn-scoped events additionally carry `turn_id`. `tool_name`, `tool_use_id`, `tool_input` are PreToolUse-specific.

**PreToolUse output (confirmed, exact):**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive command blocked by hook."
  }
}
```

A legacy `{"decision": "block", "reason": "..."}` (or exit code 2) form also blocks. An `updatedInput` field on an `"allow"` decision rewrites the tool call.

**Confirmed unsupported and hook-failing if returned:** `permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason`, `suppressOutput`. KRYLO's Codex PreToolUse adapter must never emit any of these five.

**PermissionRequest output (confirmed, exact -- different shape from PreToolUse):**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

or

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "Blocked by repository policy." }
  }
}
```

If multiple matching hooks return decisions, any `deny` wins. **PermissionRequest only fires when Codex was already about to prompt** (i.e. its own `permission_mode`/sandbox/approval_policy state would already ask); it cannot manufacture a human prompt for an action Codex would otherwise perform without asking. This matches the task's own platform-facts brief exactly and is the reason Section 6 below fails closed rather than trying to force a prompt through PermissionRequest.

**Trust:** installing/enabling a plugin does not trust its hooks. Codex records trust against the hook's exact content hash; a new or changed hook is skipped until reviewed via the `/hooks` CLI command (or an explicit one-time `--dangerously-bypass-hook-trust`, never used by KRYLO setup). Project-local `<repo>/.codex/hooks.json` hooks additionally require the project `.codex/` layer itself to be trusted. Managed hooks from a `requirements.toml` layer are trusted by policy and cannot be disabled -- KRYLO does not use this mechanism, since it would bypass the user's own review.

**Feature-flag discrepancy to verify empirically:** current docs state hooks are enabled by default and that `codex_hooks` is "a deprecated alias" for a `features.hooks` flag. The installed 0.120.0 build's `features list` output shows a row literally named `codex_hooks` (`under development`, `false`), with no separate `hooks` row. This plan does not trust either source alone: Section 7 (real Codex validation) includes a live fixture test that installs a trivial plugin hook and observes, empirically, whether it fires -- and if it does not fire without an explicit `--enable hooks` (or the CLI's actual current equivalent), that exact requirement is captured in the capability matrix and in KRYLO's own Codex setup instructions, not silently assumed away.

### 2.4 Rules -- confirmed, more precise than the design doc anticipated

Rule files use a **Starlark** DSL (Python-like, restricted for safety), not TOML or JSON, with extension `.rules` inside a `rules/` folder next to an active config layer (for example `~/.codex/rules/default.rules`, or `<repo>/.codex/rules/*.rules` for a trusted project layer).

```text
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "prompt",
    justification = "Viewing PRs is allowed with approval",
    match = ["gh pr view 7888"],
    not_match = ["gh pr --repo openai/codex view 7888"],
)
```

`pattern` (required, non-empty list): command-prefix tokens to match. `decision` (default `"allow"`): `allow` | `prompt` | `forbidden`. `justification` (optional): human-readable reason surfaced in the prompt/rejection. `match`/`not_match` (optional, default `[]`): self-validating examples Codex checks when it loads the rule file. Most-restrictive precedence across matching rules: `forbidden` > `prompt` > `allow`.

Validation: `codex execpolicy check --pretty --rules <path> -- <command...>`.

**Scope implication for KRYLO's approval mapping (important, not previously this explicit in the design doc):** `prefix_rule` matches a **shell command prefix**. It has no mechanism for gating `apply_patch` or an MCP tool call directly. This means a native Codex human prompt can only be reliably forced today for KRYLO `require-approval` classes that are themselves shell-command-shaped (git push/force-push, release/publish/deploy CLI invocations, and the other static command families KRYLO's own risk policy already recognizes). A `require-approval` classification reached through `apply_patch` or an MCP tool call has **no reliable native-prompt path on the current Codex host** and must fail closed (Section 6.3), exactly as the task's own Section 6 anticipates ("If KRYLO classifies an action as require-approval but the current Codex host cannot reliably force a native human prompt for that specific tool/path: FAIL CLOSED").

### 2.5 Permission modes -- two distinct namespaces (refined, not previously distinguished this precisely)

The Codex **hook-payload** `permission_mode` field uses Claude-compatible naming for hook-script consumption: `default | acceptEdits | plan | dontAsk | bypassPermissions`. This is the field KRYLO's Codex adapter reads (it is what actually arrives on hook stdin).

Separately, the Codex **CLI's own** `--ask-for-approval` flag uses a different vocabulary entirely: `untrusted | on-failure (deprecated) | on-request | never`, alongside an independent `--sandbox` flag (`read-only | workspace-write | danger-full-access`). `approval_policy = "never"` is the documented equivalent of hook-payload `bypassPermissions`. KRYLO's Codex adapter only ever reads and reasons about the **hook-payload** vocabulary; it never invents a mapping from the CLI flag vocabulary, since that is not what hooks actually observe.

Confirmed security-relevant facts: sandbox mode and approval policy are independent layers (a restrictive sandbox still blocks writes even under a permissive approval policy, and vice versa). The official docs describe Codex's guardrails as exactly that -- guardrails, not an OS sandbox -- consistent with KRYLO's own defense-in-depth framing (`SECURITY.md`).

### 2.6 Codex IDE extension (VS Code) plugin support -- reconfirmed unchanged

Re-verified directly against current official docs: **"The IDE extension doesn't support plugins."** Plugins install and run through the ChatGPT desktop app and Codex CLI's `/plugins` browser only. This matches the design doc's original (2026-08-20) finding exactly -- no ADR correction is required here. Full VS Code KRYLO support therefore still requires the standalone-Skill-plus-project-hooks bridge described in the design doc's Section 10, not plugin installation.

## 3. Architectural decisions carried forward unchanged from the design doc

- One Shared Core; Codex-specific code is limited to packaging, HostContext extraction, tool/input normalization, lifecycle event translation, permission/rule transport, capability detection, and setup/install integration (design doc Section 10).
- `runId` is KRYLO-owned; `hostSessionId`/`hostTurnId` are metadata (already implemented -- `scripts/lib/host-context.mjs`, `scripts/lib/state.mjs`).
- One product version (`0.1.1` through this checkpoint; `0.2.0` only at a later, separately authorized release-preparation checkpoint).
- KRYLO remains explicit-only on Codex: `$krylo-run`, implicit invocation disabled via `agents/openai.yaml`.

## 4. What already exists (verified this checkpoint, not re-implemented)

Phase 2 (host-neutral Core extraction) of the design doc is already complete on this branch:

- `plugins/krylo/scripts/lib/host-context.mjs`: host-neutral `HostIdentity`/`HostContext` validation, already anticipates `host: "claude" | "codex"`.
- `plugins/krylo/scripts/lib/state.mjs` and `scripts/lib/hook-utils.mjs`: run state and active-run resolution are already keyed by `{ host, hostSessionId, projectRootHash }`, with no Claude-specific field names.
- `plugins/krylo/scripts/host/claude/context.mjs` and `scripts/host/claude/hook-transport.mjs`: the exact pattern this plan mirrors for Codex -- a `context.mjs` (environment/identity normalization) and a `hook-transport.mjs` (Hook payload parsing plus host-specific output shaping), with all policy logic living in host-neutral `scripts/security/risk-policy.mjs` and `scripts/runtime/*`.
- `plugins/krylo/scripts/security/risk-policy.mjs`: `classifyRiskAction()` already returns a host-neutral `{ action: 'pass' | 'deny' | 'require-approval', category, reason, actionClass? }` shape consumed identically by any host adapter.

This plan's job is therefore narrowly: add the Codex-side mirror of the adapter pattern, plus Codex-specific packaging, rules, setup, and tests. It must not modify `risk-policy.mjs`'s classification semantics beyond what Codex's own tool-name/input normalization genuinely requires, and any such change must preserve the existing Claude regression suite unmodified.

## 5. Task 1: ADR

Add `docs/adr/0029-codex-host-packaging-and-approval-boundary.md` (0024-0028 are already used by unrelated Foundation-hardening decisions, so this is the next available number). Decision content: Codex CLI plugin packaging, `$krylo-run` explicit-only Skill, Codex HostContext adapter, Codex hook transport (PreToolUse/PermissionRequest/PostToolUse/SessionStart/SessionEnd/Stop), the fail-closed require-approval boundary (Section 6 below), rules-based native prompting for the shell-command-shaped subset of require-approval classes, and the VS Code standalone-Skill-plus-project-hooks bridge. Explicitly extends ADR-0023's promise ("Codex receives its own explicit host invocation in a later ADR") and does not touch ADR-0021 (Claude-only).

## 6. Task 2: Codex HostContext adapter

New file `plugins/krylo/scripts/host/codex/context.mjs`, mirroring `host/claude/context.mjs`:

- `resolveCodexSessionId({ explicitSessionId, hookPayload, env })`: prefers an explicit override, then `hookPayload.session_id`, matching the Claude adapter's precedence pattern.
- `resolveCodexDataRoot(env)`: `KRYLO_DATA_ROOT` override first (test/isolation escape hatch, same as Claude); then Codex's own `PLUGIN_DATA` (native plugin runs); then, for a **standalone** (non-plugin, VS Code bridge) run with no `PLUGIN_DATA`, the design doc's documented fallback `path.join(os.homedir(), '.krylo', 'data')` -- never the Claude data root, never the application repository.
- `resolveCodexPluginRoot(env)`: `PLUGIN_ROOT` when running as an installed plugin; falls back to the source-relative plugin root (mirrors `PLUGIN_ROOT_FROM_SOURCE` in the Claude adapter) for the standalone bridge, where there is no installed plugin root at all -- the standalone case must not fabricate one.
- `createCodexHostIdentity(...)`: calls the shared `createHostIdentity({ host: 'codex', ... })` from `lib/host-context.mjs`, carrying `hostTurnId` from `turn_id` and `permissionMode` from the hook payload's `permission_mode` field (Section 2.5 -- the hook-payload vocabulary, never the CLI flag vocabulary).
- `bootstrapCodexStorageEnvironment`/`applyCodexRuntimeEnvironment`/`bootstrapCodexRuntimeEnvironment`: same shape as the Claude equivalents, setting `KRYLO_HOST=codex` and `KRYLO_DATA_ROOT`.

## 7. Task 3: Codex hook transport

New file `plugins/krylo/scripts/host/codex/hook-transport.mjs`, mirroring `host/claude/hook-transport.mjs`:

- `normalizeCodexHookPayload(payload)`: same `{ ok, identity, payload }` / degraded-identity contract as the Claude version, reading `cwd`, `session_id`, `turn_id`, `permission_mode` from the Codex hook stdin shape (Section 2.3).
- `codexCwdFallbackIdentity()`: mirrors the Claude cwd-fallback path for an unparseable payload.
- `emitCodexPreToolDeny(reason)`: emits **exactly** `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }` and exits 0. There is no `emitCodexPreToolAsk` -- that function must not exist, by design, so it can never accidentally be called.
- `allowCodexSilently()`: exit 0 with no stdout, for both the "no active run" and "pass" cases.
- `emitCodexPermissionRequestDecision(behavior, message)`: emits the `PermissionRequest`-specific shape (`decision.behavior`), used only from the PermissionRequest hook, never from PreToolUse.
- `emitCodexStopBlock(reason)`: mirrors the Claude `Stop` hook's `{ decision: 'block', reason }` output if Codex's current `Stop` hook contract matches (verified in Task 9's real-runtime pass before this function is relied upon for anything security-relevant; KRYLO's Orbit budget enforcement is Core-side regardless and does not depend on this hook firing).

## 8. Task 4: Codex PreToolUse risk gate (security-critical)

New file `plugins/krylo/scripts/security/risk-gate-codex.mjs`. Same overall shape as `risk-gate.mjs` (inactive-run silent pass-through, fail-safe deny on unreadable payload or classification exception, `recordEvent` telemetry), with the approval boundary rewritten for Codex's real capabilities instead of ported from Claude:

- `pass` -> `allowCodexSilently()`.
- `deny` -> `emitCodexPreToolDeny(reason)`.
- `require-approval`:
  - **Never** emit `permissionDecision: "ask"` or any of the five confirmed-unsupported fields (Section 2.3).
  - Normalize the incoming Codex tool name/input to the same tool-name vocabulary `risk-policy.mjs` already expects (`shell`/`exec_command` -> `Bash`; `apply_patch` -> a distinct `apply_patch` tool identity, never silently relabeled as Claude's `Edit`/`Write`; `mcp__server__tool`-shaped names pass through to the existing MCP classifier unchanged; other local function tools use their own local name).
  - **Every** `require-approval` classification -- shell, `apply_patch`, or MCP alike -- **fails closed**: `emitCodexPreToolDeny()` with a reason that names the specific capability gap and tells the user the action must be performed outside the KRYLO autonomous run, or under an explicitly supported Codex approval path. Current official docs do not state whether a project/user rule's own native prompt fires before or after PreToolUse, or whether a no-decision PreToolUse hook implicitly skips downstream rule/approval_policy evaluation -- since that ordering is unverified, the gate never tries to detect "this command is covered by an installed rule" and trust it. See ADR-0029 for the full reasoning.
- `hard-deny` (KRYLO's own `deny`-category classifications: sensitive path, data root, hook-entrypoint, oversized command) always denies regardless of `permission_mode`, exactly as on Claude.

## 9. Task 5: Codex PermissionRequest, PostToolUse, SessionStart, SessionEnd hooks

- **PermissionRequest** (`scripts/security/permission-request-codex.mjs`): fires only when Codex was already about to prompt. Re-runs the same host-neutral classification for defense in depth; if the action is a KRYLO hard-deny, emits `decision.behavior: "deny"` with the KRYLO reason (any `deny` wins per Section 2.3, so this cannot be weaker than a rule-level `forbidden`). If the action is anything else, returns no decision (lets Codex's own normal prompt continue) -- **never** auto-approves a KRYLO `require-approval` action from this hook, and never invents an approval event KRYLO itself did not create.
- **PostToolUse** (`scripts/runtime/posttool-telemetry-codex.mjs`): records evidence/telemetry only after the tool ran, reusing the host-neutral `recordEvent`/state update helpers already used by the Claude PostToolUse hook; never treated as a security boundary (a tool has already executed by the time this fires).
- **SessionStart** / **SessionEnd** (`scripts/status/session-lifecycle-codex.mjs` or reuse of the existing host-neutral agent-events/cleanup modules with a Codex transport wrapper): the inactive-run no-op path from the design doc's Section 10.6 -- resolve identity, check for an active run, and if none, exit 0 with no state mutation, no telemetry record, and no model-visible output. A no-op latency measurement is part of Task 7's real-runtime validation, with the numeric budget chosen from the measured local baseline rather than invented in advance.

## 10. Task 6: Rules provisioning (independent, optional -- not trusted by the PreToolUse gate)

Setup can generate a KRYLO-owned `.rules` file (Starlark, Section 2.4) covering the smallest deterministic set that maps to existing `production-policy.json` `require-approval` classes reachable as shell command prefixes: `git push`, `git push --force`/`-f`, and the release/publish/deploy command families `production-policy.json` already recognizes. Each rule uses `decision = "prompt"` with a `justification` naming the KRYLO risk class, and includes at least one `match` and one `not_match` example so Codex's own self-validation catches a malformed pattern at load time rather than at run time. The generated file is validated with `codex execpolicy check --pretty --rules <generated-path> -- <example command>` for every provisioned rule before setup reports success. No `forbidden` rule is provisioned -- KRYLO's own hard-deny already denies deterministically at PreToolUse regardless of the rule layer, and a Codex-level `forbidden` would duplicate policy source in a second, harder-to-review location (violating design doc Section 5.2's architectural rule).

**This is explicitly independent of KRYLO's own approval boundary** (Task 4, ADR-0029): because the rules/PreToolUse/`approval_policy` execution order is undocumented upstream, KRYLO's PreToolUse gate denies every `require-approval` classification regardless of whether a matching rule is installed. The generated rule is useful for an ordinary (non-KRYLO) Codex session in the same project, where the operator wants Codex's own native prompt for a specific command shape -- it is not a KRYLO approval path, and setup documentation must say so explicitly.

## 11. Task 7: Packaging, Skill, and manifest

- `plugins/krylo/.codex-plugin/plugin.json`: `name: "krylo"`, matching `version: "0.1.1"`, `description`, `skills: ["./skills/krylo-run"]` (or the current documented relative-path array/object form -- confirmed against a real local install in Task 12), `hooks: "./hooks/codex-hooks.json"` (an **explicit, Codex-only path** -- see below for why this is not the shared `hooks/hooks.json`). No `mcpServers`/`apps` entries (KRYLO Core requires no mandatory MCP server or external service). Reuses the same repository root `plugins/krylo/` rather than a second copy of Core, per the design doc's packaging-verification gate (Section 9.2) -- confirmed viable in Task 12's real local-install smoke test; if it is not, the smallest wrapper directory outside `plugins/krylo/` is used instead, still consuming the same Core source, and this plan is amended to record why.
- `plugins/krylo/skills/krylo-run/SKILL.md` (Codex Skill; distinct file from the existing Claude `skills/run/SKILL.md`, since Codex's explicit-invocation public name is `krylo-run`, not `run`): `name: krylo-run`, `description` matching the Claude Skill's own scope statement, referencing repository runtime/docs rather than duplicating policy text (per the task's own explicit instruction).
- `plugins/krylo/skills/krylo-run/agents/openai.yaml`: `policy: { allow_implicit_invocation: false }` (Section 2.2).
- `plugins/krylo/hooks/codex-hooks.json` (**not** `hooks/hooks.json`): registers the Codex hook entrypoints from Tasks 3-4 for `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `SessionEnd`, using whatever current official hook-registration shape a real local install validates in Task 12 (matcher syntax, `command`/`commandWindows` fields). A separate file is required because Codex auto-discovers `hooks/hooks.json` by the same directory convention Claude already uses for its own (deliberately empty, ADR-0021) plugin-wide hooks file -- populating `hooks/hooks.json` itself for Codex would risk Claude also attempting to load Codex-shaped hook entries. The Codex manifest's explicit `hooks` field bypasses that auto-discovery entirely, so `hooks/hooks.json` stays untouched and Claude's existing guarantee (an ordinary Claude session launches zero KRYLO hook processes) is unaffected. Unlike the Claude Skill-scoped design, Codex plugin-bundled hooks are not scoped to Skill activity -- every one of them **must** implement the inactive-run no-op path from Task 5 so an ordinary Codex session that never invokes `$krylo-run` still launches KRYLO hook processes (Codex has no equivalent of Claude's Skill-scoped Hook lifecycle) but they do nothing and cost only the measured no-op latency budget.

## 12. Task 8: Capability matrix

New file `plugins/krylo/docs/codex-capability-matrix.md` (or `docs/11-integration-adapters.md` extension -- final location decided against `FILE_MANIFEST.md` convention in Task 10), covering at minimum: plugin packaging, Skill explicit invocation (with the known platform rough edges from Section 2.2 noted), plugin-bundled hooks, project-local hooks, hook trust requirement, PreToolUse deny, PreToolUse rewrite, PreToolUse forced ask (unsupported -- explicit), PermissionRequest behavior, project rule prompt, `apply_patch` coverage, shell coverage, MCP coverage, hosted-tool coverage (not visible to PreToolUse/PostToolUse), SessionStart, SessionEnd, Subagent events, model identity, turn identity, data-root support, CLI, IDE extension (Skill-only, no plugin), noninteractive `codex exec`. Every unsupported capability names its safe fallback explicitly (usually: fail closed, or "documented residual, not a security guarantee").

## 13. Task 9: Codex VS Code bridge (standalone Skill + project hooks)

Implements design doc Section 10 for the CLI/plugin-relevant slice only (no new VS Code extension is built -- KRYLO integrates with the existing Codex IDE extension, per the task's own explicit instruction):

- A user-level standalone Skill installable under the documented Codex user Skill location, KRYLO-owned, with the same `allow_implicit_invocation: false` policy.
- Project-scoped `<repo>/.codex/hooks.json` setup with dry-run, ownership metadata, backup-before-replace, explicit-approval-before-apply, and deterministic rollback -- reusing (not duplicating) whatever inspect/merge/backup primitives the existing Claude setup code already implements for `.claude/settings.json` (ADR-0013), adapted for the Codex project-config shape.
- A refusal path: when the standalone Skill is present but the project hook layer is absent or untrusted, KRYLO runs read-only diagnostics and explains the missing enforcement layer rather than silently downgrading to a weaker autonomous run.
- Windows `commandWindows` (or the current documented equivalent) verified against a real install in Task 12 before being relied on; if project-hook commands cannot be made portable and deterministic through host command expansion alone, a thin KRYLO-owned launcher is installed under the project `.codex/` directory instead (never a second copy of Core policy source).

## 14. Task 10: Documentation

Update, at minimum: `ARCHITECTURE.md` (Codex Host section, no longer "planned"), `PRODUCT_SPEC.md` (Codex host now implemented for the scope above), `SECURITY.md` (Codex approval boundary, fail-closed rationale), `THREAT_MODEL.md` (Codex-specific trust boundaries: plugin hook trust, project `.codex/` trust, rule-file provisioning), `README.md`, `RELEASE_READINESS.md`, `docs/process/FILE_MANIFEST.md`, `docs/07-hooks-and-observability.md` (Codex Hook transport section), `docs/09-tool-governance.md`, `docs/11-integration-adapters.md`, `CHANGELOG.md`. Preserve historical ADR text; supersede rather than silently rewrite where current behavior contradicts an accepted decision.

## 15. Task 11: Testing (TDD, tests land with each task above, not deferred)

Full required coverage per the task's own Section 16 categories A-J, added incrementally: manifest/packaging validation; Skill explicit/implicit-invocation contract; HostContext field normalization and malformed-input handling; hook schema correctness and unknown-event/malformed-JSON handling for every implemented hook; risk classification parity (`allow`/`require-approval`/`hard-deny` across `bypassPermissions`/`dontAsk`/unknown mode, shell/`apply_patch`/MCP); rule-file generation and `codex execpolicy check` validation; host/session state isolation (Claude run cannot be adopted by a Codex session and vice versa, concurrent Claude+Codex runs do not collide); setup fresh-install/existing-config/conflict/upgrade/uninstall/rollback/idempotency; privacy (no prompt/source/raw-command leakage in Codex telemetry paths); cross-platform path fixtures (POSIX, Windows, spaces, Unicode). A same-input-same-classification parity test proves Claude and Codex reach equivalent `classifyRiskAction()` results for equivalent normalized tool actions even though native enforcement output differs.

## 16. Task 12: Real Codex validation

Using an isolated `CODEX_HOME`/`HOME` and a disposable temp project directory (never the user's real `~/.codex`, `~/.agents`, or real project Codex settings): `codex --version`; local plugin install/discovery; `$krylo-run` Skill discovery and explicit-invocation smoke test; hook loading and trust-flow observation (including the Section 2.3 feature-flag empirical check); `codex execpolicy check` against every generated rule; a safe PreToolUse-deny smoke test; a PermissionRequest continuation smoke test where practical. Distinguish, per result: locally passed / statically inspected / configured but not run / blocked by platform / CI pending -- never claim a result not actually observed.

## 17. Task 13: Full verification, independent review, fix, re-verify

`git diff --check`, `npm run syntax`, `npm run validate:runtime`, focused new Codex test files, full `npm test`, then `krylo:verifier` + `krylo:reviewer` + `krylo:security-reviewer` against the final HEAD (Section 22 attack targets from the task prompt). Fix Critical/High findings caused by this implementation; do not reopen unrelated historical Foundation items (Section 19 freeze). If a review-driven fix changes code, re-run review on the resulting HEAD before stopping.

## 18. Explicitly out of scope for this checkpoint

Cross-Harness advisory workers (Phase 5), Weekly Upstream Watch (Phase 6), Monthly Ecosystem Radar (Phase 7), 0.2.0 version bump and release preparation (Phase 9), any push/PR/merge/tag/release/publish/deploy/marketplace submission, and reopening unrelated pre-existing Foundation follow-ups (`realpathBestEffort` performance, the `.ssh` no-trailing-separator gap, plugin-installation Bash/PowerShell arbitrary-shell coverage).
