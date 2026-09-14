# KRYLO

[![test](https://github.com/FreeJaguar/KRYLO/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/test.yml)
[![validate-plugin](https://github.com/FreeJaguar/KRYLO/actions/workflows/validate-plugin.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/validate-plugin.yml)
[![codeql](https://github.com/FreeJaguar/KRYLO/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/codeql.yml)
[![secret-scan](https://github.com/FreeJaguar/KRYLO/actions/workflows/secret-scan.yml/badge.svg?branch=main)](https://github.com/FreeJaguar/KRYLO/actions/workflows/secret-scan.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

KRYLO is an autonomous, evidence-driven software-development workflow, built on one Shared Core with two first-class hosts: the Claude Code plugin, and an OpenAI Codex CLI plugin. One explicit command turns a task into a controlled run: acceptance criteria, a minimal agent team, deterministic verification, independent review, a bounded correction loop (Orbit), and an evidence-backed final report.

Current release: `0.2.0`. Not yet submitted to any official/curated marketplace on either host; install directly from this repository (below). The Claude Code host is released; the Codex host is implemented and shipped in this repository but not yet submitted to a curated Codex marketplace. A native `codex plugin` CLI install path (`marketplace add` + `add`, confirmed on `codex-cli 0.153.4`; absent on the originally-tested `0.120.0`) is now available -- see "Codex" below.

## Installation (Claude Code)

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

## Installation (Codex)

KRYLO's Codex host reuses the same Shared Core as the Claude plugin (`docs/adr/0029-codex-host-packaging-and-approval-boundary.md`). Two independent install paths exist, for two different Codex surfaces:

### CLI/plugin-browser (full plugin: `PLUGIN_ROOT`, hooks, `$krylo-run` enforcement)

Confirmed working on `codex-cli 0.153.4` (the `codex plugin` CLI management subcommand was absent on the originally-tested `0.120.0` -- see `docs/adr/0029-codex-host-packaging-and-approval-boundary.md`'s "Correction" section for the verified command transcript). Check `codex --help` for a `plugin` entry before relying on this path; if it is missing, use the standalone Skill path below instead.

```bash
git clone https://github.com/FreeJaguar/KRYLO
codex plugin marketplace add ./KRYLO           # or an absolute path to your clone
codex plugin add krylo@krylo-marketplace
```

Live end-to-end firing of the plugin's hooks (host-authoritative session bootstrap at `UserPromptSubmit`, the PreToolUse risk gate) has not been confirmed against an authenticated Codex session as of this writing -- installation succeeding does not by itself prove the hook wiring fires; see `docs/codex-capability-matrix.md`. Remove with `codex plugin remove krylo@krylo-marketplace`.

### Standalone Skill + rules (VS Code / no plugin support)

The Codex IDE extension does not support plugins at all. For that surface, KRYLO's own setup script installs a user-level Skill and optional project rules instead:

```bash
git clone https://github.com/FreeJaguar/KRYLO
cd KRYLO
node plugins/krylo/scripts/setup/install-codex.mjs          # dry run -- shows what would happen, changes nothing
node plugins/krylo/scripts/setup/install-codex.mjs --apply  # installs the $krylo-run Skill (opt-in, explicit invocation only)
```

This installs the `krylo-run` Skill so `$krylo-run <task>` is discoverable; it does not on its own add project-scoped Hook enforcement, and full enforcement requires a separate, explicit trusted-rules setup step -- see `docs/codex-capability-matrix.md`. Until that additional step is completed, treat a Codex `$krylo-run` session started this way as read-only/diagnostic rather than a fully enforced autonomous run. Uninstall by removing the installed Skill directory the script reports.

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

Claude Code:

```text
/krylo:run Add a rate limiter to the /api/upload endpoint, with tests
```

Codex:

```text
$krylo-run Add a rate limiter to the /api/upload endpoint, with tests
```

KRYLO reads the repository, classifies the task (lane, risk, complexity), compiles observable acceptance criteria, implements with the smallest effective agent team, runs deterministic verification, gets an independent review, and stops in an explicit terminal state (e.g. `VERIFIED_COMPLETE` with evidence, or `RISK_APPROVAL_REQUIRED` if the task turns out to need a production/destructive/external-write action). Use `/krylo:status` (Claude) any time to see the current run's criteria, evidence, and Orbit budget without interrupting it.

## Commands

| Command | Host | Purpose |
|---|---|---|
| `/krylo:run <task>` | Claude | Execute the autonomous development workflow |
| `$krylo-run <task>` | Codex | Execute the autonomous development workflow |
| `/krylo:setup` | Claude | Validate the environment; optionally install the personal `/krylo` alias or status-line wrapper (dry run + backup first) |
| `/krylo:doctor` | Claude | Read-only health, compatibility, and conflict diagnostics |
| `/krylo:audit-tool <name-or-path>` | Claude | Read-only trust and security review of a tool, plugin, or path |
| `/krylo:status` | Claude | Read-only view of the current or most recent run |

An optional setup step may install a personal wrapper so `/krylo <task>` works as a shortcut on Claude. The wrapper is convenience only; the namespaced command always works without it, and setup never overwrites a personal `krylo` skill it does not own.

## Core guarantees

- One explicit entry point per host; no default-agent takeover of ordinary Claude Code or Codex sessions.
- One Shared Core, thin host-specific adapters -- Claude and Codex share the same run state, Orbit loop, risk policy, and completion rules (`docs/adr/0023-multi-host-product-and-shared-core.md`).
- No required third-party integration in KRYLO Core.
- Bounded, evidence-driven Orbit iteration instead of an unbounded prompt loop.
- The smallest effective agent team; one source-code writer per worktree.
- Local-only operational telemetry; no raw prompts, commands, source code, or secrets are persisted.
- Read-only external access by default; optional tools are detected and policy-gated through adapters.
- Human approval for production, destructive, financial, release, identity, secret, and external-write actions -- on Claude, through the host's own native permission prompt; on Codex, `require-approval` actions deny deterministically instead (no verified in-hook mechanism exists yet to produce the same real human decision on the currently tested Codex build; see `docs/codex-capability-matrix.md`).
- **Cross-Harness** (optional): a run on one host may request a single, bounded, read-only, advisory review from the *opposite* provider's own CLI (Claude-hosted -> `codex exec`; Codex-hosted -> `claude -p`). The native host always remains the sole writer; a worker's findings are evidence only, never authority over completion (`docs/adr/0030-cross-harness-advisory-workers.md`).
- **Ecosystem Maintenance** (optional, scheduled): a read-only, official-source-only checker detects drift in KRYLO's own pinned provider versions, GitHub Action pins, and internal version references -- detection only, never automatic remediation (`docs/adr/0031-ecosystem-maintenance-drift-checker.md`).
- Six explicit terminal states; a model-generated phrase is never sufficient evidence of completion.
- Windows, macOS, and Linux support.

The Risk Gate is **defense in depth, not an operating-system sandbox**: it is a policy layer over the tool calls the host reports to it, not process/filesystem/network confinement. Pair it with least-privileged credentials and an isolated environment for anything genuinely high-stakes; see [SECURITY.md](SECURITY.md).

## Known limitations

- **Codex `require-approval` denies deterministically instead of prompting.** Current official Codex `PreToolUse` output does not support a native `ask` decision on the currently tested build, so an action KRYLO classifies as requiring human approval is denied outright on Codex rather than pausing for a real human decision the way it does on Claude. This is a documented, capability-driven asymmetry, not an oversight (`docs/codex-capability-matrix.md`).
- **Codex plugin CLI installation works on newer builds; live hook firing is still unconfirmed.** `codex plugin marketplace add`/`add` are confirmed working on `codex-cli 0.153.4` (absent on the originally-tested `0.120.0`) and successfully install KRYLO's plugin, but no authenticated Codex session has yet confirmed the plugin's hooks (session bootstrap, PreToolUse gate) actually fire end to end -- see "Installation (Codex)" above and `docs/codex-capability-matrix.md`. Full Hook enforcement in VS Code additionally requires a separate, not-yet-automated trusted-rules setup step.
- **Cross-Harness is optional, advisory, and depth-1.** It never gives the opposite-provider worker write access, and its findings can never themselves prove a criterion, resolve an approval, or set run completion. It requires the opposite provider's CLI to be installed and authenticated; when unavailable, KRYLO falls back to native-only verification/review.
- **Ecosystem Maintenance is detection-only.** It never edits a repository file, updates a dependency/pin automatically, or opens a PR/issue -- a detected drift is evidence for a separate, human-approved change.
- MCP/external-tool classification (`plugins/krylo/scripts/security/mcp-classifier.mjs`) matches server and operation names against policy patterns; it is not a semantic analysis of what an operation actually does. Unknown MCP servers are always gated for every operation, but a known server's operation whose name does not match any configured write pattern passes through ungated.
- Risk-approval expiry is a fixed 15 minutes and is not currently user-configurable.
- The plugin `settings.json` `subagentStatusLine` key is deferred until the minimum supported Claude Code version reaches 2.1.207 or later (`docs/adr/0016-subagent-statusline-deferred.md`); the renderer itself ships and is offered through `/krylo:setup`.
- Hook-scoping to the `run` skill (`docs/adr/0021-hook-scoping-to-run-skill.md`) relies on documented Claude Code skill-frontmatter behavior; it has been verified against the current official schema and an isolated real-CLI install/uninstall lifecycle, not fuzzed across every CLI patch release.
- No macOS runner is exercised in CI (the test matrix covers `ubuntu-latest` and `windows-latest`); macOS support relies on portable Node.js and POSIX-path test coverage.
- GitHub-hosted CI has not run on this exact release candidate until it is actually pushed; every result in `RELEASE_READINESS.md` for this release was produced by local execution.

## Roadmap (beyond 0.2, indicative)

- Full VS Code project-scoped Hook enforcement setup for Codex (dry-run/backup/rollback), completing the standalone-Skill install already shipped.
- Plugin `settings.json` with `subagentStatusLine` once the minimum supported Claude Code CLI reaches 2.1.207+.
- User-configurable risk-approval TTL.
- Broaden MCP operation classification beyond name/pattern matching where the platform exposes richer tool metadata.
- Official Claude Code marketplace submission, and an equivalent Codex distribution path once the platform provides one.

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
