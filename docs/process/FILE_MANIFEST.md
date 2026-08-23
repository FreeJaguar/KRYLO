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
RELEASE_MANIFEST.json                       # implemented (per-file SHA-256 of the release tree)
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
```

## Plugin root

```text
plugins/krylo/.claude-plugin/plugin.json    # implemented, with userConfig
plugins/krylo/hooks/hooks.json              # implemented (6 events)
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
plugins/krylo/tests/governance/*.test.mjs    # audit, policy-consistency, agents
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
