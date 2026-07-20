# KRYLO

KRYLO is a public Claude Code plugin and marketplace for autonomous, evidence-driven software development. One explicit command turns a task into a controlled run: acceptance criteria, a minimal agent team, deterministic verification, independent review, a bounded correction loop (Orbit), and an evidence-backed final report.

Current release: `0.1.0`.

## Installation

```bash
claude plugin marketplace add FreeJaguar/KRYLO
claude plugin install krylo@krylo-marketplace
```

Reload plugins (or restart Claude Code) and run `/krylo:doctor` to confirm everything is healthy.

### Local development

Load the plugin for one session only, without installing it:

```bash
claude --plugin-dir ./plugins/krylo
```

### Updating and removing

```bash
claude plugin update krylo@krylo-marketplace
claude plugin uninstall krylo@krylo-marketplace
```

## Commands

| Command | Purpose |
|---|---|
| `/krylo:run <task>` | Execute the autonomous development workflow |
| `/krylo:setup` | Validate the environment; optionally install the personal `/krylo` alias or status-line wrapper (dry run + backup first) |
| `/krylo:doctor` | Read-only health, compatibility, and conflict diagnostics |
| `/krylo:audit-tool <name-or-path>` | Read-only trust and security review of a tool, plugin, or path |
| `/krylo:status` | Read-only view of the current or most recent run |

An optional setup step may install a personal wrapper so `/krylo <task>` works as a shortcut. The wrapper is convenience only; the namespaced command always works without it, and setup never overwrites a personal `krylo` skill it does not own.

## Core guarantees

- One explicit entry point; no default-agent takeover of ordinary Claude Code sessions.
- No required third-party integration in KRYLO Core.
- Bounded, evidence-driven Orbit iteration instead of an unbounded prompt loop.
- The smallest effective agent team; one source-code writer per worktree.
- Local-only operational telemetry; no raw prompts, commands, source code, or secrets are persisted.
- Read-only external access by default; optional tools are detected and policy-gated through adapters.
- Human approval for production, destructive, financial, release, identity, secret, and external-write actions.
- Six explicit terminal states; a model-generated phrase is never sufficient evidence of completion.
- Windows, macOS, and Linux support.

## Repository layout

```text
.claude-plugin/marketplace.json   Marketplace catalog
plugins/krylo/                    The KRYLO plugin (manifest, skills, agents,
                                   hooks, scripts, schemas, policies, catalog,
                                   adapters, references, tests, evals)
docs/                             Architecture documents and ADRs
plugin/                           Immutable v0.1.2 blueprint record (drafts)
.github/workflows/                CI: validation, tests, security scans
```

## Documentation

Start with [PRODUCT_SPEC.md](PRODUCT_SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Detailed design lives in `docs/01` through `docs/24`, decisions in `docs/adr/`. Security model: [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md). Implementation evidence and validation results: [RELEASE_READINESS.md](RELEASE_READINESS.md).

## Development

Requirements: Node.js ≥ 22, Git, Claude Code CLI.

```bash
npm test                 # full suite (node:test, zero dependencies)
npm run validate:runtime  # runtime self-validation
claude plugin validate --strict plugins/krylo
claude plugin validate --strict .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the change process.

## Model portability

Static agent files use the portable `haiku`, `sonnet`, and `opus` aliases. KRYLO may request `fable` per invocation for deep-debug escalation only after runtime capability detection, with Opus as the explicit fallback. Final reports use resolved model data when the platform provides it and never infer a resolved model from an agent name.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
