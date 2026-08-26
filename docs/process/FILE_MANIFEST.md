# File Manifest

Originally the planned target manifest of the blueprint (preserved verbatim in the baseline commit). Updated at implementation time to record the delivered 0.1.0 repository. Deltas from the plan are marked; per-file hashes live in `RELEASE_MANIFEST.json`.

## Marketplace root

```text
.claude-plugin/marketplace.json             # implemented
CLAUDE.md                                   # compact index, 115 lines (<=130)
README.md                                   # implemented (public repository readme)
CHANGELOG.md                                # implemented (0.1.0 entry)
CONTRIBUTING.md                             # as drafted
CODE_OF_CONDUCT.md                          # as drafted
SECURITY.md                                 # as drafted
THREAT_MODEL.md                             # as drafted
LICENSE                                     # implemented, Apache-2.0 canonical text
package.json / package-lock.json            # implemented (zero dependencies, node:test)
RELEASE_READINESS.md                        # implemented (progress + evidence record)
RELEASE_MANIFEST.json                       # implemented (per-file SHA-256 of the release tree).
                                             # STALE as of the multi-host Foundation / security-hardening
                                             # checkpoints (generated 2026-07-30): every file these
                                             # checkpoints touched has a different hash than recorded, and
                                             # ADR-0024/0025/0026 are not listed at all. Regenerate before
                                             # any release build; not done as part of this checkpoint
                                             # (release-prep scope, not one of its stated acceptance
                                             # criteria).
BLUEPRINT_MANIFEST.json                     # immutable blueprint record (paths updated for the
                                             # archive/ move below; content and hashes unchanged)
archive/blueprint-v0.1.2/                   # immutable blueprint drafts (unchanged content; moved
                                             # from root-level plugin/ during the v0.1.1 repo cleanup)
docs/process/                               # this file, IMPLEMENTATION_PLAN.md (historical v0.1.0
                                             # plan, unchanged), PROMPT_INPUT_CONTRACT.md,
                                             # REVIEW_CHECKLIST.md, LICENSE_DECISION.md (moved from
                                             # root during v0.1.1), MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md
                                             # and MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md
                                             # (approved 0.2 multi-host design and Foundation plan)
docs/adr/0023-multi-host-product-and-shared-core.md   # accepted: two first-class hosts, one Shared Core
docs/adr/0024-host-controlled-human-approval-boundary.md  # superseded by 0025; kept as history
docs/adr/0025-native-permission-approval.md           # accepted: native Claude permission ask replaces KRYLO-APPROVE
docs/adr/0026-powershell-risk-parity.md               # accepted: PowerShell risk classification parity with Bash
docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md  # accepted
docs/adr/0028-foundation-final-closure.md             # accepted: Foundation live-testing + glob-closure checkpoint
docs/adr/0029-codex-host-packaging-and-approval-boundary.md  # accepted: Codex CLI plugin host, fail-closed approval boundary
docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md        # implemented: reconciles the Codex maintenance design
                                                       # against re-verified current official Codex docs
docs/codex-capability-matrix.md                       # implemented: per-capability locally-passed /
                                                       # statically-inspected / deferred evidence record
docs/adr/0030-cross-harness-advisory-workers.md       # accepted: optional, read-only, depth-1,
                                                       # advisory-only opposite-provider workers
docs/process/CROSS_HARNESS_IMPLEMENTATION_PLAN.md     # implemented: Cross-Harness v1 design/CLI-contract
                                                       # reconciliation against real installed CLIs
docs/claude-capability-matrix.md                      # implemented: Claude-side Cross-Harness capability
                                                       # evidence record (worker CLI, spawn platform fix)
docs/adr/0031-ecosystem-maintenance-drift-checker.md  # accepted: read-only, official-source-only,
                                                       # non-authoritative drift checker for KRYLO's own
                                                       # pinned Claude/Codex/Actions/Node/dependency state
docs/process/ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md  # implemented: design/verification reconciliation
.github/workflows/ecosystem-maintenance.yml           # implemented: monthly + workflow_dispatch,
                                                       # contents:read only, invokes check-ecosystem.mjs
```

## Plugin root

