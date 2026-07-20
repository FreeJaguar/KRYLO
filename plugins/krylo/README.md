# KRYLO Plugin

KRYLO is an explicit, namespaced Claude Code workflow for autonomous, evidence-driven software development.

## Installation

```text
claude plugin marketplace add FreeJaguar/KRYLO
claude plugin install krylo@krylo-marketplace
```

For local development, load the plugin for one session only:

```text
claude --plugin-dir ./plugins/krylo
```

## Commands

- `/krylo:run <task>`
- `/krylo:setup`
- `/krylo:doctor`
- `/krylo:audit-tool <name-or-path>`
- `/krylo:status`

## Core guarantees

- No default-agent takeover.
- No required third-party integration.
- Bounded Orbit loop.
- Smallest effective agent team.
- One normal writer per worktree.
- Local-only telemetry by default.
- Human approval for production, destructive, financial, release, and external-write actions.

## Agent rules

Plugin agents are scoped under the KRYLO plugin namespace (`krylo:<agent>`).

- Use the smallest effective team.
- Builder is the normal source-code writer.
- Read-only roles do not receive Write or Edit.
- Agents that require command execution may receive Bash, with KRYLO risk hooks enforcing role and action policy.
- Optional external tools are called by the main KRYLO workflow under adapter policy, not inherited casually by every agent.
- Reviewers receive fresh task context and actual evidence.
- Agents return the structured KRYLO agent-result format (`schemas/agent-result.schema.json`).

Plugin agents must not declare `permissionMode`, `hooks`, or `mcpServers` in frontmatter because Claude Code ignores those fields for plugin-provided agents.

## Plugin data

Persistent runtime state belongs under `${CLAUDE_PLUGIN_DATA}`. The installed plugin directory is read-only and ephemeral across updates.

## Development

Load locally with the official Claude Code plugin-development mechanism, validate the plugin, and run the Node test suite before marketplace installation tests.
