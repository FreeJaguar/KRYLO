# ADR-0007: Keep KRYLO telemetry local-only

## Status

Accepted

## Context

Operational visibility is useful, but external analytics could expose repository metadata, prompts, or user behavior.

## Decision

Persist only approved metadata locally under plugin data. Provide no KRYLO-owned analytics endpoint.

## Consequences

- Privacy risk is reduced.
- Cross-device dashboards are out of scope.
- Retention and redaction require tests.
