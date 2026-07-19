# Model Routing

## Supported model policy

KRYLO v0.1.0 ships portable static agent definitions using:

- `haiku`
- `sonnet`
- `opus`

Current Claude Code subagent documentation also supports `fable`. KRYLO may use `fable` as a per-invocation deep-debug escalation only after runtime detection confirms that the account and organization allow it. If unavailable, the explicit fallback is Opus.

## Routing

### Haiku

Use for:

- Focused file and symbol discovery.
- Lightweight repository mapping.
- Small completion-evaluation tasks.
- Low-cost metadata classification.

Do not use for:

- Security conclusions.
- Architecture decisions.
- Complex code review.
- Migration safety.

### Sonnet

Use for:

- Main KRYLO skill turn.
- Routine implementation.
- Test creation and execution.
- UI review.
- AI evaluation execution.
- Performance measurement.

### Opus

Use for:

- Architecture.
- Complex independent review.
- Security review.
- Migration review.
- Material product ambiguity.
- Deep debugging when Fable is unavailable or unnecessary.

### Fable

Use only for per-invocation escalation when runtime capability detection confirms availability and the task involves repeated failure, conflicting evidence, a long cross-system investigation, or unusually difficult autonomous debugging. Do not set Fable as a global default.

## Escalation

Escalate to Opus when:

- Two normal correction attempts fail.
- Evidence conflicts.
- Multiple systems are involved.
- The decision has high security, migration, or architectural impact.
- The task cannot be safely decomposed for Sonnet.

## Reporting

The final report distinguishes:

- Configured model alias.
- Resolved model when Claude Code provides it.
- Unavailable resolution data.

KRYLO must never infer a resolved model from an agent name.
