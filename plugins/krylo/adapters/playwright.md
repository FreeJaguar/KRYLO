# Adapter: Playwright

- **Detection:** `@playwright/test` in the project's own lockfile/dependencies; Playwright MCP via the session's MCP inventory.
- **Publisher / source:** Microsoft. Catalog IDs: `playwright-test`, `playwright-mcp`.
- **Supported versions:** the project's own pinned version.
- **Trust tier:** Playwright Test A-; Playwright MCP B+.
- **Authentication:** none. Never use personal browser profiles or session tokens.
- **Allowed environments:** `local-only`, `private-approved`, `public-repository` (Test); MCP excluded from `local-only`.
- **Read capabilities:** run existing test suites, capture screenshots and accessibility snapshots, inspect pages interactively (MCP).
- **Write capabilities (gated):** new/updated test files are normal Builder work; nothing else.
- **Data egress:** none beyond pages the tests themselves visit.
- **Verification:** test exit codes and reports; screenshots stored under plugin runtime data.
- **Degraded behavior:** without Playwright, browser verification is reported as a degraded verification path; KRYLO does not install it silently.
- **Role separation:** Playwright Test is for deterministic committed tests and CI. Playwright MCP is for interactive investigation only and never replaces committed tests.
