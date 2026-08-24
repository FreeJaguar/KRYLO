# Runtime State Machine

## States

```mermaid
stateDiagram-v2
    [*] --> INITIALIZING
    INITIALIZING --> CLASSIFYING
    CLASSIFYING --> PLANNING
    PLANNING --> EXECUTING
    EXECUTING --> VERIFYING
    VERIFYING --> REVIEWING
    REVIEWING --> CORRECTING: criteria or findings remain
    CORRECTING --> VERIFYING
    REVIEWING --> COMPLETING: all required evidence exists
    VERIFYING --> BLOCKED: external blocker
    EXECUTING --> AWAITING_DECISION: material user decision
    EXECUTING --> AWAITING_RISK_APPROVAL: risky action
    CORRECTING --> ITERATION_LIMIT: budget exhausted
    COMPLETING --> VERIFIED_COMPLETE
    BLOCKED --> SAFE_BLOCKED
    AWAITING_DECISION --> USER_DECISION_REQUIRED
    AWAITING_RISK_APPROVAL --> RISK_APPROVAL_REQUIRED
    ITERATION_LIMIT --> ITERATION_LIMIT_REACHED
    INITIALIZING --> CANCELLED_BY_USER
    EXECUTING --> CANCELLED_BY_USER
```

## Run-state ownership

The deterministic runtime owns state transitions. The model proposes actions and reports evidence, but may not directly mark a run complete without satisfying the completion gate.

## Required run-state fields

- Schema version (currently `1.1.0`).
- KRYLO version.
- Host identity: host name, host session identifier, and optional host turn identifier.
- Delegation: whether the run is an external-worker delegation, its depth, and an optional parent run identifier.
- KRYLO-owned run identifier, independent of the host session identifier.
- Project root hash and repository metadata.
- Lane, risk, and complexity.
- Normalized goal.
- Acceptance criteria.
- Constraints and non-goals.
- Selected agents and configured models.
- Resolved models when available.
- Tool counters.
- Orbit budget and current cycle.
- Failure fingerprints.
- Findings and criterion status.
- Evidence references.
- Terminal state.
- Timestamps.

## Schema versioning and migration

Schema `1.1.0` introduced host-neutral identity. It replaced the prior flat `sessionId` field with a `host` object (`name`, `sessionId`, optional `turnId`) and added a `delegation` object (`externalWorker`, `depth`, optional `parentRunId`). Migration from schema `1.0.0` is deterministic and one-directional: the legacy `sessionId` becomes `host.sessionId` with `host.name` set to `claude` (the only host that produced `1.0.0` state), and `delegation` defaults to a non-delegated, depth-0 run. A document with any other prior schema version, or a `1.0.0` document missing `sessionId`, is refused rather than guessed and the original file is left untouched.

Migration to the current schema happens purely in memory, inside `loadState()`; `loadState()` never writes to disk under any circumstance. `saveState()` is the only place a migration is actually committed: if the schema version currently on disk differs from the schema version being saved, the exact original on-disk bytes are backed up first (`state.pre-migration-<oldVersion>-<epoch>.json`), then the migrated-and-mutated state is written. Every real mutator already calls `saveState()` from inside the run's exclusive lock, so this backup-then-persist is exactly as serialized as any other state mutation; a bare unlocked read (`read-state.mjs`, statusline/doctor/stagnation readers, a Hook's initial active-run check) can migrate a document in memory for its own use but can never persist that migration.

Refused or corrupted state is never overwritten with a fabricated replacement. `loadState()` copies the original file (or, if the file itself was already missing, the raw bytes it tried to parse) to `state.corrupt-<epoch>.json` beside it, then returns `{ ok: false, error: 'corrupted', recovered: true, corruptPath }` so the caller can report the problem; it never initializes a fresh recovery state on the caller's behalf.

## Persistence

State is stored under a KRYLO-owned data root resolved by the active host adapter (`${CLAUDE_PLUGIN_DATA}` on the Claude Host) using atomic writes:

1. Write a temporary file.
2. Flush when supported.
3. Rename over the prior state.
4. Validate against the schema.

Corrupted or schema-invalid state must not be trusted. KRYLO preserves the original file as `state.corrupt-<epoch>.json` for diagnosis and reports the problem; it does not initialize a fresh state on its own.

## Resumption

A resumed run must verify:

- The project root is unchanged.
- The current repository is compatible with the saved run.
- The current HEAD and working tree have not diverged in a way that invalidates the plan.
- Background agents are not assumed active after process restart.
- Evidence from prior commands is marked stale when the repository changed.
