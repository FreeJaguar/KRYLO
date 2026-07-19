---
name: status
description: Show the current or most recent KRYLO run state, agents, models, tools, Orbit progress, evidence, and blockers without changing application files.
argument-hint: "[run-id]"
disable-model-invocation: true
user-invocable: true
model: haiku
---

# KRYLO Status

Read local KRYLO runtime metadata and display:

- Run ID and project.
- Goal summary.
- Lane and risk.
- Current phase.
- Orbit cycle and budget.
- Active and completed agents.
- Configured and resolved models when available.
- Tool counts.
- Acceptance-criterion progress.
- Latest evidence.
- Blockers and terminal state.

Do not display prompts, commands, tool arguments, source code, secrets, database values, or raw external responses.
