# Changelog

All notable changes to KRYLO will be documented in this file.

The project follows Semantic Versioning.

## [Unreleased]

### Changed

- **Native permission approval replaces KRYLO-APPROVE (ADR-0024, superseded; ADR-0025).** Human approval authority for a `require-approval` classification now belongs to Claude Code's own native permission UI (`permissionDecision: "ask"`), not to any KRYLO-local chat-phrase or approval record a prompt-injected model could forge. `scripts/security/human-approval-gate.mjs` and `risk-policy.mjs`'s `consumeMatchingApproval()`/`isApprovalUsable()` are deleted: a KRYLO-local approval record can no longer independently authorize execution, for any tool.
- **Native ask restored to every require-approval class and to PowerShell/MCP (ADR-0027).** ADR-0025 initially scoped native ask narrowly to the Bash tool's `git-push`/`git-force` classes only; this was found to violate KRYLO's own product contract (a `require-approval` classification must have a real human-approval path, not a deterministic block indistinguishable from `deny`). Current official Claude Code documentation confirms PreToolUse hooks run before the permission prompt for every tool, not just Bash. Native ask now covers all twelve classes in `production-policy.json` and every genuinely-identified MCP write class, on Bash/PowerShell/MCP, still only when the session's `permission_mode` is in the live-verified allowlist (`auto`, `manual`, `default`); an MCP call whose server could not be positively identified (malformed, unrecognized, or blocked) stays a hard `deny` regardless of mode, since there is no server identity for a human to meaningfully evaluate.
- **PowerShell risk parity (ADR-0026).** Bash and PowerShell tool calls are classified identically by the shared risk policy; PowerShell's own destructive-delete aliases and parameter abbreviations are recognized.
- **Sensitive-path protection (`.env`, private keys, credential stores) now also covers Read/Glob/Grep**, not just Bash/Write/Edit/NotebookEdit, checking every path-shaped field each tool actually carries (Grep's `path`/`glob`; Glob's `path`/`pattern`; a content-search `pattern` is never treated as a path).
- The pinned Claude Code compatibility floor is raised to `2.1.223` (`docs/adr/0022-claude-code-compatibility-policy.md`): 2.1.211 confirms the core hook-`ask` fix this design relies on; 2.1.223 additionally closes a Bash permission-check bypass relevant to a human seeing the real command before approving it. Because the npm registry has not published past `2.1.197`, CI now installs this floor from a checksum-verified GitHub release binary instead of `npm install -g`.
- `withFileLock` now retries `EPERM`/`EACCES`/`EBUSY` in addition to `EEXIST` (a real Windows delete-pending lock race found during this checkpoint).
- **Foundation final closure (ADR-0028).** Live-tested against the pinned 2.1.223 binary: a pre-existing Claude Code `permissions.allow` rule (project, local, or an independent `--settings` source) does NOT bypass KRYLO's native `ask` decision, on both Bash and PowerShell -- closing ADR-0025's open question for the pre-existing-rule case with real evidence. New protections: the model can no longer weaken enforcement by writing to `.claude/settings.json`/`.claude/settings.local.json`, or by editing the KRYLO plugin's own installed hook/policy files (scoped to the installed location, not KRYLO's own source repository). Fixed four previously-disclosed classifier gaps: a relative-path destructive-delete evasion (`rm -rf ./build`, `rm -rf .`, `rm -rf *` now correctly require approval instead of passing ungated), a wildcard/glob sensitive-path evasion (`cat .env*`, `Grep(glob: '.env*')`), an availability regression treating `.env.example`/`.sample`/`.template`/`.dist`/`.defaults` as secrets, and an over-broad git-push pattern matching the word "push" anywhere after "git" rather than as the actual subcommand.

### Added

