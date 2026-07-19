# Hooks and Observability

## Hook design

KRYLO uses plugin hooks for deterministic policy and metadata capture. Hooks must be small, fast, redacted, and independently testable.

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
