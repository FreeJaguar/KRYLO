---
name: status
description: Show the current or most recent KRYLO run state, agents, models, tools, Orbit progress, evidence, and blockers without changing application files.
argument-hint: "[run-id]"
disable-model-invocation: true
user-invocable: true
model: haiku
---

# KRYLO Status

Read the deterministic runtime state — do not reconstruct it from memory or guesses:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/read-state.mjs"
```

With an explicit run id argument (`$ARGUMENTS`), pass `--run <run-id>`. If the command reports no current run, say so and stop; do not invent a run.

From the returned JSON, display:

- Run ID and project (hash only; the raw path is never stored).
- Goal summary, lane, and risk.
- Current phase.
- Orbit cycle and budget, stop blocks, fingerprints, stagnation.
- Active and completed agents with configured models, and resolved models only when present in the state (never inferred).
- Tool counts.
- Acceptance-criterion progress.
- Latest evidence records.
- Blockers and terminal state.

Do not display prompts, commands, tool arguments, source code, secrets, database values, or raw external responses. Do not modify any file.
