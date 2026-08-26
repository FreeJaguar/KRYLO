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
- Human-approval authority belongs to the host's own native permission UI, not to any KRYLO-local state a prompt-injected model could forge or manipulate. For the Bash, PowerShell, and MCP tool surfaces, for EVERY require-approval class (production deployment, production data writes, destructive operations, package publication, release creation, merge, IAM/secrets, payment, external messages, external writes, git push, git force-push), and only when `permission_mode` is in the live-verified allowlist (`auto`, `manual`, `default`; `docs/adr/0025-native-permission-approval.md`, `docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md`), a required-approval action routes to Claude Code's native `permissionDecision: "ask"` prompt. Every other case -- a permission mode outside that allowlist (including `bypassPermissions`, `plan`, `acceptEdits`, `dontAsk`, an absent field, or any future/renamed mode), a malformed/unrecognized/blocked MCP server (which has no identity a human could meaningfully approve, so it stays a hard `deny` regardless of mode), or a genuine evaluation failure -- is denied deterministically instead, never merely gated behind a KRYLO-local approval record that could authorize it on its own. Reading a protected secret path is denied identically whether the tool is Bash, Write, or Read/Glob/Grep -- a model must not be able to bypass a secret-path denial merely by switching tools. This also covers a filesystem glob expression (`*`/`?`/`[...]` bracket classes, or a bounded brace group) that can expand, at shell/tool level, to a protected name -- not only an exact literal match -- including a glob that specifically constrains its basename toward a protected generic-extension name such as `secret?.json`/`secrets*.yaml`, while a fully generic extension-only glob such as `*.json`/`*.yaml`/`*.toml` remains usable (`docs/adr/0028-foundation-final-closure.md`'s Sections G and H). A KRYLO-local risk-approval record (`docs/adr/0019-scoped-single-use-approvals.md`'s scoped/bound/single-use design) may still exist for audit and run-completion bookkeeping, but cannot independently authorize execution.
- **Live-verified: a pre-existing Claude Code `permissions.allow` rule does not bypass a KRYLO hook's native `ask`** (`docs/adr/0028-foundation-final-closure.md`), tested against the pinned floor binary on both Bash and PowerShell, from two independent settings sources. The model is also denied outright from writing to Claude Code's own `.claude/settings.json`/`.claude/settings.local.json` -- for the Write/Edit/NotebookEdit tools directly, and, as a same-category text-matching defense-in-depth (not a read/write distinction: a Bash/PowerShell command merely reading the file is denied too), for a Bash/PowerShell command that textually references either settings filename -- and from writing to the KRYLO plugin's own installed hook/policy files (scoped to the installed location a real host resolves, distinct from KRYLO's own source repository checkout when running from source), for the Write/Edit/NotebookEdit tools only: an earlier version also scanned Bash/PowerShell command text for any reference to the plugin's installed path, but that denied KRYLO's own mandatory runtime CLI invocations (which are required to name that exact path) and was removed as a self-inflicted regression. Like every other text-matching check in this file, this is defense-in-depth against an unsophisticated attempt, not a guarantee against every possible shell-level indirection (a variable holding the filename, `cd` into the directory first, etc.).
- **Glob/brace analysis of a sensitive path is fail-safe on exhaustion, never fail-open.** Supported glob constructs (`*`, `?`, `[...]`/`[!...]` bracket classes, a bounded non-nested `{a,b,c}` brace group) are analyzed normally against the protected-path policy. Every resource/complexity bound this analysis enforces (bracket-class size, brace branch count/length/group count/candidate count) resolves a genuinely exceeded budget to a deterministic **deny**, never to a silent pass -- an attacker-controlled complexity limit must never turn into "not sensitive." A construct genuinely out of scope for this bounded analyzer (nested braces, a brace range like `{a..z}`, or any future unsupported form) is treated the same way: deterministic deny, not silent inert text (`docs/adr/0028-foundation-final-closure.md`'s Section H). This is a bounded, deterministic check, not a shell interpreter -- it does not claim to analyze arbitrary shell code, only the glob/brace syntax it explicitly supports.
- **The Risk Gate is defense in depth, not an operating-system sandbox.** It is a policy layer that intercepts tool calls the active host reports to it; it does not confine process, filesystem, or network access at the OS level. Treat it as one control among several (least-privileged credentials, isolated environments, human approval), not as a substitute for OS- or container-level isolation.
- **Host adapters are a trust boundary.** A host adapter (Claude Host, Codex Host) may translate platform-specific session, Hook, and model metadata into KRYLO's host-neutral contracts, but it cannot redefine KRYLO's risk classification, approval, or completion policy. Only the Claude Host is released; the Codex Host is implemented (`docs/adr/0029-codex-host-packaging-and-approval-boundary.md`) but not yet published.
- **Cross-Harness cross-provider data flow (ADR-0030) is implemented and gated, not authoritative.** A run may optionally spawn the OPPOSITE provider's own CLI as a read-only, depth-1, advisory worker; the invocation itself is a `require-approval` action reusing the same native-ask/deterministic-deny boundary as every other gated action -- no new local approval mechanism. The worker never receives write-capable tools or MCP access, never receives the parent's full environment, and its result is advisory evidence only: it cannot itself prove a criterion, resolve an approval, or set completion. See `docs/adr/0030-cross-harness-advisory-workers.md`.
  - **Disclosed limitation: the `cross-harness-invocation` approval-class pattern, like every other text-matching `production-policy.json` class, can in principle be evaded** by string-splitting, globbing, shell-variable substitution, or a dynamic `import()` of the same script -- a fresh independent Security Reviewer reproduced this directly. This is not fixed with a KRYLO-local approval-record check inside `cross-harness-run.mjs` itself, because ADR-0025 already establishes, as a deliberate decision, that a local approval record must never independently authorize execution -- the code path to ever set `status: "approved"` on such a record has been permanently removed. Because Cross-Harness egress is irreversible (data leaves to a third-party provider) where most other gated actions are locally reversible, this is a heightened-consequence instance of an already-accepted, system-wide limitation, not a new or Cross-Harness-specific hole. See ADR-0030's "Deferred, disclosed rather than fixed" section and `THREAT_MODEL.md`.
  - **Disclosed limitation: a worker's own filesystem read access is not bounded by Cross-Harness's context controls.** `NEVER_TRANSFER_PATH_PATTERNS`, the context-packet size cap, and `deepRedact` bound what KRYLO sends the worker, not what a worker might independently read via its own read-only tool/sandbox access and thereby transmit to its own provider, if a prompt-injected instruction inside the context packet convinced it to do so. The `securityNotice` field is the only mitigation and explicitly does not claim to be a security boundary. Marked PLAUSIBLE, not CONFIRMED, by the reviewer who raised it. See `THREAT_MODEL.md`.
- **Ecosystem Maintenance (ADR-0031) is read-only, official-source-only, and non-authoritative.** The drift checker never edits a repository file, commits, pushes, or opens/modifies an issue or PR; every upstream fetch is restricted to a fixed GitHub API domain allowlist enforced on every redirect hop, bounded (10s timeout, 2MB response cap, max 3 redirects, at most one retry for a network-level failure only); a network failure becomes an explicit `unavailable` result, never a fabricated "up to date." The scheduled workflow runs `contents: read` only, requires no secret or PAT, and never triggers on `push`/`pull_request`. A detected drift is evidence for a separate, human-approved maintenance task, never an automatic remediation.
- **On the Codex Host, `require-approval` denies deterministically instead of prompting.** Current official Codex `PreToolUse` documentation confirms `permissionDecision: "ask"` is parsed but unsupported and fails the hook if returned -- unlike Claude, Codex has no verified in-hook mechanism to produce (and wait on) the same real human decision. KRYLO's Codex risk gate therefore denies every `require-approval` classification -- shell, `apply_patch`, or MCP alike -- regardless of tool or `permission_mode`, rather than fake approval parity. A separately generated, KRYLO-owned Codex project rule may let an operator get Codex's own native prompt for a small set of shell-command shapes in an ordinary (non-KRYLO) session, but KRYLO's own gate does not trust or depend on that rule, since the rules/`PreToolUse`/`approval_policy` execution order is not documented upstream. See `docs/codex-capability-matrix.md` for the full capability-by-capability comparison.

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
