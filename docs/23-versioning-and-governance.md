# Versioning and Governance

## Ownership

The project should define maintainers and CODEOWNERS for:

- Plugin manifests.
- Hooks and runtime security.
- Agent prompts.
- Tool catalog.
- CI and release workflows.
- Documentation and ADRs.

## Decision process

Architectural decisions require an ADR. Security blocks may be introduced immediately with a concise emergency ADR and follow-up review.

## Tool catalog governance

A tool review records:

- Reviewer.
- Date.
- Version or commit.
- Source.
- Permissions.
- Network destinations.
- Secrets used.
- Hooks.
- Decision.

Catalog updates require review from a security owner.

## Release governance

- Protected main branch.
- Required CI.
- Signed or attested releases where practical.
- Changelog and version bump.
- No direct production publication from unreviewed pull requests.
