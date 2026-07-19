# Planned File Manifest

This manifest defines the target repository files that the implementation prompt must create. Markdown files included in this blueprint are marked as drafted. Non-Markdown files are implementation work.

## Marketplace root

```text
.claude-plugin/marketplace.json             # implement
CLAUDE.md                                   # drafted, compact index, <=130 lines
README.md                                   # drafted
CHANGELOG.md                                # drafted
CONTRIBUTING.md                             # drafted
CODE_OF_CONDUCT.md                          # drafted
SECURITY.md                                 # drafted
THREAT_MODEL.md                             # drafted
LICENSE                                     # implement from LICENSE_DECISION.md
```

## Plugin root

```text
plugins/krylo/.claude-plugin/plugin.json    # implement
plugins/krylo/settings.json                 # implement, optional subagentStatusLine only
plugins/krylo/hooks/hooks.json              # implement
plugins/krylo/monitors/monitors.json        # optional, implement only if justified
plugins/krylo/README.md                     # derive from blueprint
plugins/krylo/LICENSE                       # implement
```

## Skills

```text
plugins/krylo/skills/run/SKILL.md
plugins/krylo/skills/setup/SKILL.md
plugins/krylo/skills/doctor/SKILL.md
plugins/krylo/skills/audit-tool/SKILL.md
plugins/krylo/skills/status/SKILL.md
```

All five drafts are included under `plugin/skills/` in this blueprint.

## Agents

```text
plugins/krylo/agents/scout.md
plugins/krylo/agents/builder.md
plugins/krylo/agents/verifier.md
plugins/krylo/agents/reviewer.md
plugins/krylo/agents/security-reviewer.md
plugins/krylo/agents/architect.md
plugins/krylo/agents/design-reviewer.md
plugins/krylo/agents/product-strategist.md
plugins/krylo/agents/migration-reviewer.md
plugins/krylo/agents/ai-eval-engineer.md
plugins/krylo/agents/performance-reviewer.md
plugins/krylo/agents/deep-debugger.md
```

All agent drafts are included under `plugin/agents/`.

## Runtime scripts

```text
plugins/krylo/scripts/runtime/init-run.mjs
plugins/krylo/scripts/runtime/read-state.mjs
plugins/krylo/scripts/runtime/update-state.mjs
plugins/krylo/scripts/runtime/cleanup.mjs
plugins/krylo/scripts/orbit/stop-gate.mjs
plugins/krylo/scripts/orbit/fingerprint.mjs
plugins/krylo/scripts/orbit/stagnation.mjs
plugins/krylo/scripts/security/question-gate.mjs
plugins/krylo/scripts/security/risk-gate.mjs
plugins/krylo/scripts/security/redact.mjs
plugins/krylo/scripts/status/subagent-statusline.mjs
plugins/krylo/scripts/status/statusline-wrapper.mjs
plugins/krylo/scripts/setup/install-alias.mjs
plugins/krylo/scripts/setup/remove-alias.mjs
plugins/krylo/scripts/setup/doctor.mjs
plugins/krylo/scripts/audit/audit-tool.mjs
plugins/krylo/scripts/validation/validate-runtime.mjs
```

These are intentionally not included yet.

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

## Tests and evaluations

```text
plugins/krylo/tests/**/*.test.mjs
plugins/krylo/tests/fixtures/**
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
.github/CODEOWNERS
.github/pull_request_template.md
```
