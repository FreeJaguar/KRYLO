# ADR-0004: Implement Orbit as a bounded delta loop

## Status

Accepted

## Context

An unbounded loop that repeats the full prompt can waste time and tokens and may repeat failed strategies.

## Decision

Orbit continues only with unmet criteria, new evidence, failure hashes, and a remaining budget. It ends in one of six terminal states.

## Consequences

- The loop is resumable and auditable.
- Stagnation can be detected.
- Runtime state and a deterministic Stop gate are required.
