# ADR-0016: Ship the subagent status-line renderer but defer the plugin settings key

## Status

Accepted

## Context

`docs/08-status-lines.md` plans a `subagentStatusLine` entry in plugin `settings.json`. Official documentation (checked 2026-07-19) confirms plugin settings support only the `agent` and `subagentStatusLine` keys, and records `subagentStatusLine` as supported from Claude Code v2.1.207. The implementation environment runs v2.1.196/2.1.197, and the plugin must remain installable and strictly valid on the currently released CLI line.

## Decision

KRYLO 0.1.0 ships `scripts/status/subagent-statusline.mjs` (fully tested) but does not ship a plugin `settings.json`. `/krylo:setup` may offer the renderer as a user-level status-line wrapper under the existing dry-run/backup rules. The plugin `settings.json` with `subagentStatusLine` will be added in a later release once the minimum supported Claude Code version is at least 2.1.207.

## Consequences

- 0.1.0 validates strictly on current CLI releases.
- Subagent status rendering is available through setup instead of automatically.
- A follow-up release adds the settings key and removes this limitation.

## Update (security-hardening checkpoint, ADR-0022 amendment)

ADR-0022's pinned Claude Code compatibility floor was raised from `2.1.197` to `2.1.223` for an unrelated reason (ADR-0025, native permission approval). `2.1.223` is above this ADR's `2.1.207` requirement, so the original blocking reason no longer applies. Implementing the plugin `settings.json` `subagentStatusLine` key itself was out of scope for that checkpoint and was not done here; this is recorded as a now-unblocked, not-yet-implemented follow-up, not a completed change.
