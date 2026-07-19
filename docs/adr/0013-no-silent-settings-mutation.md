# ADR-0013: Do not silently modify user settings

## Status

Accepted

## Context

A public plugin should not weaken permissions or replace personal configuration during installation.

## Decision

Use plugin userConfig for normal preferences. Any alias or main status-line change occurs only through setup with dry run, backup, and explicit approval.

## Consequences

- Installation is safer.
- Setup is more explicit.
- Rollback support is required.
