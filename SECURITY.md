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
- MCP and other external tools are classified by server/namespace and operation, not by tool name alone; an MCP server whose name cannot be positively identified (unrecognized, blocked, or a malformed tool-name shape) is always hard-denied, for both read- and write-shaped operations, regardless of permission mode (`docs/adr/0018-mcp-and-external-tool-gating.md`). A server that IS recognized (catalogued) but has no configured write classification (e.g. a read-oriented documentation server) passes through ungated -- this is a distinct case from "unrecognized," not a gap in the unrecognized-server guarantee. Two servers with a documented but not-yet-runtime-enforced write restriction (OmniRoute, code-review-graph) are tracked as follow-up work in `policies/mcp-policy.json`'s own rules, not silently assumed covered.
- Human-approval authority belongs to the host's own native permission UI, not to any KRYLO-local state a prompt-injected model could forge or manipulate. For the Bash, PowerShell, and MCP tool surfaces, for EVERY require-approval class (production deployment, production data writes, destructive operations, package publication, release creation, merge, IAM/secrets, payment, external messages, external writes, git push, git force-push), and only when `permission_mode` is in the live-verified allowlist (`auto`, `manual`, `default`; `docs/adr/0025-native-permission-approval.md`, `docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md`), a required-approval action routes to Claude Code's native `permissionDecision: "ask"` prompt. Every other case -- a permission mode outside that allowlist (including `bypassPermissions`, `plan`, `acceptEdits`, `dontAsk`, an absent field, or any future/renamed mode), a malformed/unrecognized/blocked MCP server (which has no identity a human could meaningfully approve, so it stays a hard `deny` regardless of mode), or a genuine evaluation failure -- is denied deterministically instead, never merely gated behind a KRYLO-local approval record that could authorize it on its own. Reading a protected secret path is denied identically whether the tool is Bash, Write, or Read/Glob/Grep -- a model must not be able to bypass a secret-path denial merely by switching tools. A KRYLO-local risk-approval record (`docs/adr/0019-scoped-single-use-approvals.md`'s scoped/bound/single-use design) may still exist for audit and run-completion bookkeeping, but cannot independently authorize execution.
- **Live-verified: a pre-existing Claude Code `permissions.allow` rule does not bypass a KRYLO hook's native `ask`** (`docs/adr/0028-foundation-final-closure.md`), tested against the pinned floor binary on both Bash and PowerShell, from two independent settings sources. The model is also denied outright from writing to Claude Code's own `.claude/settings.json`/`.claude/settings.local.json`, or to the KRYLO plugin's own installed hook/policy files (scoped to the installed location, distinct from KRYLO's own source repository), for the Write/Edit/NotebookEdit tools directly and for a Bash/PowerShell command that textually references either path. Like every other text-matching check in this file, this is defense-in-depth against an unsophisticated attempt via Bash/PowerShell, not a guarantee against every possible shell-level indirection (a variable holding the filename, `cd` into the directory first, etc.).
- **The Risk Gate is defense in depth, not an operating-system sandbox.** It is a policy layer that intercepts tool calls the active host reports to it; it does not confine process, filesystem, or network access at the OS level. Treat it as one control among several (least-privileged credentials, isolated environments, human approval), not as a substitute for OS- or container-level isolation.
- **Host adapters are a trust boundary.** A host adapter (Claude Host today; a future Codex Host) may translate platform-specific session, Hook, and model metadata into KRYLO's host-neutral contracts, but it cannot redefine KRYLO's risk classification, approval, or completion policy. Only the Claude Host is implemented and released; no cross-provider or cross-harness data flow exists until a separate, approved host plan implements and verifies it.

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