```text
plugins/krylo/.claude-plugin/plugin.json    # implemented, with userConfig
plugins/krylo/hooks/hooks.json              # implemented (6 events)
plugins/krylo/.codex-plugin/plugin.json     # implemented (Codex CLI plugin manifest, docs/adr/0029)
plugins/krylo/hooks/codex-hooks.json        # implemented (PreToolUse/PermissionRequest/PostToolUse;
                                             # a separate file from hooks.json above by design -- see
                                             # its own $comment for why)
plugins/krylo/codex/skills/krylo-run/       # implemented (Codex explicit-only Skill: SKILL.md,
                                             # deliberately outside plugins/krylo/skills/ -- Claude's own
                                             # auto-discovered directory -- per docs/adr/0029's second
                                             # review round.
                                             # agents/openai.yaml)
plugins/krylo/scripts/host/codex/           # implemented (context.mjs, hook-transport.mjs -- the
                                             # Codex-only environment/payload normalization layer)
plugins/krylo/scripts/lib/host-dispatch.mjs # implemented (host adapter registry; routes Shared Core
                                             # runtime CLIs to the correct host adapter)
plugins/krylo/scripts/security/risk-gate-codex.mjs          # implemented (Codex PreToolUse gate)
plugins/krylo/scripts/security/permission-request-codex.mjs # implemented (Codex PermissionRequest hook)
plugins/krylo/scripts/runtime/posttool-telemetry-codex.mjs  # implemented (Codex PostToolUse telemetry)
plugins/krylo/scripts/setup/install-codex.mjs                # implemented (standalone-Skill install +
                                                               # execpolicy rules generation, dry-run/
                                                               # backup/uninstall)
plugins/krylo/scripts/maintenance/check-ecosystem.mjs        # implemented (Ecosystem Maintenance CLI,
                                                               # docs/adr/0031)
plugins/krylo/scripts/maintenance/checks/{claude-compat,codex-compat,actions-pins,
  node-runtime,dependencies,internal-drift}.mjs               # implemented (six check categories)
plugins/krylo/scripts/lib/maintenance-schema.mjs              # implemented (MaintenanceReport model)
plugins/krylo/scripts/lib/upstream-client.mjs                 # implemented (safe, allowlisted GitHub
                                                               # API fetch helper)
plugins/krylo/scripts/lib/version-compare.mjs                 # implemented (narrow, explicit-failure
                                                               # version comparator; not a semver library)
plugins/krylo/schemas/maintenance-report.schema.json          # implemented (cross-checked reference)
plugins/krylo/settings.json                 # NOT shipped in 0.1.0 (ADR-0016)
plugins/krylo/monitors/monitors.json        # NOT shipped (optional; not needed, docs/07)
plugins/krylo/README.md                     # implemented
plugins/krylo/LICENSE                       # implemented
```

## Skills (five, wired to deterministic runtime scripts)

```text
plugins/krylo/skills/run/SKILL.md
plugins/krylo/skills/setup/SKILL.md
plugins/krylo/skills/doctor/SKILL.md
plugins/krylo/skills/audit-tool/SKILL.md
plugins/krylo/skills/status/SKILL.md
```

## Agents (twelve; only Builder holds Write/Edit)

```text
plugins/krylo/agents/{scout,builder,verifier,reviewer,security-reviewer,architect,
  design-reviewer,product-strategist,migration-reviewer,ai-eval-engineer,
  performance-reviewer,deep-debugger}.md
```

## Runtime scripts (Node.js ESM, zero dependencies)

```text
plugins/krylo/scripts/lib/paths.mjs          # + (delta) shared data-root and safe-path helpers
plugins/krylo/scripts/lib/atomic.mjs         # + (delta) atomic JSON persistence
plugins/krylo/scripts/lib/redact.mjs         # + (delta) redaction engine
plugins/krylo/scripts/lib/state.mjs          # + (delta) state model, validator, completion gate
plugins/krylo/scripts/lib/telemetry.mjs      # + (delta) whitelist local telemetry
plugins/krylo/scripts/lib/hook-utils.mjs     # + (delta) hook stdin + active-run resolution
plugins/krylo/scripts/runtime/init-run.mjs
plugins/krylo/scripts/runtime/read-state.mjs
plugins/krylo/scripts/runtime/update-state.mjs
plugins/krylo/scripts/runtime/cleanup.mjs
plugins/krylo/scripts/runtime/posttool-telemetry.mjs   # + (delta) PostToolUse hook entry
plugins/krylo/scripts/orbit/stop-gate.mjs
plugins/krylo/scripts/orbit/fingerprint.mjs
plugins/krylo/scripts/orbit/stagnation.mjs
plugins/krylo/scripts/security/question-gate.mjs
plugins/krylo/scripts/security/risk-gate.mjs
plugins/krylo/scripts/security/redact.mjs
plugins/krylo/scripts/status/subagent-statusline.mjs
plugins/krylo/scripts/status/statusline-wrapper.mjs
plugins/krylo/scripts/status/agent-events.mjs          # + (delta) SubagentStart/Stop hook entry
plugins/krylo/scripts/setup/install-alias.mjs
plugins/krylo/scripts/setup/remove-alias.mjs
plugins/krylo/scripts/setup/doctor.mjs
plugins/krylo/scripts/audit/audit-tool.mjs
plugins/krylo/scripts/validation/validate-runtime.mjs
plugins/krylo/scripts/release/generate-release-manifest.mjs   # implemented (deterministic
                                                                # RELEASE_MANIFEST.json generation from
                                                                # `git ls-files` + git blob hashing --
                                                                # never the working tree, never a timestamp)
plugins/krylo/scripts/release/verify-release-manifest.mjs     # implemented (independent hash/coverage
                                                                # re-verification of RELEASE_MANIFEST.json)
plugins/krylo/scripts/lib/cross-harness.mjs            # implemented (ADR-0030: request/depth/role
                                                        # validation, egress classification, context-packet
                                                        # builder, worker-result schema validation)
plugins/krylo/scripts/lib/spawn-platform.mjs           # implemented (cross-platform shell:false-safe
                                                        # child-process invocation; fixes a real Windows
                                                        # .cmd-shim EINVAL failure found building Cross-Harness)
plugins/krylo/scripts/runtime/cross-harness-run.mjs    # implemented (the only executable surface a Skill
                                                        # invokes to request a Cross-Harness worker)
plugins/krylo/scripts/host/cross-harness/claude-worker.mjs  # implemented (Claude provider adapter)
plugins/krylo/scripts/host/cross-harness/codex-worker.mjs   # implemented (Codex provider adapter)
```

