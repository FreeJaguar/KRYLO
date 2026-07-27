# ADR-0018: Extend the risk gate to MCP and other external tools

## Status

Accepted

## Context

The 0.1.0 risk gate (`scripts/security/risk-gate.mjs`) only classified `Bash`, `Write`, `Edit`, and `NotebookEdit` tool calls. Production, destructive, and external-write actions performed through an MCP server (database tools, Supabase, GitHub, Vercel, Figma, Sentry, messaging, cloud, IAM/secrets, and payment integrations) were not classified at all, so a KRYLO run could call any MCP tool freely regardless of write risk. `policies/mcp-policy.json` already stated governance rules (untrusted metadata, reviewed-version-only, unknown-server-deny) but nothing enforced them at the hook level.

Claude Code's PreToolUse matcher is a regular expression tested against `tool_name`; MCP tool calls are named `mcp__<server>__<operation>`, so a matcher can address them the same way it already addresses `Bash|Write|Edit|NotebookEdit`.

## Decision

- Extend the risk-gate `PreToolUse` matcher to `Bash|Write|Edit|NotebookEdit|mcp__.*`.
- Add `scripts/security/mcp-classifier.mjs`, which parses `mcp__<server>__<operation>`, checks the Tool Trust Registry (`catalog/tools.json`, matched by service name regardless of CLI vs MCP transport) and a new `serverActionClasses` section of `policies/mcp-policy.json` (server-name regex to actionClass, with per-operation overrides and a shared write-verb pattern).
- A completely unrecognized server is gated for every operation, read or write, because KRYLO cannot assess a service it has never classified (`mcp-untrusted-metadata`, `unknownServer: deny`).
- A recognized server is gated only for operations whose name matches the write-verb pattern, except database-shaped servers (`treatAnyExecuteAsWrite`), where any query/execute/statement-shaped operation is gated because arbitrary SQL cannot be judged read-only from its name alone.
- Tool descriptions and metadata returned by the MCP server itself are never consulted; only the literal `tool_name` Claude Code invoked is used, so a compromised or malicious server cannot talk its way into a different classification.

## Consequences

- Read-only MCP use (documentation lookups, browser inspection, issue/PR reads) continues to work without extra prompts once a server is reviewed.
- New MCP integrations are unclassified by default and therefore gated, not silently trusted — matching ADR-0008's tool trust registry model.
- The `serverActionClasses` mapping is heuristic (name- and verb-based) rather than an exhaustive per-tool review; it is deliberately biased toward gating on any ambiguity. `tests/security/mcp-classifier.test.mjs` and `tests/hooks/risk-gate-mcp.test.mjs` cover malicious, benign/read-only, unknown-tool, and approved-write fixtures.
