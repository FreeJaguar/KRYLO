# ADR-0021: Scope KRYLO's hooks to the run skill, not the whole plugin

## Status

Accepted

## Context

0.1.0 registered all six KRYLO hooks (question-gate, risk-gate, posttool-telemetry, fingerprint, agent-events for `SubagentStart`/`SubagentStop`, stop-gate) plugin-wide in `hooks/hooks.json`. Every gate already fails open/pass-through with zero state changes when no KRYLO run is active (ADR-0009), but the hook processes themselves still launched on every matching tool call in every ordinary Claude Code session, whether or not `/krylo:run` had ever been invoked.

Current official documentation (code.claude.com/docs/en/hooks, /plugins-reference, /sub-agents; checked 2026-07-20 against the installed CLI, v2.1.197) confirms: hooks declared in a Skill's own YAML frontmatter "only run when the specific component is active" and "are automatically cleaned up once it finishes" — the same mechanism used for subagent-scoped hooks. All six events KRYLO needs (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`) are supported in skill frontmatter, with the same `${CLAUDE_PLUGIN_ROOT}` variable resolution as plugin-wide hooks.

## Decision

- Move all six hook registrations from `hooks/hooks.json` into `skills/run/SKILL.md`'s frontmatter `hooks:` key, unchanged in matcher, command, and timeout.
- `hooks/hooks.json` now registers `{"hooks": {}}` — no plugin-wide interception at all.
- No other KRYLO skill (`setup`, `doctor`, `audit-tool`, `status`) declares any hook; none of them need the question/risk gates, and their own read-only or explicitly-gated flows are unaffected.

## Consequences

- An ordinary Claude Code session that never invokes `/krylo:run` launches zero KRYLO hook processes, eliminating the plugin's residual overhead outside a run.
- `tests/governance/hook-scoping.test.mjs` deterministically proves the wiring: `hooks.json` is empty, the run skill declares all six events against real scripts, and no other skill declares any hook. It cannot itself drive a live Claude Code session to observe zero process spawns outside a run; that guarantee rests on the documented platform behavior cited above, re-verified against `claude plugin validate --strict`, which passes with this frontmatter.
- If a future Claude Code release changes or removes skill-scoped hook support, this ADR is superseded and the minimum necessary hooks return to `hooks/hooks.json` (unaffected either way by the already-existing ADR-0009 no-active-run pass-through).
