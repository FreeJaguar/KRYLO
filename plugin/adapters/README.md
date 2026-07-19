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
