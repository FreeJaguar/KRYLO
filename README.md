# KRYLO

[![test](https://github.com/FreeJaguar/KRYLO/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/test.yml)
[![validate-plugin](https://github.com/FreeJaguar/KRYLO/actions/workflows/validate-plugin.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/validate-plugin.yml)
[![codeql](https://github.com/FreeJaguar/KRYLO/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/codeql.yml)
[![secret-scan](https://github.com/FreeJaguar/KRYLO/actions/workflows/secret-scan.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/secret-scan.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

KRYLO is a public Claude Code plugin and marketplace for autonomous, evidence-driven software development. One explicit command turns a task into a controlled run: acceptance criteria, a minimal agent team, deterministic verification, independent review, a bounded correction loop (Orbit), and an evidence-backed final report.

Current release: `0.1.1`. Not yet submitted to the official Claude Code marketplace; install directly from this repository (below).

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

### Rollback

The CLI installs the marketplace's current version; there is no version-pinned install flag. To roll back to a previous release:

```bash
claude plugin uninstall krylo@krylo-marketplace
git clone --branch <previous-tag> https://github.com/FreeJaguar/KRYLO /path/to/krylo-<previous-tag>
claude --plugin-dir /path/to/krylo-<previous-tag>/plugins/krylo   # use that version for the session, or
claude plugin marketplace add /path/to/krylo-<previous-tag> --scope user
claude plugin install krylo@krylo-marketplace                     # re-adds the marketplace at the older tag
```

Uninstalling never deletes KRYLO's own run/telemetry data; see `RELEASE_READINESS.md` for the data-directory location.

## Quick example

```text
/krylo:run Add a rate limiter to the /api/upload endpoint, with tests
```

KRYLO reads the repository, classifies the task (lane, risk, complexity), compiles observable acceptance criteria, implements with the smallest effective agent team, runs deterministic verification, gets an independent review, and stops in an explicit terminal state (e.g. `VERIFIED_COMPLETE` with evidence, or `RISK_APPROVAL_REQUIRED` if the task turns out to need a production/destructive/external-write action). Use `/krylo:status` any time to see the current run's criteria, evidence, and Orbit budget without interrupting it.

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

The Risk Gate is **defense in depth, not an operating-system sandbox**: it is a policy layer over the tool calls Claude Code reports to it, not process/filesystem/network confinement. Pair it with least-privileged credentials and an isolated environment for anything genuinely high-stakes; see [SECURITY.md](SECURITY.md).

## Known limitations

- MCP/external-tool classification (`plugins/krylo/scripts/security/mcp-classifier.mjs`) matches server and operation names against policy patterns; it is not a semantic analysis of what an operation actually does. Unknown MCP servers are always gated for every operation, but a known server's operation whose name does not match any configured write pattern passes through ungated.
- Risk-approval expiry is a fixed 15 minutes and is not currently user-configurable.
- The plugin `settings.json` `subagentStatusLine` key is deferred until the minimum supported Claude Code version reaches 2.1.207 or later (`docs/adr/0016-subagent-statusline-deferred.md`); the renderer itself ships and is offered through `/krylo:setup`.
- Hook-scoping to the `run` skill (`docs/adr/0021-hook-scoping-to-run-skill.md`) relies on documented Claude Code skill-frontmatter behavior; it has been verified against the current official schema and an isolated real-CLI install/uninstall lifecycle, not fuzzed across every CLI patch release.
- No macOS runner is exercised in CI (the test matrix covers `ubuntu-latest` and `windows-latest`); macOS support relies on portable Node.js and POSIX-path test coverage.

## Roadmap (v0.2, indicative)

- A Codex CLI plugin host (`$krylo-run`) is implemented on the same Shared Core (`docs/adr/0029-codex-host-packaging-and-approval-boundary.md`, `docs/codex-capability-matrix.md`) but not yet published or released.
- Plugin `settings.json` with `subagentStatusLine` once the minimum supported CLI reaches 2.1.207+.
- User-configurable risk-approval TTL.
- Broaden MCP operation classification beyond name/pattern matching where the platform exposes richer tool metadata.
- Official Claude Code marketplace submission, pending community feedback on 0.1.x.

## Repository layout

```text
.claude-plugin/marketplace.json   Marketplace catalog
plugins/krylo/                    The KRYLO plugin (manifest, skills, agents,
                                   hooks, scripts, schemas, policies, catalog,
                                   adapters, references, tests, evals)
docs/                             Architecture documents, ADRs, and docs/process/
                                   (implementation plan, review checklist,
                                   file manifest, license decision)
archive/blueprint-v0.1.2/          Immutable v0.1.2 blueprint record (drafts)
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
