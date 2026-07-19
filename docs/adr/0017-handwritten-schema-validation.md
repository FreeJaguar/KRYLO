# ADR-0017: Validate runtime state with a hand-written structural validator

## Status

Accepted

## Context

`docs/02-runtime-state-machine.md` requires validating persisted state against the schema. ADR-0012 requires dependency-light Node.js ESM. A full JSON Schema validator (for example Ajv) would be the project's only production dependency and a supply-chain surface.

## Decision

The public contract remains the JSON Schema files under `plugins/krylo/schemas/`. The runtime validates state with a hand-written structural validator (`scripts/lib/state.mjs`) covering required fields, types, enums, patterns, and length limits. Automated tests parse the schema files and cross-check that the validator's required-field lists and enums stay in sync with the schemas. `validate-runtime.mjs` repeats this consistency check at runtime.

## Consequences

- Zero production dependencies are preserved.
- Schema and validator cannot silently diverge because tests fail on mismatch.
- Complex conditional schema features must be avoided or mirrored manually; the run-state schema is intentionally kept structural.
