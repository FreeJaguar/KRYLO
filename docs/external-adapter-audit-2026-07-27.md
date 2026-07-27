# External Adapter Audit — 2026-07-27

Read-only audit of three external repositories evaluated for optional, adapter-first KRYLO integration. No installation, execution, or lifecycle script from any of these repositories occurred during this audit; all content was retrieved via the public GitHub API (contents/trees/commits endpoints) pinned to an exact commit SHA. Findings below directly inform `catalog/tools.json`, `policies/production-policy.json`, and the three adapter documents in `plugins/krylo/adapters/`.

## 1. mattpocock/skills

- **Repository:** `https://github.com/mattpocock/skills`
- **Reviewed commit:** `ed37663cc5fbef691ddfecd080dff42f7e7e350d` (default branch `main`)
- **License:** MIT (confirmed via the GitHub API `license.spdx_id`)
- **Manifests:** `.claude-plugin/plugin.json` (v1.2.0, lists 22 Skills), `package.json` (private npm package, v1.1.0)
- **Install/lifecycle scripts:** none. `package.json.scripts` contains only `changeset` and `changeset version` (Changesets release tooling); no `preinstall`/`install`/`postinstall`.
- **Hooks:** none — no `hooks.json` anywhere in the tree.
- **Skills and agents:** 22 Skills across `skills/engineering/` (17) and `skills/productivity/` (5), plus 8 in-progress, 4 deprecated, and 2 personal Skills not part of the shipped plugin manifest's `skills` array.
- **MCP servers / tool inventory:** none.
- **Files/settings a setup command would touch:** `setup-matt-pocock-skills` (confirmed `disable-model-invocation: true`, user-invoked only) configures the *target* repository's issue tracker, triage labels, and domain-doc layout — not touched by KRYLO, since KRYLO never runs this Skill.
- **Network destinations / transports:** none declared or observed at this commit.
- **Authentication / secret handling:** none.
- **Data egress:** none (no network capability at all).
- **Local/external write capabilities:** one bundled script, `skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh`, is a local git-command guard; it is not registered as a Claude Code Hook anywhere in this repository and has no effect unless a user wires it in themselves.
- **Production access:** none.
- **Supported OS/runtime:** Node.js tooling only for the Changesets release flow; the Skills themselves are plain Markdown + YAML frontmatter, portable.
- **Upgrade/uninstall/rollback:** standard Claude Code plugin lifecycle (`claude plugin update`/`uninstall`); KRYLO does not manage this.
- **Supply-chain risk:** low. Two `devDependencies` (`@changesets/changelog-github`, `@changesets/cli`), both build-time only, not shipped to end users of the Skills themselves.
- **Blocked/unsafe versions:** none known; `reviewedVersion` is pinned to the exact commit above, so any other commit is `unreviewed-no-automatic-use` by KRYLO's existing trust-registry logic.
- **Tests/CI:** `.github/workflows/release.yml` (Changesets release automation) — not inspected further; irrelevant to KRYLO's own use of this repository as Skills content.
- **Overlap with KRYLO orchestration:** `setup-matt-pocock-skills`, `triage`, `to-tickets`, `to-spec`, `wayfinder`, and `handoff` are conflicting-or-manual-only per `adapters/mattpocock-skills.md`'s compatibility matrix; the remaining engineering disciplines (`tdd`, `diagnosing-bugs`, `codebase-design`, `domain-modeling`, `research`, `code-review`) are optional advisory input mapped onto existing KRYLO agents, never a competing lifecycle.

## 2. OmniRoute

