# ADR-0015: Use plugin userConfig for preferences

## Status

Accepted

## Context

Language, autonomy, Orbit budget, status detail, telemetry, and security profile should be configurable without manual JSON editing.

## Decision

Declare these preferences in plugin `userConfig`, using secure storage only for small sensitive values if future features truly require them.

## Consequences

- Onboarding is standardized.
- Preferences are available to plugin subprocesses.
- UserConfig is not used for large secrets or repository content.
