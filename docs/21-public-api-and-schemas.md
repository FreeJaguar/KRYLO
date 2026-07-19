# Public API and Schema Contracts

## Public commands

The command names documented in `docs/01-command-surface.md` are public API.

## Run-state schema

The schema must be versioned and include:

- Identifiers.
- Project metadata.
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
