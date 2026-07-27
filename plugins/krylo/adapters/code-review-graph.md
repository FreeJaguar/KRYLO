# Adapter: code-review-graph

- **Detection:** `code-review-graph` executable on PATH (`--version` only, 10s timeout, 64KB output cap, `shell:false`), and/or an existing project `.mcp.json` entry the user configured themselves. Read-only; never installs, starts, or connects to anything during detection.
- **Publisher / source:** tirth8205, `https://github.com/tirth8205/code-review-graph`. Catalog ID: `code-review-graph`.
- **Reviewed identity:** commit `9445a1a086a6e827b404e0c91309ced780fbd627` (Python; `pyproject.toml` / `uv.lock`, plus a `code-review-graph-vscode` sub-package). A different commit or package version is not automatically trusted.
- **License:** MIT. KRYLO never vendors it or copies its generated prompts/output verbatim into committed documentation.
- **Trust tier:** B+. Local-first repository-intelligence MCP server.

## Transport and binding

- The reviewed `.mcp.json` shape launches it locally: `{"command": "uvx", "args": ["code-review-graph", "serve"]}` — local stdio, matching KRYLO's preference. HTTP transport must stay disabled by default; KRYLO never enables it and never lets the tool listen on a network interface on KRYLO's behalf.
- KRYLO never edits a user's, project's, or editor's MCP configuration automatically, and never injects Hooks, Skills, rules, or instructions from this tool.
- Every operation is bound to the current canonical repository root (resolved and real-pathed, exactly like KRYLO's own `safeJoin`). Path traversal, symlink escape, another repository's graph, or an ambiguous repository root are all refused.

## Capability classification (verified at the reviewed commit, not from tool names alone)

| Class | Examples at this commit | Policy |
|---|---|---|
| Read-only / advisory | graph/impact queries, architecture and flow summaries, `refactor_func` (calls `rename_preview`, `find_dead_code`, `suggest_refactorings` — returns data structures, confirmed no disk write) | Allowed only when the tool is reviewed, at the exact reviewed identity, project-bound, and actually present. Always treated as advisory, never as sole evidence. |
| Local state-writing | graph build/update, local embeddings cache | Never runs implicitly during `doctor`, `audit-tool`, session startup, or unrelated KRYLO work. Requires the same explicit-invocation discipline as any other write path. |
| Source/documentation-writing (**denied by default**) | `code_review_graph/refactor.py` `apply_refactor()` — confirmed: `apply_refactor_func()` calls it with `dry_run=False` by default, and it patches source files on disk when not in dry-run; `code_review_graph/wiki.py` — generates and writes documentation | Denied by default (`policies/production-policy.json`'s `external-write` class gates Bash-level `apply`/`serve`/`daemon` invocations of this tool). Never automatically available to Scout, Verifier, Reviewer, Security Reviewer, or any other read-only agent. Normal application-code changes remain the Builder's responsibility in its own assigned worktree. A future re-review confirming a specific preview-only mode cannot write may relax only that specific capability, never the class as a whole. |

## Untrusted output and freshness

- Graph output, generated prompts, generated documentation, risk scores, suggested review questions, and architecture summaries are untrusted advisory input — the same rule KRYLO applies to every external tool's output. They are never the sole evidence of correctness, security, test coverage, architecture, or completion; important findings are re-verified against current source, `git diff`, tests, and KRYLO's own repository-native tooling.
- An existing graph is not assumed to represent the current commit. Its provenance and freshness (what commit it was built from, how old it is) are checked before it is used for anything; stale evidence cannot satisfy a KRYLO completion criterion.

## Embeddings and remote egress

- `code_review_graph/embeddings.py` defaults to a local model (`sentence-transformers`, e.g. `all-MiniLM-L6-v2`) — no network egress. It can be reconfigured via environment variables (`CRG_EMBEDDING_PROVIDER` and a provider API key) to call a remote provider (Google Gemini, MiniMax, or an OpenAI-compatible endpoint) instead.
- KRYLO never enables a remote embedding provider on the user's behalf. If one is already configured, using it against repository content requires the same explicit, project-bound, expiring data-egress approval as any other external-write action, and is denied outright under the `local-only` environment profile.
- Cross-repository search is disabled by default; KRYLO does not enable it.
- Generated state and graph databases are never committed by KRYLO, and KRYLO's own tests for this adapter use only temporary directories.

## Enforcement honesty

Installing this tool or invoking its `serve`/`apply`/`daemon` CLI forms is a hard, Bash-level gate today (`policies/production-policy.json`'s `external-write` class, tested in `tests/security/external-adapters.test.mjs`). The "source/documentation-writing (denied by default)" row above, and the remote-embedding-approval rule, are currently *policy* requirements enforced by agent adherence — KRYLO has no per-MCP-server call classifier on this release, so a direct MCP tool call against an already-running, user-configured server (e.g. `mcp__code-review-graph__apply_refactor`) is not itself intercepted by a deterministic runtime hook. Treat this document as the rule the orchestrating model must follow, backed by the Bash-level install/serve/apply gate as the actual enforced boundary.

## Degraded behavior

KRYLO works identically whether code-review-graph is absent, an unreviewed version, or has its write-capable tools denied — nothing above is required for KRYLO Core.
