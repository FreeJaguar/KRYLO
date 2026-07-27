# Contributing to KRYLO

## Contribution principles

- Keep KRYLO Core small.
- Prefer policies and adapters over mandatory integrations.
- Add deterministic code only where it improves safety or repeatability.
- Do not add a new agent when an existing role can handle the task.
- Do not add an external dependency without a measurable benefit and security review.
- Preserve cross-platform behavior.
- Preserve local-only telemetry.
- Preserve manual control over production and destructive actions.

## Required change process

1. Open or link an issue describing the user problem.
2. Identify whether the change affects product behavior, policy, security, schemas, commands, agents, hooks, or adapters.
3. Add or update an ADR for architectural changes.
4. Update relevant documentation before or with code.
5. Add tests and evaluation cases.
6. Run plugin validation and the complete project test suite.
7. Update the changelog.
8. Submit a focused pull request.

## Pull-request requirements

A pull request must include:

- Problem statement.
- Scope and non-goals.
- Security impact.
- Compatibility impact.
- Test evidence.
- Documentation changes.
- Rollback plan for high-risk changes.

## Security-sensitive changes

A change to any of the following requires a security-focused review before merge, not just a normal code review:

- `plugins/krylo/scripts/security/*.mjs` (risk gate, MCP classifier, question gate).
- `plugins/krylo/policies/*.json` (production policy, MCP policy, environment profiles) and `plugins/krylo/catalog/*.json` (Tool Trust Registry).
- `plugins/krylo/scripts/lib/state.mjs` risk-approval handling, `plugins/krylo/scripts/lib/action-fingerprint.mjs`, `plugins/krylo/scripts/lib/lock.mjs`.
- Anything touching the KRYLO data root, active-run pointers, or path resolution (`plugins/krylo/scripts/lib/paths.mjs`).
- Hook wiring (`plugins/krylo/hooks/hooks.json`, any Skill frontmatter `hooks:` block).

For these, a pull request must additionally include:

- The specific bypass or abuse scenario the change closes or could newly open (a new gated action class, a new approval-matching dimension, a new path-traversal vector, etc.).
- A regression test that fails against the pre-change code and passes after it.
- Confirmation that `SECURITY.md` and `THREAT_MODEL.md` still match the resulting behavior, updating them in the same PR if not.
- An ADR when the change alters an existing security decision (approval scoping, gated action classes, hook-scoping, environment profiles) rather than adding a new pattern within an existing one.

## Prohibited contribution patterns

- Unpinned remote installation commands.
- New telemetry endpoints.
- Hidden external data transfer.
- Automatic production writes.
- Unsupported Claude Code configuration fields.
- Broad permission bypasses.
- Copying third-party skill content without license review and attribution.
- Bundling another orchestration framework into KRYLO Core.
