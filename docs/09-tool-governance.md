# Tool Governance

## Principle

A tool is not approved by name alone. Approval depends on publisher, source, version, integrity, requested permissions, network behavior, secret access, environment, and configuration.

## Trust tiers

| Tier | Meaning | Default behavior |
|---|---|---|
| A | Official source and relatively narrow attack surface | Use when relevant |
| A- | Recommended with minimal scopes, read-only mode, or network restrictions | Use under policy |
| B+ | Useful but requires exact reviewed version and isolation | Explicit approval or reviewed allowlist |
| B | Development-only or narrow use | No automatic use |
| C | Research or selected ideas only | Disabled |
| Blocked | Vulnerable, unverified, or too broad | Refuse |

## Registry record

Each governed tool record should include:

- Stable ID.
- Category.
- Publisher.
- Source type and source location.
- Trust tier.
- Reviewed version or commit.
- Blocked version ranges.
- Last review date.
- Installation policy.
- Network behavior.
- Secret access.
- Production access.
- Allowed environment profiles.
- Notes and remediation.

## Review triggers

A tool must be reviewed again when:

- Version or commit changes.
- Publisher changes.
- Hooks are added.
- MCP tools change.
- Installation scripts change.
- `postinstall` is added.
- New network destinations appear.
- Scope or credential requirements expand.

## Installation policy

KRYLO Core must not bulk-install optional tools. The audit command may recommend exact installation instructions after review, but installation is a separate user-approved action.

## Initial categories

- Claude Code plugins and skills.
- MCP servers.
- LSP servers.
- Browser and design tools.
- Database and infrastructure tools.
- Security and supply-chain tools.
- Observability tools.
- Documentation generators.
- Agent orchestration frameworks.
