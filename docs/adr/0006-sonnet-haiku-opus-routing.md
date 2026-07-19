# ADR-0006: Use portable model routing with optional Fable escalation

## Status

Accepted

## Context

Claude Code environments differ in account and organization model availability. Current subagent documentation includes Fable, while portable baseline aliases remain Haiku, Sonnet, and Opus.

## Decision

Ship static agent files with Haiku, Sonnet, and Opus. Permit KRYLO to request Fable per invocation for deep-debug escalation only after capability detection, with Opus as the explicit fallback.

## Consequences

- Static agent files remain portable.
- Accounts with Fable can use it selectively.
- Cost is controlled.
- Final reports must use resolved model data when available.
