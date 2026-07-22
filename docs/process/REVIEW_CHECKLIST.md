# Architecture Review Checklist

Approve this blueprint only when every item is answered.

## Product

- [ ] The official command `/krylo:run` is acceptable.
- [ ] The optional `/krylo` wrapper is acceptable.
- [ ] The v0.1.0 scope is small enough to implement and test.
- [ ] Non-goals are explicit.
- [ ] The six terminal states are sufficient.

## Architecture

- [ ] Root `CLAUDE.md` is no longer than 130 lines, repository-scoped, and acts as a routing index to authoritative documents instead of duplicating them.
- [ ] Every file and document range referenced by `CLAUDE.md` exists and resolves to the intended authoritative source.
- [ ] Every path referenced by `CLAUDE.md` exists and resolves inside the repository.
- [ ] Detailed policy remains in ADRs, root specifications, numbered docs, and `archive/blueprint-v0.1.2/references/`, not duplicated in `CLAUDE.md`.
- [ ] The installer never copies the repository `CLAUDE.md` into user application repositories.
- [ ] The plugin is not the default Claude Code agent.
- [ ] KRYLO Core has no mandatory third-party integration.
- [ ] Runtime state is outside application repositories.
- [ ] The Markdown control plane is separated from deterministic scripts.
- [ ] The loop is bounded and delta-based.
- [ ] One writer per worktree is enforced by orchestration.

## Models and agents

- [ ] Static agent definitions use portable aliases, and optional Fable escalation is capability-checked at runtime.
- [ ] Sonnet is the normal orchestrator and builder model.
- [ ] Haiku is limited to focused discovery and lightweight evaluation.
- [ ] Opus is reserved for complex review, architecture, security, migration, and deep debugging when optional Fable escalation is unavailable or unnecessary.
- [ ] Read-only agents have no Write or Edit tools.
- [ ] The default team is minimal.

## Security

- [ ] Production and destructive actions require approval.
- [ ] External writes require explicit user intent or approval.
- [ ] External content is treated as untrusted.
- [ ] Tool versions and publishers are governed by a trust registry.
- [ ] Telemetry is local-only and excludes sensitive content.
- [ ] Supply-chain controls are part of CI.

## Integrations

- [ ] Superpowers is optional compatibility, not a dependency.
- [ ] OpenWiki is optional and disabled by default.
- [ ] Perplexity is absent.
- [ ] Ralph, Archon, Ruflo, BMAD, and other orchestrators do not control KRYLO.
- [ ] Playwright Test and Playwright MCP have distinct roles.

## Distribution

- [ ] The repository doubles as a marketplace.
- [ ] Semantic versioning is used.
- [ ] Local `--plugin-dir` and local marketplace tests are required.
- [ ] Public push and release are separate approval-gated actions.

## Final decision

- [ ] Approved without changes.
- [ ] Approved with changes listed below.
- [ ] Not approved.

### Requested changes

Record requested changes here before creating the implementation prompt.
