# Source Baseline

This blueprint was prepared against the current Claude Code documentation available in July 2026 and an uploaded security-recommendations review.

## Official Claude Code references

- Plugins reference: `https://code.claude.com/docs/en/plugins-reference`
- Create plugins: `https://code.claude.com/docs/en/plugins`
- Plugin marketplaces: `https://code.claude.com/docs/en/plugin-marketplaces`
- Skills: `https://code.claude.com/docs/en/slash-commands`
- Subagents: `https://code.claude.com/docs/en/sub-agents`
- Hooks: `https://code.claude.com/docs/en/hooks`
- Model configuration: `https://code.claude.com/docs/en/model-config`

## Security recommendations source

The uploaded `claude-code-tools-security-recommendations.md` informed:

- Trust tiers.
- Version pinning.
- Optional-tool policy.
- Supply-chain controls.
- MCP review and isolation.
- Separation of Playwright Test from Playwright MCP.
- Read-only defaults for databases and production systems.
- OpenWiki's optional status.
- Avoiding multiple competing orchestration frameworks.

## External adapters reviewed

Full audit: `docs/external-adapter-audit-2026-07-27.md`. Each entry pins the exact commit reviewed (not a floating branch); catalog records in `plugins/krylo/catalog/tools.json` re-review automatically on any commit/version change.

- `https://github.com/mattpocock/skills` @ `ed37663cc5fbef691ddfecd080dff42f7e7e350d` (MIT)
- `https://github.com/diegosouzapw/OmniRoute` @ `ed7db3ee5f89a144b2d931d8605534522f83de30` (MIT)
- `https://github.com/tirth8205/code-review-graph` @ `9445a1a086a6e827b404e0c91309ced780fbd627` (MIT)

## Verification rule

The implementation phase must re-check official documentation and current tool versions. This file records the design baseline, not a permanent guarantee that every external schema or recommended version remains current.
