# KRYLO Threat Model

## Protected assets

- User source code.
- Repository history and uncommitted work.
- Secrets and credentials.
- Production systems and data.
- External service accounts.
- KRYLO policy integrity.
- Marketplace and release integrity.
- User trust in completion reports.
- Local runtime metadata.

## Adversaries

- Malicious repository content.
- Malicious issue or pull-request text.
- Compromised dependency or marketplace source.
- Malicious or compromised MCP server.
- Prompt injection in external documentation.
- Over-privileged tool configuration.
- Accidental user misconfiguration.
- A model attempting to finish prematurely or overstate evidence.
- A contributor introducing unsafe default behavior.
- A host adapter that mistranslates or bypasses Shared Core policy when normalizing platform-specific metadata.

## Threats and controls

### Prompt injection

Threat:
External content instructs KRYLO to ignore policy, expose secrets, or perform actions.

Controls:

- Treat external text as data, not policy.
- Keep policy in plugin-controlled Markdown and deterministic gates.
- Require approval for external writes and production actions.
- Do not execute externally supplied commands without independent validation.

### Tool poisoning

Threat:
An MCP server changes tool descriptions or behavior to obtain broader access.

Controls:

- Tool trust registry.
- Version and publisher review.
- MCP audit command.
- Read-only default.
- Project-scoped credentials.
- Data-egress policy.

### Source-code or secret exfiltration

Threat:
A tool, hook, telemetry path, or final report sends sensitive content externally.

Controls:

- Local-only telemetry.
- No raw prompts or arguments in state.
- Redaction before display.
- External-adapter approval policy.
- Secret-file protection.
- No KRYLO-owned analytics endpoint.

### Command injection

Threat:
Untrusted text becomes part of a shell command.

Controls:

- Prefer exec-form process invocation with argument arrays.
- Avoid shell interpolation.
- Validate paths and identifiers.
- Never execute retrieved command text directly.

### Path traversal and symlink attacks

Threat:
A repository path escapes the worktree or targets sensitive host files.

Controls:

- Resolve and validate paths.
- Restrict KRYLO writes to plugin data, temporary directories, and the active worktree.
- Refuse writes through symlinks that escape allowed roots.

### Host adapter boundary drift

Threat:
A host adapter (Claude Host, Codex Host) translates platform-specific session, Hook, or model metadata into KRYLO's host-neutral contracts in a way that weakens or bypasses risk, approval, or completion policy, or a future cross-provider capability is treated as active before it is implemented and verified.

Controls:

- Shared Core owns risk classification, approvals, and completion policy; a host adapter may only translate metadata into host-neutral contracts, never redefine that policy.
- The Claude Host is implemented and released. The Codex Host is implemented (`docs/adr/0029-codex-host-packaging-and-approval-boundary.md`) but not yet published; no cross-harness or cross-provider data flow exists until a separate, approved plan is implemented and verified.
- Shared Core modules do not read host-specific environment variables or Hook payload fields directly (`docs/adr/0023-multi-host-product-and-shared-core.md`); an automated `hostIsolation` check (`npm run validate:runtime`) scans `scripts/lib/` for Claude-specific identifiers on every validation run.
- The Codex Host's `require-approval` boundary is a documented capability-driven asymmetry, not a silent weakening: because current Codex `PreToolUse` output does not support a native `ask` decision, and the rules/`PreToolUse`/`approval_policy` execution order is not documented upstream, KRYLO denies every `require-approval` action deterministically on Codex rather than trust an unverified mechanism (`docs/codex-capability-matrix.md`).
- A new host adapter's PreToolUse deny path must never emit a decision shape the target host has confirmed unsupported (Codex: `permissionDecision:"ask"`, legacy `decision:"approve"`, `continue:false`, `stopReason`, `suppressOutput`) -- `risk-gate-codex.mjs`/`permission-request-codex.mjs` have no code path capable of producing any of them.

### Premature or false completion

Threat:
KRYLO claims success without tests, evidence, or resolved findings.

Controls:

- Completion contract.
- Deterministic stop gate.
- Independent verifier and reviewer.
- Evidence bundle.
- Explicit terminal state.

### Infinite or wasteful iteration

Threat:
The loop repeats without progress and consumes time or tokens.

Controls:

- Lane-specific iteration budget.
- Failure fingerprints.
- Stagnation detection.
- Strategy-change rule.
- Hard terminal state at the iteration limit.

### Supply-chain compromise

Threat:
A dependency, action, plugin, or release asset is compromised.

Controls:

- Minimal dependencies.
- Exact versions and lockfiles.
- GitHub Actions pinned to full commit SHAs.
- Dependency, secret, and workflow scans.
- SBOM and release attestation.
- No install-time remote code download in KRYLO Core.

### User-settings corruption

Threat:
Setup overwrites or weakens user configuration.

Controls:

- UserConfig for normal preferences.
- Explicit setup dry run for external changes.
- Backup before alias or status-line installation.
- Semantic merge, not string replacement.
- Uninstall and rollback support.