- **Cross-Harness v1: opposite-provider advisory workers (ADR-0030).** A KRYLO run on either host may now request one bounded, read-only, advisory review from the OPPOSITE provider's own CLI (Claude-hosted -> `codex exec`; Codex-hosted -> `claude -p`) via `scripts/runtime/cross-harness-run.mjs`. Optional, depth-1 (code-enforced via both the `KRYLO_EXTERNAL_WORKER`/`KRYLO_DELEGATION_DEPTH` environment marker and independent request validation), data-egress-gated (reuses the existing native-ask/deterministic-deny approval boundary through a new `cross-harness-invocation` require-approval class -- no new local approval mechanism), and strictly advisory: a worker's findings become ordinary evidence for the native host to weigh, never an authority that can itself prove a criterion, resolve an approval, or set completion. Found and fixed two real, previously-undiscovered platform bugs while building this: a ~50s O(n^2) ReDoS in `redact.mjs`'s URL-credential masking on ordinary large text with no `://` in it, and a Windows-specific `spawnSync` failure resolving npm's `.cmd`-shim CLIs (`scripts/lib/spawn-platform.mjs`, verified against the real installed `claude`/`codex` binaries and confirmed injection-safe, unlike the naive `shell:true` alternative). See `docs/adr/0030-cross-harness-advisory-workers.md` and `docs/process/CROSS_HARNESS_IMPLEMENTATION_PLAN.md`.
- **Codex CLI plugin host (ADR-0029).** A real Codex plugin (`plugins/krylo/.codex-plugin/plugin.json`), an explicit-only `krylo-run` Skill (`$krylo-run`, implicit invocation disabled), and a Codex-specific Hook transport (`scripts/host/codex/`) reusing the same Shared Core as the Claude host, per `docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md`. Because current official Codex `PreToolUse` output does not support a native `ask` decision (confirmed against re-verified current documentation), a `require-approval` classification denies deterministically on Codex instead of prompting -- a documented, capability-driven asymmetry from the Claude host, not a silent gap; see `docs/codex-capability-matrix.md`. A new `scripts/lib/host-dispatch.mjs` adapter registry routes shared runtime CLIs (`init-run`, `update-state`, `read-state`, `cleanup`) to the correct host adapter automatically. `scripts/setup/install-codex.mjs` adds a dry-run/backup/uninstall-capable standalone-Skill installer and a Codex project-rule generator, validated against the real installed `codex-cli` binary via `codex execpolicy check`. Full VS Code project-scoped hook enforcement setup remains a disclosed follow-up.
- Re-audited the `mattpocock-skills` adapter at the upstream repository's current commit (`2ab958093e83e0ec752e6c1c5932da465bf23e0c`, was `ed37663cc5fbef691ddfecd080dff42f7e7e350d`): every Skill in `skills/engineering/`, `skills/productivity/`, and `skills/misc/` was individually re-inspected (not just carried over from folder names), adding `grilling` as a seventh optional advisory discipline (Architect/Product Strategist mapping) and explicitly documenting the 13 user-invoked-only Skills, the two Skills excluded despite being model-invokable (`prototype`, `resolving-merge-conflicts`), and the two Hook/config-mutating Skills (`git-guardrails-claude-code`, `setup-pre-commit`) that only KRYLO's own policy — not Claude Code's frontmatter gate — keeps out. See `docs/external-adapter-audit-2026-07-27.md` ("Re-review — 2026-07-30") and `plugins/krylo/adapters/mattpocock-skills.md`.
- Three optional, adapter-first external-capability integrations, each reviewed at an exact pinned commit and added to the tool trust catalog: `mattpocock-skills` (Claude Code Skill/Plugin compatibility — selected advisory engineering disciplines only, upstream setup/triage/ticket/handoff-shaped Skills never auto-invoked), `omniroute` (optional model-gateway compatibility for an already-installed, user-configured instance — never installed/started/configured automatically, every request gated behind explicit project-bound approval, denied under the local-only profile), and `code-review-graph` (repository-intelligence MCP server compatibility — read-only graph/impact queries only; its source/documentation-writing tools, `apply_refactor` and wiki generation, are denied by default). See `docs/external-adapter-audit-2026-07-27.md` and `plugins/krylo/adapters/{mattpocock-skills,omniroute,code-review-graph}.md`.
- `plugins/krylo/policies/production-policy.json`: new `external-write` approval class gating Bash-level install/start/apply commands for the two new adapters.
- `plugins/krylo/scripts/audit/audit-tool.mjs`: exact-match alias resolution (repository URL / owner-repo / package name -> canonical catalog id), so an external tool can be audited by any of its common names without ever matching a look-alike by substring.
- `plugins/krylo/scripts/setup/doctor.mjs`: read-only detection for all three new adapters (executable/version probe for `omniroute` and `code-review-graph`; a read-only `~/.claude/settings.json` check for the `mattpocock-skills` plugin).
- 11 new focused tests (`plugins/krylo/tests/security/external-adapters.test.mjs`): catalog identity, alias resolution, version-drift refusal, look-alike-name rejection, prototype-lookup safety, doctor detection with and without the adapters present, the `external-write` gate, and a bounded-time regression check against catastrophic regex backtracking.

### Pending

- No plugin/marketplace version bump: this addition is purely additive (new optional adapters, no existing behavior changed) and does not, by itself, require a release. The maintainer should fold it into whichever release is cut next.

## [0.1.1] - 2026-07-20

Hardening pass on the 0.1.0 implementation, in preparation for the first public release.

