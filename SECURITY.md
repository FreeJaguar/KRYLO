# KRYLO Security Policy

## Security posture

KRYLO is a high-privilege development orchestrator. Its security goal is not to make every action automatic. Its goal is to automate low-risk local work while preserving explicit human control over destructive, external-write, production, financial, release, identity, and secret-management actions.

## Core controls

- KRYLO is manually invoked.
- KRYLO is not the default agent.
- Optional tools are deny-by-default until detected and allowed by policy.
- External content is untrusted data.
- Runtime telemetry is local-only.
- Raw prompts, tool arguments, commands, source code, stack traces, database values, and secrets are not persisted.
- Read-only agents cannot write application files.
- Only one normal application-code writer operates in a worktree.
- Production and destructive actions require approval.
- The Orbit loop is bounded.
- Tool versions may be blocked independently of tool names.

## Mandatory approval classes

Human approval is required for:

- Production deployment.
- Production database writes or migrations.
- Destructive database operations.
- Package publication.
- Release creation.
- Git push, merge, branch deletion, or force push unless the active task explicitly requested the exact action and the risk gate still permits it.
- IAM, RBAC, firewall, DNS, and secret changes.
- Payment, refund, payout, or billing actions.
- External messages to broad audiences.
- Figma, issue-tracker, or documentation writes not explicitly requested.
- Any operation with irreversible or materially harmful consequences.

## Vulnerability reporting

The public repository should enable GitHub private vulnerability reporting. Reports should include:

- Affected version.
- Reproduction steps.
- Expected and actual behavior.
- Security impact.
- Suggested remediation when available.

Do not disclose a vulnerability publicly before a fix or coordinated disclosure decision.

## Release security

Each release should include:

- Plugin validation.
- Unit and integration tests.
- CodeQL or equivalent SAST.
- Dependency vulnerability scanning.
- Secret scanning.
- GitHub Actions linting and hardening checks.
- SBOM generation.
- Release checksums.
- Artifact attestation or signing where practical.

## Supported versions

Until the project reaches stable maturity, only the latest minor release line is supported. Critical security fixes should be backported only when a public user base depends on an older line.
