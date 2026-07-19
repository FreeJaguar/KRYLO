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

## Prohibited contribution patterns

- Unpinned remote installation commands.
- New telemetry endpoints.
- Hidden external data transfer.
- Automatic production writes.
- Unsupported Claude Code configuration fields.
- Broad permission bypasses.
- Copying third-party skill content without license review and attribution.
- Bundling another orchestration framework into KRYLO Core.
