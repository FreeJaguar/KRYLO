# ADR-0023: Multi-host product and shared KRYLO Core

## Status

Accepted

## Context

KRYLO 0.1.x is implemented and distributed as a Claude Code plugin. The product is now approved to support Claude Code and Codex as equal first-class execution hosts without duplicating Orbit, evidence, completion, approval, security, tool-governance, telemetry, or adapter policy.

Host session identifiers and host-specific Hook/model schemas are platform details. Treating them as Core identity would couple persisted state and policy to one host and would make a second implementation drift over time.

See `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` for the full approved architecture and `docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md` for the Foundation-phase implementation plan this ADR authorizes.

## Decision

- Claude Code and Codex are equal first-class KRYLO hosts.
- KRYLO has one Shared Core and thin host-specific adapters.
- KRYLO owns `runId`; host session and prompt/turn identifiers are metadata attached to a run.
- Shared Core owns run state, Orbit, evidence, completion, approvals, tool governance, data-egress policy, telemetry/privacy, external-adapter policy, and logical agent roles.
- Host adapters own invocation syntax, host Hook input/output translation, host session metadata, host agent configuration, model mapping, packaging, and setup mechanics.
- KRYLO remains explicit-only on every host and is not the default orchestrator for ordinary sessions.
- KRYLO maintains one product version across host surfaces.

## Supersession and scope

- This ADR supersedes the Claude-only product scope of ADR-0001 while preserving its GitHub-hosted Claude marketplace decision for the Claude host.
- ADR-0002 remains authoritative for the Claude `/krylo:run` command and optional `/krylo` wrapper; Codex receives its own explicit host invocation in a later ADR.
- ADR-0006 remains the Claude-host model-routing decision until host-neutral model routing is documented and Codex mapping is implemented.
- ADR-0009 is generalized: KRYLO is not the default orchestrator on either host.
- ADR-0021 remains authoritative for Claude Skill-scoped Hooks and is not superseded.

## Consequences

- Existing Claude behavior must be regression-proven before native Codex implementation begins.
- Shared runtime modules may not depend directly on Claude-only session, option, model, or Hook-output field names.
- Host-specific compatibility shims may remain in host adapters when a platform contract is undocumented or version-dependent, but they cannot become Core contracts.
- Architectural changes for Codex packaging, cross-harness workers, maintenance automation, and generalized compatibility policy require their own ADRs.

## Supersedes

Narrows ADR-0001 (Claude-only product scope), ADR-0002 (public command surface only), ADR-0006 (Claude-host model routing only), ADR-0009 (generalized to both hosts). None are marked Superseded status; each remains Accepted with narrowed scope as described above.

## Superseded by

None.
