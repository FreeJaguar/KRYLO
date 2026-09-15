# KRYLO Product Specification

## Product summary

KRYLO is an evidence-driven software-development orchestration product with Claude Code and Codex as approved first-class hosts. The 0.1.x shipped surface is the Claude Code plugin; KRYLO 0.2 adds the Codex host through the approved multi-host roadmap (`docs/adr/0023-multi-host-product-and-shared-core.md`). On each host, KRYLO turns one high-level task into a controlled software-development run: it analyzes the repository, derives acceptance criteria, selects a risk level and workflow lane, delegates bounded work to specialized agents, verifies the result, performs independent review, and produces an evidence-backed completion report.

## Primary user

A developer, founder, product owner, or technical operator who wants Claude Code to manage implementation end to end without repeated copy-paste, routine approval questions, or manual coordination among agents.

## Core user job

> Describe the desired outcome once, then receive a verified result or a precise blocker report.

## Primary command

On the Claude host, the shipped public command is:

```text
/krylo:run <task>
```

Optional local convenience alias:

```text
/krylo <task>
```

On the Codex host, the explicit invocation is:

```text
$krylo-run <task>
```

Implemented per `docs/adr/0029-codex-host-packaging-and-approval-boundary.md` and `docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md`: a real Codex CLI plugin, explicit-only (implicit invocation disabled), reusing the same Shared Core as the Claude host. Full VS Code project-scoped hook enforcement (`<repo>/.codex/hooks.json`) is implemented per `docs/adr/0032-codex-project-scoped-hook-enforcement.md`. `docs/codex-capability-matrix.md` records exactly which capabilities are confirmed live versus statically inspected versus deferred, including the narrower `require-approval` guarantee on Codex (deterministic deny rather than a native approval prompt).

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

## Goals for 0.2 (multi-host Foundation)

- Generalize Shared Core so it does not depend on Claude-only session, option, model, or Hook-output field names.
- Give every run a KRYLO-owned `runId` independent of any host session identifier.
- Preserve all v0.1.0 Claude behavior, security controls, and success criteria unchanged while the Foundation lands.

## Goals for 0.2 (Codex host)

- Ship a real Codex CLI plugin (`.codex-plugin/plugin.json`, explicit-only `krylo-run` Skill, Codex Hook transport) reusing Shared Core, per `docs/adr/0029-codex-host-packaging-and-approval-boundary.md`.
- Preserve every Claude host guarantee unchanged (regression-proven, `docs/codex-capability-matrix.md` and the full test suite).
- Document every Codex capability gap with an explicit safe fallback rather than overclaim parity with Claude -- most notably, `require-approval` denies deterministically on Codex instead of using a native approval prompt, since current Codex `PreToolUse` output does not support one.
- Full VS Code project-scoped hook enforcement (`<repo>/.codex/hooks.json`, `install-codex.mjs --target hooks`) is implemented per `docs/adr/0032-codex-project-scoped-hook-enforcement.md`.
- Scheduled Ecosystem Maintenance and the `0.2.0` version bump are implemented in this same release line (see `docs/adr/0031-ecosystem-maintenance-drift-checker.md` and CHANGELOG's `[0.2.0]` entry).

## Goals for 0.2 (Cross-Harness)

- Let a KRYLO run on one native host request an optional, bounded, read-only, advisory second opinion from the OPPOSITE provider's own CLI, per `docs/adr/0030-cross-harness-advisory-workers.md`.
- Keep the native host the sole writer and sole completion authority; a Cross-Harness worker's result is advisory evidence only.
- Code-enforce recursion depth 1, reuse the existing native-approval/deterministic-deny boundary for data egress with no new local approval mechanism, and degrade safely (never block normal KRYLO operation) whenever the opposite provider is missing, unauthenticated, unsupported, or times out.
- Cross-Harness v1 ships in the same `0.2.0` release line as Ecosystem Maintenance and the version bump itself (see `docs/adr/0031-ecosystem-maintenance-drift-checker.md` and CHANGELOG's `[0.2.0]` entry); none of the three is deferred to later work.

## User-visible terminal states

- `VERIFIED_COMPLETE`
- `SAFE_BLOCKED`
- `USER_DECISION_REQUIRED`
- `RISK_APPROVAL_REQUIRED`
- `ITERATION_LIMIT_REACHED`
- `CANCELLED_BY_USER`

## Product language

Public documentation and repository artifacts are written in English. User-facing report language is configurable through plugin user configuration, with `auto` as the public default and Hebrew supported as a first-class option.
