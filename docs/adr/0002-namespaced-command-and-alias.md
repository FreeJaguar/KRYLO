# ADR-0002: Use a namespaced public command and optional personal alias

## Status

Accepted

## Context

Claude Code plugin skills are always namespaced, while the desired daily command is `/krylo`.

## Decision

The portable command is `/krylo:run`. `/krylo:setup` may install a personal wrapper named `/krylo` after a dry run and backup.

## Consequences

- The plugin remains standards-compliant.
- The short command is optional and local.
- Alias ownership and rollback must be implemented.
