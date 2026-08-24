# ADR-0022: Claude Code compatibility policy — pinned floor plus separate current-version check

## Status

Accepted

## Context

`validate-plugin.yml` installs `@anthropic-ai/claude-code@2.1.211` (the minimum supported version) and runs strict plugin/marketplace validation against it. That pin is deliberate: it is the release-producing, PR-blocking compatibility floor, and it must never silently drift to whatever CLI version happens to be current when the workflow runs — an unpinned `@latest` install in that job would make the same commit pass or fail non-deterministically as upstream ships new CLI releases, and a breaking upstream schema change could block every PR with no actionable signal.

At the same time, KRYLO only benefits users if it keeps working on the CLI they actually have installed, which is normally newer than the pinned floor. Nothing in the pinned job exercises that.

### Version bump: 2.1.197 → 2.1.211 (security-hardening checkpoint)

ADR-0025 (native permission approval) requires a Claude Code version where official documentation guarantees that a PreToolUse Hook's `permissionDecision: "ask"` reliably produces a blocking human prompt, rather than being silently overridden by auto-mode or other permission configuration (`anthropics/claude-code#39344`; ADR-0024's original context). This project's own CHANGELOG (`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, checked in full through the current released version) states, for v2.1.211 exactly:

> Fixed auto mode overriding a PreToolUse hook's `ask` decision for unsandboxed Bash — a hook `ask` now floors the decision at a prompt

No earlier version's CHANGELOG entry states this, so 2.1.211 is the minimum version this decision can rely on. The floor is raised to exactly that version — not further — because raising it past what the decision actually requires would be an unjustified, undocumented tightening; see ADR-0025 for why `ask` is deliberately *not* extended to PowerShell or MCP tools despite the floor now covering versions where later, unrelated PowerShell-specific permission fixes also shipped (2.1.212, 2.1.214) — none of those later entries restate the same auto-mode-`ask`-flooring guarantee for those tool types, so this ADR does not claim they do.

This bump is a real cross-reference to check going forward: ADR-0016 (`subagentStatusLine`, requires 2.1.207) was deferred solely because the previous 2.1.197 floor was below that requirement. The new 2.1.211 floor is now above it — this ADR does not itself implement `subagentStatusLine` (out of this checkpoint's scope), but ADR-0016 should be revisited as a now-unblocked, not-yet-implemented opportunity.

## Decision

Two separate, independently-scoped checks:

1. **Pinned floor (`validate-plugin.yml`, unchanged)** — runs on every push to `main` and every PR, installs `@anthropic-ai/claude-code@2.1.211` exactly, and is a required, PR-blocking check. This version is the documented minimum supported Claude Code release and changes only through an explicit ADR update, never automatically.
2. **Current-version compatibility (`claude-code-compat.yml`, new)** — runs on a weekly schedule and on manual `workflow_dispatch`, installs `@anthropic-ai/claude-code@latest` (intentionally unpinned — that is the entire point of the check), and runs the same strict plugin/marketplace validation plus the full test suite. It never runs on `push` or `pull_request` and is not a required check, so a failure here can never block a PR or a release.

A failure of the current-version job:

- Produces a normal failed GitHub Actions run (visible in the Actions tab and, if configured by the repository owner, via the default failed-scheduled-workflow email/notification) — clear, durable evidence.
- Does **not** change `validate-plugin.yml`'s pinned version, touch `RELEASE_READINESS.md`'s stated minimum, or otherwise mutate any file. Any version bump is a separate, human-reviewed change.

## Version upgrade policy

- The pinned minimum (`validate-plugin.yml` and every doc that states it) advances only when a maintainer deliberately reviews a `claude-code-compat.yml` failure or a new CLI release, decides KRYLO now requires it, and updates the pin, this ADR, and `RELEASE_READINESS.md` together in one reviewed change.
- The floor is never advanced by CI itself, by a scheduled run, or as a side effect of an unrelated commit.

## Handling breaking Claude Code schema changes

- A `claude-code-compat.yml` failure caused by a schema/behavior change upstream is triaged as a normal bug: reproduce locally against the new CLI, determine whether KRYLO's plugin/hook/skill manifests need updating for the new schema, and whether the minimum supported version should move forward (dropping compatibility with older CLI lines) or whether KRYLO can support both old and new shapes.
- Until triaged and fixed, the pinned floor and the shipped plugin are unaffected: users on the pinned floor or between the floor and the breaking version continue to work exactly as before, because the pinned job never installs the newer, breaking CLI.

## Consequences

- The release-producing job stays fully deterministic and pinned; only a deliberate, reviewed commit ever changes what "minimum supported" means.
- Drift against the current published CLI is caught within a week (or on demand) instead of silently, without ever gating a release or a PR on it.
- A `claude-code-compat.yml` failure is a triage signal for maintainers, not an automatic policy change.
