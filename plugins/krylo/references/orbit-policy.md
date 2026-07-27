# Orbit Policy

Orbit is a bounded correction loop.

## Budget and the `max_orbit_cycles` cap

Every run starts from a risk-based Orbit budget: low=3, medium=5, high=7 (`docs/../references/risk-policy.md`). The user-facing `max_orbit_cycles` setting (default 7, range 1-10) is a cap, not a target: it can only lower a run's budget further, never raise it above its risk-based value, and never above the platform-safe maximum of 10. A high-risk run with `max_orbit_cycles=10` still starts at budget 7; a low-risk run with `max_orbit_cycles=10` still starts at budget 3. Setting `max_orbit_cycles=2` lowers every run's budget to at most 2 regardless of risk.

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