### Added

- MCP and external-tool write protection in the risk gate (`scripts/security/mcp-classifier.mjs`, `policies/mcp-policy.json`): SQL/database writes, Supabase writes and migrations, GitHub merge/release/repository-setting/workflow-dispatch/secret operations, Vercel production deploys, Figma writes, Sentry mutation, Slack/email/external-message sending, cloud resource writes, IAM/RBAC/DNS/firewall/secret changes, and payment/refund/payout/billing actions are now gated for any `mcp__<server>__<operation>` tool call, not just Bash/Write/Edit/NotebookEdit. Unknown MCP servers are always gated, for every operation.
- Scoped, single-use, expiring risk approvals (ADR-0019): an approval now binds to action class, a normalized action fingerprint, target, project, run, and optional environment; it is consumed atomically under a per-run file lock and cannot be replayed, reused, or matched against an altered target.
- Concurrent-run support (ADR-0020): the single global `current-run.json` pointer is replaced by a per-project-per-session pointer layout (`active-runs/<projectRootHash>/<sessionId>.json`), with legacy-pointer migration and traversal/symlink-safe path resolution, so multiple simultaneous projects and Claude Code sessions no longer share or overwrite run state.
- Hook-scoping to the `run` skill (ADR-0021): KRYLO's six gate/telemetry hooks now live in the `run` skill's own frontmatter instead of plugin-wide `hooks/hooks.json`, so an ordinary Claude Code session that never invokes `/krylo:run` launches zero KRYLO hook processes.
- Separate Claude Code current-version compatibility check (ADR-0022): `.github/workflows/claude-code-compat.yml` runs weekly/on-demand against the latest published CLI without ever gating a release; the pinned minimum-supported floor in `validate-plugin.yml` is unchanged and unaffected by its outcome.
- Regression test rejecting any committed Claude Code local-runtime, lock, or session file (`tests/governance/repo-hygiene.test.mjs`).
- Repository-quality documentation: CI/license/security badges, a quick-usage example, a Known Limitations section, a v0.2 roadmap, an explicit "Risk Gate is defense in depth, not an OS sandbox" statement, rollback instructions, and security-sensitive contribution guidance.

### Fixed

- Removed the committed local Claude Code runtime lock file `.claude/scheduled_tasks.lock` (leaked a PID, session id, and timestamps into the public repository) and added `.gitignore` rules for local Claude state.
- `max_orbit_cycles` cap semantics (low=3/medium=5/high=7 risk-based budget, cap only ever lowers it, platform-safe maximum 10) are now consistently documented and reported across the plugin manifest, runtime, `references/orbit-policy.md`, `/krylo:doctor` output, and tests; `doctor.mjs` no longer masks the configured cap as a sensitive value.
- Independent review (code + security) found and fixed, before any release: an MCP-classifier bypass letting camelCase write operations (e.g. `mergePullRequest`, `createRefund`) pass ungated; an MCP-classifier bypass letting an attacker-chosen server name (e.g. containing `git`, or prefixed with a real catalog id like `context7-`) inherit an unrelated trusted server's classification; a lost-update race between `update-state.mjs` and the risk gate's approval consumption (`update-state.mjs` now shares the same per-run file lock); and — found while fixing that race — a genuine TOCTOU race in the path-resolution helper (`scripts/lib/paths.mjs`) that could crash under concurrent lock-file creation/removal on Windows.

### Security

- See `docs/adr/0018-mcp-and-external-tool-gating.md` through `docs/adr/0022-claude-code-compatibility-policy.md` for the full architecture-decision record of this hardening pass.

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

## [blueprint-0.1.2] - 2026-07-19

Pre-implementation blueprint-document change, not a plugin release (the plugin's own first release is `0.1.0` above). Renamed from a bare `[0.1.2]` heading, which collided with real plugin version numbers.

### Changed

- Reduced the root `CLAUDE.md` from 222 lines to 112 lines.
- Converted `CLAUDE.md` into a concise repository control index with direct references to authoritative documents.
- Added an explicit 130-line maximum for the root `CLAUDE.md` to the architecture, implementation plan, prompt contract, manifest, and review checklist.
- Regenerated blueprint hashes and the distribution archive.

## [blueprint-0.1.1] - 2026-07-19

Pre-implementation blueprint-document change, not a plugin release. Renamed from a bare `[0.1.1]` heading, which collided with the real plugin release `[0.1.1] - 2026-07-20` above.

### Added

- Root `CLAUDE.md` for contributors and Claude Code repository work.

### Changed

- Reading order, implementation contract, architecture, manifest, and review checklist were updated to include `CLAUDE.md`.
