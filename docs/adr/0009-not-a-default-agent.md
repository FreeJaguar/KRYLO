# ADR-0009: Do not make KRYLO the default Claude Code agent

## Status

Accepted

## Context

Users still need lightweight ordinary Claude Code conversations. A global orchestrator would add cost and complexity to simple questions.

## Decision

KRYLO activates only through its explicit command.

## Consequences

- Normal sessions remain lightweight.
- The user controls when orchestration begins.
- Setup must not write an `agent` default.

## Superseded by

Not superseded. ADR-0023 (multi-host product and shared KRYLO Core) generalizes this decision from "not the default Claude agent" to "not the default orchestrator on either host" (Claude Code and Codex).
