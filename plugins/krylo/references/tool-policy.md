# Tool Policy

Use an optional tool only when it is:

- Relevant.
- Installed and functional.
- Allowed by the active environment profile.
- Within a reviewed version or commit.
- Within required scopes.
- Compatible with data-egress policy.
- Not blocked by the trust registry.

Prefer:

1. Existing repository tools.
2. Official Claude Code or vendor tools.
3. Reviewed community tools with exact versions and isolation.

Do not bulk-install optional tools. Do not use `@latest`, unpinned container tags, unpinned GitHub Actions, unsafe browser profiles, browser session tokens, random database MCP servers, or permission-bypass modes.

Playwright Test is for deterministic testing. Playwright MCP is for interactive investigation and does not replace committed tests.
