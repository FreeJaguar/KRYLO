# KRYLO Blueprint

Blueprint package version: `0.1.2`  
Target plugin release: `0.1.0`

KRYLO is a proposed public Claude Code plugin and marketplace package for autonomous, evidence-driven software development.

This repository snapshot is a documentation-first architecture package. It intentionally contains no executable plugin runtime, manifests, hooks, or installation scripts yet. The goal is to freeze the product contract, security model, command surface, agent boundaries, loop semantics, and distribution strategy before implementation begins.

## Intended user experience

The portable plugin command is:

```text
/krylo:run <task>
```

An optional setup step may install a personal wrapper so the user can invoke:

```text
/krylo <task>
```

The wrapper is convenience only. The public plugin remains the source of truth.

## Design principles

- One explicit entry point for normal work.
- No default-agent takeover of ordinary Claude Code sessions.
- No required third-party integration in KRYLO Core.
- Bounded, evidence-driven iteration instead of an unbounded prompt loop.
- The smallest effective agent team.
- One source-code writer per worktree.
- Local-only operational telemetry by default.
- Read-only external access by default.
- Human approval for production, destructive, financial, release, and external-write actions.
- Current source code and tests outrank generated documentation.
- Public, versioned, testable, and reversible distribution through a Claude Code marketplace.

## Blueprint status

- Architecture: proposed and internally consistent.
- Product scope: frozen for v0.1.0.
- Markdown control plane: drafted.
- Root `CLAUDE.md` concise routing and contributor instructions: finalized at 112 lines.
- Executable implementation: not started.
- Public repository: not created.
- Marketplace: not published.

## Reading order

`CLAUDE.md` is intentionally a short control index. Follow its references instead of expanding it into a policy dump.

1. `CLAUDE.md`
2. `PRODUCT_SPEC.md`
3. `ARCHITECTURE.md`
4. `docs/01-command-surface.md`
5. `docs/02-runtime-state-machine.md`
6. `docs/03-orbit-loop.md`
7. `docs/04-agent-system.md`
8. `docs/09-tool-governance.md`
9. `SECURITY.md`
10. `THREAT_MODEL.md`
11. `IMPLEMENTATION_PLAN.md`
12. `REVIEW_CHECKLIST.md`

## Model portability

Current Claude Code subagent documentation includes `fable` as an available subagent model alias, but account and organization availability can vary. To keep the public plugin portable, static agent files use `haiku`, `sonnet`, and `opus`. KRYLO may request `fable` per invocation for deep-debug escalation only after runtime capability detection, with Opus as the explicit fallback. The `best` session alias is not used as a substitute for this check.
