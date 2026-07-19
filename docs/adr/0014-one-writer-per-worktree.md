# ADR-0014: Allow one application-code writer per worktree

## Status

Accepted

## Context

Concurrent writers can create conflicts and make review evidence ambiguous.

## Decision

The Builder is the normal writer. Additional writers require isolated worktrees and controlled integration.

## Consequences

- Parallel read-only analysis remains possible.
- Implementation may be less parallel but more reliable.
