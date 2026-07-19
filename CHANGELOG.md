# Changelog

All notable changes to KRYLO will be documented in this file.

The project follows Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-07-19

Initial implementation of the KRYLO plugin and marketplace from blueprint 0.1.2.

### Added

- Marketplace catalog (`.claude-plugin/marketplace.json`) and plugin manifest with `userConfig` preferences.
- Five skills: `run`, `setup`, `doctor`, `audit-tool`, `status`.
- Twelve agents with portable model aliases and read-only tool boundaries.
- Deterministic Node.js ESM runtime (zero dependencies): run state with atomic writes and corruption recovery, redaction, local-only telemetry with whitelist fields and retention cleanup.
- KRYLO Orbit: deterministic Stop gate, failure fingerprints, stagnation detection, six terminal states, hard iteration cap.
- Question gate (one-use exceptional token) and risk gate (production, destructive, publish, release, push, merge, IAM/secret, payment, external-message classes; sensitive-path protection).
- Subagent status-line renderer, agent-event capture, optional user-level status wrapper (ADR-0016).
- Setup, doctor, alias install/remove with dry run, ownership marker, backup, and rollback.
- Tool trust catalog, trust policy, blocked-versions registry, publisher registry, data-egress and environment-profile policies, MCP policy, nine adapter policies.
- Behavioral evaluation scenarios and full node:test suite (unit, hooks, security, platform, status, setup, governance).
- Nine CI workflows with actions pinned to full commit SHAs and least-privilege permissions; Dependabot; CODEOWNERS.
- ADR-0016 (subagent status line deferred to CLI ≥ 2.1.207) and ADR-0017 (hand-written schema validator strategy).

### Notes

- `BLUEPRINT_MANIFEST.json` remains the immutable blueprint record; `RELEASE_MANIFEST.json` records the implemented repository.
- Publication (repository creation, push, release, marketplace submission) is approval-gated and did not occur in this release preparation.

## [0.1.2] - 2026-07-19

### Changed

- Reduced the root `CLAUDE.md` from 222 lines to 112 lines.
- Converted `CLAUDE.md` into a concise repository control index with direct references to authoritative documents.
- Added an explicit 130-line maximum for the root `CLAUDE.md` to the architecture, implementation plan, prompt contract, manifest, and review checklist.
- Regenerated blueprint hashes and the distribution archive.

## [0.1.1] - 2026-07-19

### Added

- Root `CLAUDE.md` for contributors and Claude Code repository work.

### Changed

- Reading order, implementation contract, architecture, manifest, and review checklist were updated to include `CLAUDE.md`.

## [0.1.0] - Planned

Initial public plugin release.