- **Repository:** `https://github.com/diegosouzapw/OmniRoute`
- **Reviewed commit:** `ed7db3ee5f89a144b2d931d8605534522f83de30` (default branch `release/v3.8.49`)
- **Package version:** `omniroute@3.8.49` (`package.json`)
- **License:** MIT (confirmed via the GitHub API `license.spdx_id`)
- **Manifests:** `package.json` — `type: module`, `bin: {omniroute, omniroute-reset-password}`, `engines.node: ">=22.22.2 <23 || >=24.0.0 <27"`.
- **Install/lifecycle scripts:** README documents an optional native-SQLite postinstall step, skippable via `OMNIROUTE_SKIP_POSTINSTALL=1`. KRYLO never triggers this install path at all.
- **Hooks:** none applicable (not a Claude Code plugin).
- **Skills/agents:** none applicable.
- **MCP servers / tool inventory:** exposes its own MCP endpoints (`/api/mcp/stream`, `/api/mcp/sse`) plus stdio, in addition to an OpenAI-compatible HTTP API and an A2A (`/.well-known/agent.json`) endpoint — i.e. OmniRoute is itself a gateway/router product, not a single well-scoped MCP tool.
- **Files/settings modified by setup:** none inspected beyond the optional native-module postinstall; KRYLO does not run setup regardless.
- **Network destinations/transports:** broad by design — proxies to any of 160+ configured upstream model providers; local dashboard/API on `localhost:2012` by default.
- **Authentication/secret handling:** provider API keys via a `.env` file and a local SQLite database described as AES-256-GCM-encrypted at rest; MCP "scoped tokens" for its own remote-mode authorization.
- **Data egress:** by its nature as a router, any request through it can carry source code, prompts, logs, and repository metadata to whichever upstream provider is configured — declared accordingly in `catalog/tools.json`.
- **Local/external write capabilities:** installs a local server process and local credential storage.
- **Production access:** unknown/unbounded — depends entirely on what the user has configured it to route to; classified conservatively as `unknown`.
- **Supported OS/runtime:** Node.js 22.x/24.x (per `engines`); also distributed via Docker and an Arch Linux (AUR) package.
- **Upgrade/uninstall/rollback:** standard npm/Docker/AUR lifecycle; KRYLO never performs any of it.
- **Supply-chain risk:** moderate-to-high inherent to the product category (a credential-holding network proxy), independent of code quality; mitigated entirely by KRYLO's own policy — KRYLO never installs, configures, or routes through it without a precise, explicit, per-action approval (`adapters/omniroute.md`).
- **Blocked/unsafe versions:** none known; only the exact reviewed commit/version is trusted, and only for compatibility detection, never automatic use.
- **Tests/CI:** not inspected (out of scope — KRYLO never executes this project's code).
- **Overlap with KRYLO orchestration:** none by design — OmniRoute is a model-request gateway, not an orchestrator; it never controls KRYLO's own lane/risk/completion logic.

## 3. code-review-graph

- **Repository:** `https://github.com/tirth8205/code-review-graph`
- **Reviewed commit:** `9445a1a086a6e827b404e0c91309ced780fbd627` (default branch `main`)
- **License:** MIT (confirmed via the GitHub API `license.spdx_id`)
- **Manifests:** `pyproject.toml` / `uv.lock` (Python core), `package.json` for a `code-review-graph-vscode` sub-package.
- **Install/lifecycle scripts:** none identified as automatically destructive; standard Python packaging (`uv`/`pip`).
- **Hooks:** the reviewed commit ships `.mcp.json` at the repository root (`{"mcpServers": {"code-review-graph": {"command": "uvx", "args": ["code-review-graph", "serve"]}}}`) — this is a project-level MCP declaration a user opts into by having it in their own project, not something KRYLO writes or auto-registers.
- **Skills/agents:** `code_review_graph/skills.py` exists in the module tree; not inspected in depth beyond confirming it is not auto-injected into a consuming repository by anything KRYLO would run.
- **MCP servers / tool inventory:** one MCP server, launched locally via `uvx code-review-graph serve` (stdio by default in the shipped config; HTTP transport exists in the codebase per the `daemon_cli.py`/server design but is not the default and must stay disabled under KRYLO policy).
- **Files/settings modified by setup:** graph/state files are written locally under the tool's own data directory (not inspected exhaustively); KRYLO's own tests use temporary directories only and never commit generated graph state.
- **Network destinations/transports:** none by default (local stdio MCP, local embeddings). Optional remote embedding providers (see below) are the only network path, and are opt-in via environment variables.
- **Authentication/secret handling:** none by default; an API key is required only if a remote embedding provider is explicitly configured.
- **Data egress:** `code_review_graph/embeddings.py` confirmed to default to a local `sentence-transformers` model (e.g. `all-MiniLM-L6-v2`) with no network call; can be redirected via `CRG_EMBEDDING_PROVIDER` and a provider key to Google Gemini (`google.genai`), MiniMax (`https://api.minimax.io/v1/embeddings`), or a configurable OpenAI-compatible endpoint. The project's own design includes an explicit opt-in warning before code is sent externally.
- **Local and external write capabilities:** confirmed by direct inspection of `code_review_graph/tools/refactor_tools.py` — `refactor_func()` (calls `rename_preview()`, `find_dead_code()`, `suggest_refactorings()`) returns data only, no disk write; `apply_refactor_func()` calls `apply_refactor(refactor_id, root, dry_run=dry_run)` from `code_review_graph/refactor.py`, which patches source files on disk when `dry_run=False` (the default). `code_review_graph/wiki.py` generates and writes documentation. Both are source/documentation-writing capabilities, denied by default under KRYLO policy regardless of what the MCP tool happens to be named.
- **Production access:** none.
- **Supported OS/runtime:** Python (via `uv`), cross-platform; a VS Code extension sub-package for editor integration.
- **Upgrade/uninstall/rollback:** standard `uv`/`pip`/extension-marketplace lifecycle; KRYLO never manages any of it.
- **Supply-chain risk:** low-to-moderate; the write-capable tools are the primary risk surface and are addressed by policy (deny-by-default), not by trusting the tool's own naming.
- **Blocked/unsafe versions:** none known; only the exact reviewed commit is trusted for automatic detection/classification purposes.
- **Tests/CI:** 70+ test files under `tests/` (parsers, integration, embeddings, refactor, wiki, language-specific); not executed by KRYLO.
- **Overlap with KRYLO orchestration:** none as a read-only graph/impact-analysis tool; the source/doc-writing capabilities would overlap with KRYLO's Builder if ever enabled, which is exactly why they are denied by default and never automatically available to KRYLO's read-only agents (Scout, Verifier, Reviewer, Security Reviewer).

## Verification method

All content above was retrieved via `https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<exact-sha>` and `https://api.github.com/repos/<owner>/<repo>/git/trees/<exact-sha>?recursive=1`, i.e. pinned to the exact commit SHA reviewed, not a floating branch or `HEAD`. No repository was cloned, installed, or executed. GitHub's own `license.spdx_id` field was used for the license conclusion in each case (not just the README's own claim), matching all three repositories' own README/LICENSE self-description.
