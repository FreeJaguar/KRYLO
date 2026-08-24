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

The risk gate's `permissionDecision` is `allow` for a policy-approved action and `deny` for a policy-denied action or a matched risk approval consumption. Both of its fail-safe paths (an unreadable/malformed Hook payload, or an exception while classifying the tool call) also return `deny`, not `ask`: current official Claude Code Hook documentation does not confirm that `permissionDecision: "ask"` reliably produces a genuine, blocking human prompt in every session mode at this project's pinned 2.1.197 compatibility floor (a documented issue, `anthropics/claude-code#39344`, shows `ask` can silently defer to other permission configuration on versions at or before that floor). `deny` has no such ambiguity, so KRYLO uses it for every path where the tool call could not be evaluated at all.

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

### UserPromptSubmit

Implemented as a seventh Skill-scoped Hook event, `scripts/security/human-approval-gate.mjs`, registered in `skills/run/SKILL.md`'s frontmatter exactly like the other six (never in `hooks/hooks.json`). Per `docs/adr/0024-host-controlled-human-approval-boundary.md`, it is the only path that can transition a risk approval from `pending` to `approved` (or `denied`); the model-accessible CLI (`update-state.mjs --resolve-approval <id>=approved`) is unconditionally refused for that reason.

Uses:

- Scans the raw text of a genuine top-level prompt submission for an explicit `KRYLO-APPROVE <id>` / `KRYLO-DENY <id>` phrase (case-insensitive).
- Ignores any payload attributed to a subagent (`agent_id` or `agent_type` present) before even inspecting the prompt text.
- Never blocks, delays, or alters the prompt, and never prints anything visible to the model: it always exits 0 silently, whether or not a confirmation phrase matched.

## Failure modes

- Telemetry hooks fail open.
- Risk gates fail safe.
- Completion gates fail safe but must not create an infinite loop.
- Hook failure is visible in doctor diagnostics.

## Monitors

Claude Code supports experimental plugin monitors. KRYLO v0.1.0 should not require a monitor. A monitor may be added later for local background-task state if it materially improves reliability and is supported across target hosts.
