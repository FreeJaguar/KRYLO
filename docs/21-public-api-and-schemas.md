# Public API and Schema Contracts

## Public commands

The command names documented in `docs/01-command-surface.md` are public API.

## Run-state schema

The schema must be versioned and include:

- `runId`: the KRYLO-owned run identifier. It is never a raw host session identifier.
- `host`: the host this run executes on, with `host.name` (`claude` or `codex`), `host.sessionId`, and optional `host.turnId`. This describes where the run executes.
- `delegation`: `delegation.externalWorker` (boolean), `delegation.depth`, and optional `delegation.parentRunId`. This describes how the run was reached, directly or as a bounded delegation from another run.
- Project metadata: a hash of the project root only. Host data roots and raw project paths are never persisted.
- Lane and risk.
- Goal and criteria.
- Agent and model records.
- Tool counters.
- Evidence references.
- Orbit data.
- Terminal state.

## Agent-result schema

Required fields:

- `status`
- `summary`
- `evidence`
- `filesInspected`
- `filesModified`
- `commandsExecutedSummary`
- `findings`
- `risks`
- `unresolvedItems`
- `recommendedNextAction`

## Evidence schema

Evidence records include:

- Type.
- Label.
- Timestamp.
- Source tool.
- Result status.
- Safe summary.
- Optional artifact path.
- Staleness marker.

They do not include secrets, raw commands, or full output by default.

## Tool record schema

Tool records include:

- Stable ID.
- Publisher and source.
- Version or commit.
- Trust tier.
- Capabilities.
- Data-egress declarations.
- Approval requirements.
- Blocked ranges.
- Review date.
