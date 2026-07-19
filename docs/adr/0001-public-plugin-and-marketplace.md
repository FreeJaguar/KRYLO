# ADR-0001: Distribute KRYLO as a public plugin and marketplace

## Status

Accepted

## Context

KRYLO must be installable, versioned, testable, and usable across projects by people who do not have a prior local KRYLO setup.

## Decision

Use a GitHub repository containing a Claude Code marketplace catalog and the KRYLO plugin under `plugins/krylo/`.

## Consequences

- Community installation and updates are supported.
- Plugin skills are namespaced.
- Public release processes and supply-chain controls become mandatory.
