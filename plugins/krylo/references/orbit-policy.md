# Orbit Policy

Orbit is a bounded correction loop.

Each cycle receives only:

- Unmet criteria.
- New and repeated failures.
- Latest evidence.
- Changed files.
- Unresolved findings.
- Prior strategy.
- Required strategy change.
- Remaining budget.

Progress requires evidence. File edits alone do not count.

When the same failure fingerprint appears twice, change strategy. After two normal failed corrections, consider deep-debug escalation. After three cycles with no measurable progress, isolate scope, identify an environmental blocker, or stop safely.

Valid terminal states:

- VERIFIED_COMPLETE
- SAFE_BLOCKED
- USER_DECISION_REQUIRED
- RISK_APPROVAL_REQUIRED
- ITERATION_LIMIT_REACHED
- CANCELLED_BY_USER
