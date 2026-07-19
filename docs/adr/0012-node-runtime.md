# ADR-0012: Use dependency-light Node.js ESM for deterministic runtime code

## Status

Accepted

## Context

The plugin needs portable scripts for state, hooks, setup, audit, and status rendering.

## Decision

Use Node.js ESM and built-in modules where practical. Avoid a large runtime framework and install-time downloads.

## Consequences

- Cross-platform support is simpler.
- Node compatibility must be declared and tested.
- Optional tools may have higher requirements without blocking KRYLO Core.
