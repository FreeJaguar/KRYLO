# ADR-0010: Treat OpenWiki as an optional adapter

## Status

Accepted

## Context

Generated repository documentation may help large projects but can be stale, require external inference, and should not outrank code.

## Decision

OpenWiki is disabled by default, requires provider and repository approval, and is never a source of truth above code, tests, schemas, or migrations.

## Consequences

- KRYLO has no OpenWiki dependency.
- Freshness and source revision must be tracked when used.
