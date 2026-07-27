# Lane Policy

Select one primary lane and add secondary review requirements when needed.

## PATCH

Use for small bugs and isolated changes. Reproduce, apply the smallest fix, add or identify a regression test, run focused and related checks, and inspect the diff.

## BUILD

Use for normal features and cross-file behavior. Analyze impact, plan internally, implement, test, verify, review, and correct.

## DESIGN

Use for UI, responsive, RTL, component-system, and Figma-linked work. Create a design contract, implement, test browser behavior, inspect screenshots, and review accessibility.

## PRODUCT

Use for a high-level feature idea. Identify user, job, smallest shippable slice, non-goals, success signal, and only material ambiguity.

## INCIDENT

Begin read-only. Reproduce, collect safe evidence, maintain hypotheses, isolate root cause, define rollback, and avoid production writes.

## MIGRATION

Review compatibility, expand-and-contract sequencing, data assumptions, rollback, local validation, and production gates.

## AUDIT

Remain read-only unless the task explicitly requests corrections.

## AI

Define golden cases, injection tests, fallback behavior, latency, cost, and evaluation integrity.

## PERFORMANCE

Measure baseline, define target, change one meaningful variable, re-measure, and check regressions.
