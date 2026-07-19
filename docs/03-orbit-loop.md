# KRYLO Orbit

## Purpose

Orbit continues useful work when implementation, verification, or review reveals unfinished criteria. It is not a generic infinite retry loop.

## Inputs per cycle

Each continuation receives only the current delta:

- Unmet criteria.
- Newly resolved criteria.
- New failures.
- Repeated failure hashes.
- Changed files.
- Latest evidence.
- Unresolved findings.
- Previous strategy.
- Required strategy change.
- Remaining cycle and time budget.

## Cycle algorithm

```text
observe -> classify failure -> choose smallest useful action -> execute -> verify -> review evidence -> update state
```

## Default budgets

- Low risk: 3 cycles.
- Medium risk: 5 cycles.
- High risk: 7 cycles.

The implementation must verify the current Claude Code Stop-hook behavior and choose a hard maximum compatible with the platform. It may reduce the user-configured value but must never exceed the platform-safe maximum.

## Progress definition

Progress is evidence-based. Examples:

- A failing test passes.
- An acceptance criterion becomes proven.
- A root-cause hypothesis is confirmed or rejected with evidence.
- A high-confidence finding is resolved.
- A build advances beyond the previous failure stage.

Edits alone are not progress.

## Repetition control

If the same failure hash appears twice:

- Do not repeat the same strategy.
- Re-check assumptions.
- Isolate the failing scope.
- Consider the deep-debugger.

If three cycles produce no measurable progress:

- Change strategy.
- Check environmental blockers.
- Reduce scope when safe.
- Stop as `SAFE_BLOCKED` or `ITERATION_LIMIT_REACHED` when no useful action remains.

## Completion

Orbit ends only in one of the six terminal states. A model-generated phrase is not sufficient. The deterministic completion gate must verify state and evidence.
