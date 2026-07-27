# KRYLO Adapters

Adapters are optional policy modules for independently installed tools.

Initial adapter families:

- Anthropic and Claude Code plugins.
- Git and GitHub.
- Browser and design.
- Databases and migrations.
- Infrastructure and cloud.
- Security and supply chain.
- Observability.
- Documentation and repository intelligence.

Each adapter must satisfy `plugin/references/adapter-policy.md` and the trust registry. No adapter is a KRYLO Core dependency unless an ADR explicitly changes that decision.

Optional external-capability adapters (reviewed 2026-07-27, `docs/external-adapter-audit-2026-07-27.md`):

- `mattpocock-skills.md` — Claude Code Skill/Plugin compatibility.
- `omniroute.md` — model-gateway compatibility for an already-configured instance.
- `code-review-graph.md` — repository-intelligence MCP server compatibility.