## Schemas and policy data

```text
plugins/krylo/schemas/run-state.schema.json
plugins/krylo/schemas/evidence.schema.json
plugins/krylo/schemas/agent-result.schema.json
plugins/krylo/schemas/tool-record.schema.json
plugins/krylo/catalog/tools.json
plugins/krylo/catalog/trust-policy.json
plugins/krylo/catalog/blocked-versions.json
plugins/krylo/catalog/publishers.json
plugins/krylo/policies/data-egress.json
plugins/krylo/policies/environment-profiles.json
plugins/krylo/policies/production-policy.json
plugins/krylo/policies/mcp-policy.json
```

## References and adapters

```text
plugins/krylo/references/*.md                # 13 policies from the approved drafts
plugins/krylo/adapters/README.md
plugins/krylo/adapters/{git-github,playwright,context7,figma,supabase-databases,
  sentry,vercel,openwiki,superpowers}.md
plugins/krylo/adapters/{mattpocock-skills,omniroute,code-review-graph}.md   # + (delta) optional external-capability adapters, reviewed 2026-07-27
```

## Tests and evaluations

```text
plugins/krylo/tests/unit/*.test.mjs          # state, redact, atomic, telemetry, cli, cleanup, resume
plugins/krylo/tests/platform/paths.test.mjs
plugins/krylo/tests/hooks/*.test.mjs         # question-gate, risk-gate, stop-gate, fingerprint, posttool (+helpers.mjs)
plugins/krylo/tests/security/injection.test.mjs
plugins/krylo/tests/security/external-adapters.test.mjs   # + (delta) mattpocock-skills/omniroute/code-review-graph
plugins/krylo/tests/status/*.test.mjs        # statusline, agent-events, wrapper
plugins/krylo/tests/setup/*.test.mjs         # alias, doctor
plugins/krylo/tests/governance/*.test.mjs    # audit, policy-consistency, agents, cross-harness-policy
plugins/krylo/tests/security/cross-harness-process.test.mjs   # + argv/env injection safety
plugins/krylo/tests/unit/cross-harness.test.mjs                # + coordinator: depth/roles/egress/packet/result
plugins/krylo/tests/unit/spawn-platform.test.mjs                # + Windows shell:false-safe spawn wrapper
plugins/krylo/tests/hooks/cross-harness-run.test.mjs            # + end-to-end CLI, real fake-worker fixtures
plugins/krylo/tests/fixtures/cross-harness/                     # + deterministic fake Claude/Codex worker CLI
plugins/krylo/tests/maintenance/*.test.mjs   # + Ecosystem Maintenance: version parsing, upstream-client
                                              # safety, per-category checks, result schema, offline/live
                                              # integration (docs/adr/0031)
plugins/krylo/tests/governance/ecosystem-maintenance-workflow.test.mjs   # + static read-only-workflow proof
plugins/krylo/evals/evals.json
plugins/krylo/evals/expected-behaviors.md
```

## CI

```text
.github/workflows/validate-plugin.yml
.github/workflows/test.yml
.github/workflows/codeql.yml
.github/workflows/semgrep.yml
.github/workflows/dependency-security.yml
.github/workflows/secret-scan.yml
.github/workflows/actions-security.yml
.github/workflows/sbom.yml
.github/workflows/release.yml
.github/dependabot.yml
.github/CODEOWNERS                           # @OWNER placeholder until first push
.github/pull_request_template.md
.github/ISSUE_TEMPLATE/*.md
```
