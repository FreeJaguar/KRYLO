# ADR-0011: Use local-read and local-write automation with gated external and production actions

## Status

Accepted

## Context

KRYLO should reduce routine prompts without removing meaningful human control.

## Decision

Automate safe local work. Gate production, destructive, financial, release, identity, secret, and external-write actions.

## Consequences

- Some tasks still require one precise question or approval.
- Risk classification and hook enforcement are required.
