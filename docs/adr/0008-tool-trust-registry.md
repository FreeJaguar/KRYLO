# ADR-0008: Govern optional tools through a trust registry

## Status

Accepted

## Context

A tool name alone does not establish safety. Version, publisher, configuration, network behavior, and permissions matter.

## Decision

Maintain reviewed and blocked tool records with trust tiers and re-review triggers.

## Consequences

- Tool policy can change without changing agent prompts.
- Catalog maintenance becomes a security responsibility.
- Unreviewed versions are not auto-approved.
