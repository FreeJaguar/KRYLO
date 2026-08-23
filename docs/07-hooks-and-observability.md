# Hooks and Observability

## Hook design

KRYLO uses plugin hooks for deterministic policy and metadata capture. Hooks must be small, fast, redacted, and independently testable.

The policy each hook enforces (question gate, risk gate, completion gate, redaction, counters) is host-neutral Shared Core logic. Only the Hook transport, the mechanism that delivers host events into that policy and returns a host-specific response, is host-specific.

On the Claude Host, the implemented Hook transport is Skill-scoped, per `docs/adr/0021-hook-scoping-to-run-skill.md`, and uses current Claude Code Hook input/output schemas. A Codex Hook transport is not implemented in this Foundation; any future Codex transport must call the same Shared Core policy without redefining it.

## Planned events

### PreToolUse

Uses:

- Question gate.
- Risk gate.
- External-write classification.
- Sensitive-path protection.

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
