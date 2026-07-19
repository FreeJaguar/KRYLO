---
name: run
description: Run an end-to-end KRYLO software-development workflow for a feature, bug, design change, migration, audit, incident, AI feature, or performance task. Use only when the user explicitly invokes the KRYLO run command.
argument-hint: "<task>"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# KRYLO Run

Task: `$ARGUMENTS`

1. Initialize or resume the KRYLO run state using the plugin runtime.
2. Read `${CLAUDE_PLUGIN_ROOT}/references/operating-principles.md`, `${CLAUDE_PLUGIN_ROOT}/references/lane-policy.md`, `${CLAUDE_PLUGIN_ROOT}/references/risk-policy.md`, and `${CLAUDE_PLUGIN_ROOT}/references/completion-contract.md`.
3. Load only the additional references required for the selected lane, risk, tools, security surface, design work, testing work, question decision, Orbit continuation, or final report.
4. Compile observable acceptance criteria before modifying application code.
5. Classify lane, risk, constraints, non-goals, evidence requirements, and Orbit budget.
6. Inspect the repository before deciding.
7. Select the smallest effective agent team.
8. Use safe, conventional, reversible defaults instead of asking routine questions.
9. Keep one application-code writer per worktree.
10. Run applicable deterministic verification.
11. Obtain independent review.
12. Continue through KRYLO Orbit when criteria or valid findings remain.
13. Stop only in an approved terminal state.
14. Produce the configured-language final report with actual agents, resolved models when available, tools, evidence, Orbit data, risks, and actions intentionally not performed.

Never deploy, publish, merge, push, modify production, expose secrets, or perform a destructive action without the required approval gate.
