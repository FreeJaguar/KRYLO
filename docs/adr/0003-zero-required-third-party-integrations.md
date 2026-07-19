# ADR-0003: Keep KRYLO Core independent of third-party integrations

## Status

Accepted

## Context

External plugins and MCP servers increase context, permissions, failure modes, and supply-chain risk.

## Decision

KRYLO Core requires only Claude Code, Git for repository work, and a supported Node.js runtime for deterministic scripts. All other tools are adapters.

## Consequences

- KRYLO works on clean installations.
- Adapter capability may degrade gracefully.
- Setup must not bulk-install tools.
