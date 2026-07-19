# ADR-0005: Use the smallest effective agent team

## Status

Accepted

## Context

Large fixed teams create context overhead, latency, duplication, and file conflicts.

## Decision

Route only the agents required by lane and risk. Preserve independent verification and review while avoiding unnecessary roles.

## Consequences

- Simple tasks remain fast.
- Agent routing must be tested.
- One writer per worktree is easier to enforce.
