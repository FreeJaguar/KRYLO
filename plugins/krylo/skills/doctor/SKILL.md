---
name: doctor
description: Perform a read-only KRYLO health, compatibility, conflict, and optional-tool inventory check. Use for installation diagnosis, upgrades, missing agents, broken hooks, model-routing issues, or plugin conflicts.
argument-hint: "[--verbose]"
disable-model-invocation: true
user-invocable: true
model: haiku
---

# KRYLO Doctor

Run the deterministic diagnostic and present its findings — do not improvise your own checks first:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/doctor.mjs" --json
```

Present, from the returned JSON:

- KRYLO, Node, Git, and Claude Code versions.
- Skill, agent, and hook discovery (hooksHealthy and any missing scripts).
- Runtime storage health, run count, pointer validity.
- User configuration keys (values only for non-sensitive enums, exactly as the report provides).
- Optional adapters detected (git, gh, supabase, vercel) and their versions.
- Tool trust summary: records, tiers, pending reviews, blocked entries.
- Alias ownership state (absent, krylo-owned, foreign).
- Conflicting orchestration frameworks (report-only).
- Every problem with its severity and exact remediation step.

With `--verbose` in `$ARGUMENTS`, also show the raw JSON. Exit status 1 from the script means a critical problem exists — highlight it first.

Do not install, update, delete, authenticate, or modify settings during doctor mode.
