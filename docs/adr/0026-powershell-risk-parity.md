# ADR-0026: PowerShell risk-classification parity with Bash

## Status

Accepted

## Context

KRYLO supports Windows (`docs/process/...`, `README.md`), where Claude Code frequently invokes shell commands through a distinct **PowerShell** tool rather than Bash. Before this checkpoint, `scripts/security/risk-policy.mjs`'s `classifyRiskAction()` branched explicitly on `toolName === 'Bash'` for every command-string check: the oversized-command cap, data-root protection, Hook-entrypoint protection, sensitive-path detection, and the production/destructive/publish/release policy classes in `policies/production-policy.json`. A PowerShell tool call fell through every one of these checks untouched and was classified `{ action: 'pass' }` regardless of what it did — the exact same `git push`, `Remove-Item -Recurse -Force`, or attempt to read `.env` that Bash would have gated was invisible to KRYLO when invoked through PowerShell instead. `skills/run/SKILL.md`'s risk-gate Hook matcher (`"Bash|Write|Edit|NotebookEdit|mcp__.*"`) did not even list PowerShell, so the Hook was never invoked for it at all.

Official Claude Code Hook documentation (`code.claude.com/docs/en/hooks`, checked for this task) confirms PowerShell is a distinct tool name from Bash, documents `"matcher": "Bash|PowerShell"` as the pattern for covering both, and — checked directly against a PowerShell Hook example in the same documentation (`$callInput.tool_input.command`) — confirms `tool_input.command` is the same field name PowerShell uses to carry the actual command text, exactly like Bash.

A separate, real gap was also found in `policies/production-policy.json`'s `destructive-operation` class: its only destructive-delete pattern was the Bash-flavored `\brm\s+(-[a-z]*[rf][a-z]*\s+)+(/|~|\$HOME|[a-z]:\\)`, which does not match the PowerShell-native equivalent a real PowerShell user or a PowerShell-invoking model would actually write, `Remove-Item -Recurse -Force <path>`.

## Decision

- `classifyRiskAction()`'s oversized-command cap, `touchesDataRoot()`, `touchesHookEntrypoint()`, and the Bash/PowerShell command-classification branch (sensitive-path check, `firstMatchingClass()` against `production-policy.json`) all now match on `toolName === 'Bash' || toolName === 'PowerShell'`, reading `tool_input.command` identically for both.
- `policies/production-policy.json`'s `destructive-operation` class gains `\bremove-item\b[^|;&\n]*?-(recurse|force)\b`, matching PowerShell's native destructive-delete syntax the same way the existing pattern matches Bash's.
- `skills/run/SKILL.md`'s risk-gate `PreToolUse` matcher becomes `"Bash|PowerShell|Write|Edit|NotebookEdit|mcp__.*"`.
- Risk **classification** is now identical for Bash and PowerShell: the same command triggers the same `pass`/`deny`/`require-approval` decision and the same `actionClass`, regardless of which shell tool carried it.
- Risk **gating outcome** is not fully identical, and this is a deliberate, separate decision (see ADR-0025): a Bash `require-approval` classification becomes Claude Code's native `permissionDecision: "ask"`; the same classification on PowerShell becomes a deterministic `deny`, because the official documentation that justifies trusting `ask` (this project's CHANGELOG, v2.1.211: "auto mode overriding a PreToolUse hook's `ask` decision for unsandboxed Bash") is explicitly scoped to Bash and was not found to extend to PowerShell anywhere in the CHANGELOG through the current released version. `deny` is strictly more conservative than an unconfirmed `ask`, never a weaker gate — a risky PowerShell action is still fully caught, just not (yet) resolvable through a live human prompt within the same run.

## Consequences

- Regression coverage added at both layers: `tests/unit/risk-policy.test.mjs` (direct `classifyRiskAction()` calls for PowerShell push, force-push, native destructive delete, sensitive-path read, Hook-entrypoint invocation, data-root reference, oversized command, and a benign pass) and `tests/hooks/risk-gate.test.mjs`/`tests/governance/hook-scoping.test.mjs` (the real Hook process and the Skill frontmatter matcher).
- `tests/hooks/risk-gate.test.mjs`'s data-root/sensitive-path/hook-entrypoint PowerShell coverage confirms the outright-`deny` categories are completely unaffected by this ADR-0025-driven ask/deny split — those were never candidates for `ask` in the first place (they are not `require-approval` classifications).
- If official Claude Code documentation later confirms the same auto-mode-`ask`-flooring guarantee for PowerShell, `risk-gate.mjs`'s tool-name check should be extended (and this ADR superseded) rather than silently widened without an equivalent evidence trail.

## Supersedes

None.

## Superseded by

None.
