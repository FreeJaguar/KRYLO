# License Decision

## Decision

Use the Apache License 2.0 for KRYLO Core.

## Rationale

- Permissive use for individuals, companies, and public projects.
- Explicit patent grant.
- Clear notice and attribution requirements.
- Suitable for a public developer-tool plugin.

## Third-party content

KRYLO must not copy third-party skills, prompts, scripts, or documentation without license review. Integrations should prefer detection and invocation of separately installed tools.

The implementation repository must include:

- `LICENSE`
- `NOTICE` when required
- `THIRD_PARTY_NOTICES.md`
- A dependency license inventory in release artifacts
