# KRYLO Product Specification

## Product summary

KRYLO is a Claude Code plugin that turns one high-level task into a controlled software-development run. It analyzes the repository, derives acceptance criteria, selects a risk level and workflow lane, delegates bounded work to specialized agents, verifies the result, performs independent review, and produces an evidence-backed completion report.

## Primary user

A developer, founder, product owner, or technical operator who wants Claude Code to manage implementation end to end without repeated copy-paste, routine approval questions, or manual coordination among agents.

## Core user job

> Describe the desired outcome once, then receive a verified result or a precise blocker report.

## Primary command

```text
/krylo:run <task>
```

Optional local convenience alias:

```text
/krylo <task>
```

## Product goals

1. Reduce routine human-agent ping-pong.
2. Improve completion reliability through explicit acceptance criteria and evidence.
3. Make agent, model, tool, and iteration usage visible.
4. Apply the smallest effective team and cheapest suitable model.
5. Keep production and destructive actions gated.
6. Remain useful without optional MCP servers or external services.
7. Support public installation, updates, rollback, and community contribution.
8. Work on Windows, macOS, and Linux.

## Non-goals

KRYLO v0.1.0 will not:

- Replace Claude Code itself.
- Run as the default agent for every conversation.
- Install a large external tool stack automatically.
- Become a hosted SaaS control plane.
- Send source code, prompts, or telemetry to KRYLO-owned servers.
- Perform production deployments by default.
- Guarantee zero questions in cases that require a real business or risk decision.
- Provide a visual workflow builder.
- Implement its own source-control hosting, issue tracker, or secrets manager.
- Treat generated documentation as more authoritative than code and tests.

## Success criteria for v0.1.0

- The plugin validates through the official Claude Code plugin validator.
- The public marketplace can be added from a GitHub repository.
- `/krylo:run` executes a complete low-risk fixture without manual intervention.
- The optional `/krylo` alias can be installed and removed safely.
- Routine technical questions are blocked by policy.
- Production and destructive actions are gated.
- The final report lists agents, resolved models when available, tools, tests, evidence, and terminal state.
- The Orbit loop is bounded and stops on stagnation or iteration limit.
- The plugin operates with no optional third-party integration installed.
- Tests pass on Windows and Linux, with macOS compatibility covered by portable path and process behavior.

## User-visible terminal states

- `VERIFIED_COMPLETE`
- `SAFE_BLOCKED`
- `USER_DECISION_REQUIRED`
- `RISK_APPROVAL_REQUIRED`
- `ITERATION_LIMIT_REACHED`
- `CANCELLED_BY_USER`

## Product language

Public documentation and repository artifacts are written in English. User-facing report language is configurable through plugin user configuration, with `auto` as the public default and Hebrew supported as a first-class option.
