# Hooks and Observability

## Hook design

KRYLO uses plugin hooks for deterministic policy and metadata capture. Hooks must be small, fast, redacted, and independently testable.

The policy each hook enforces (question gate, risk gate, completion gate, redaction, counters) is host-neutral Shared Core logic. Only the Hook transport, the mechanism that delivers host events into that policy and returns a host-specific response, is host-specific.

On the Claude Host, the implemented Hook transport is Skill-scoped, per `docs/adr/0021-hook-scoping-to-run-skill.md`, and uses current Claude Code Hook input/output schemas.

On the Codex Host, the implemented Hook transport (`scripts/host/codex/`, `docs/adr/0029-codex-host-packaging-and-approval-boundary.md`) is plugin-wide, not Skill-scoped -- Codex has no equivalent of Claude's Skill-scoped Hook lifecycle -- registered at an explicit `hooks/codex-hooks.json` path the Codex plugin manifest references directly (never the shared `hooks/hooks.json` Claude's own, deliberately empty, plugin-wide hooks file occupies). Every Codex hook entrypoint implements the inactive-run no-op path first: resolve identity, check for an active KRYLO run, and exit 0 with no output or state mutation if none, so an ordinary Codex session that never invokes `$krylo-run` still launches these processes but they do nothing. `PreToolUse` and `PermissionRequest` call the same host-neutral `risk-policy.mjs` classifier the Claude gate uses, translated into Codex's own confirmed-supported output shapes (never the unsupported `permissionDecision:"ask"`); `PostToolUse` mirrors the Claude telemetry hook exactly. See `docs/codex-capability-matrix.md` for which Codex lifecycle events are implemented versus deferred. Because the Codex IDE extension does not support plugins at all, VS Code enforcement additionally needs a project-scoped `<project>/.codex/hooks.json` (`docs/adr/0032-codex-project-scoped-hook-enforcement.md`, `scripts/setup/install-codex.mjs --target hooks`): a thin, policy-free launcher redirects each event to the exact same real scripts above, so there is still only one enforcement implementation, not a second one for the project-hook path.

## Planned events

### PreToolUse

Matcher: `Bash|PowerShell|Write|Edit|NotebookEdit|Read|Glob|Grep|mcp__.*` -- a risky action must not bypass KRYLO merely because Claude invokes PowerShell instead of Bash (both are covered identically by risk classification; see `docs/adr/0026-powershell-risk-parity.md`), and reading a protected secret path must not bypass KRYLO merely because Claude invokes Read/Glob/Grep instead of Bash/Write (docs/adr/0025-native-permission-approval.md's sensitive-path fix).

Uses:

- Question gate.
- Risk gate.
- External-write classification.
- Sensitive-path protection.

The risk gate's `permissionDecision` is `allow` for a policy-passed action, `deny` for an outright policy denial (data-root protection, Hook-entrypoint protection, a protected secret path, an oversized command), and, for a `require-approval` classification (production, destructive, publish, release, push, merge, IAM/secret, payment, and other declared write classes): `ask` whenever the tool is Bash, PowerShell, or an MCP tool call classified into a genuine (non-`hardDeny`) require-approval class, and `permission_mode` is in the `ASK_ELIGIBLE_PERMISSION_MODES` allowlist (`auto`, `manual`, `default` -- the only modes live-verified to honor a Hook's `ask` decision; docs/adr/0025-native-permission-approval.md) -- `deny` in every other case (a permission mode outside that allowlist, including `bypassPermissions`, `plan`, `acceptEdits`, `dontAsk`, an absent field, or any future/renamed mode; or an MCP call whose server/tool-name shape could not be positively identified, which stays a hard `deny` regardless of mode -- docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md). Native ask originally covered only Bash `git-push`/`git-force` (ADR-0025's initial narrowing, since found to violate KRYLO's own product contract that a require-approval classification must have a real human-approval path) and was restored to every require-approval class and to PowerShell/MCP by ADR-0027, once current official Claude Code documentation confirmed PreToolUse hooks run before the permission prompt for every tool, not just Bash. Both genuine fail-safe paths (an unreadable/malformed Hook payload, or an exception while classifying the tool call) still return `deny`: those are not `require-approval` decisions with a legitimate human-review outcome, they are KRYLO's own inability to classify the action at all.

### PostToolUse

Uses:

- Tool-name counters.
- Duration and success metadata.
- Progress-event updates.

### PostToolUseFailure

Uses:

- Failure category.
- Redacted failure hash.
- Stagnation input.

### SubagentStart and SubagentStop

Uses:

- Agent identity.
- Start and stop times.
- Status.
- Resolved model when safely available.

### TaskCompleted

Uses:

- Structured result validation.
- Evidence-presence checks.

### Stop

Uses:

- Deterministic completion gate.
- Optional prompt-based narrative consistency check.
- Orbit continuation.

## Failure modes

- Telemetry hooks fail open.
- Risk gates fail safe.
- Completion gates fail safe but must not create an infinite loop.
- Hook failure is visible in doctor diagnostics.

## Monitors

Claude Code supports experimental plugin monitors. KRYLO v0.1.0 should not require a monitor. A monitor may be added later for local background-task state if it materially improves reliability and is supported across target hosts.
