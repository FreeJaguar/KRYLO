# Hooks and Observability

## Hook design

KRYLO uses plugin hooks for deterministic policy and metadata capture. Hooks must be small, fast, redacted, and independently testable.

The policy each hook enforces (question gate, risk gate, completion gate, redaction, counters) is host-neutral Shared Core logic. Only the Hook transport, the mechanism that delivers host events into that policy and returns a host-specific response, is host-specific.

On the Claude Host, the implemented Hook transport is Skill-scoped, per `docs/adr/0021-hook-scoping-to-run-skill.md`, and uses current Claude Code Hook input/output schemas. A Codex Hook transport is not implemented in this Foundation; any future Codex transport must call the same Shared Core policy without redefining it.

## Planned events

### PreToolUse

Matcher: `Bash|PowerShell|Write|Edit|NotebookEdit|mcp__.*` -- a risky action must not bypass KRYLO merely because Claude invokes PowerShell instead of Bash (both are covered identically by risk classification; see `docs/adr/0026-powershell-risk-parity.md`).

Uses:

- Question gate.
- Risk gate.
- External-write classification.
- Sensitive-path protection.

The risk gate's `permissionDecision` is `allow` for a policy-passed action, `deny` for an outright policy denial (data-root protection, Hook-entrypoint protection, a protected secret path, an oversized command), and, for a `require-approval` classification (production, destructive, publish, release, push, merge, IAM/secret, payment, and other declared write classes): `ask` when the tool is Bash, or `deny` for every other tool (PowerShell, MCP). This split is not a policy gap -- risk *classification* is identical across tools -- it is because official Claude Code documentation only confirms the underlying `ask` guarantee for Bash (see `docs/adr/0025-native-permission-approval.md` and `docs/adr/0026-powershell-risk-parity.md`); a require-approval class on any other tool keeps the deterministic `deny` fail-safe, which is strictly more conservative than an unconfirmed `ask`. Both genuine fail-safe paths (an unreadable/malformed Hook payload, or an exception while classifying the tool call) also return `deny`: those are not `require-approval` decisions with a legitimate human-review outcome, they are KRYLO's own inability to classify the action at all.

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
