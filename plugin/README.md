# KRYLO Plugin

KRYLO is an explicit, namespaced Claude Code workflow for autonomous, evidence-driven software development.

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

## Plugin data

Persistent runtime state belongs under `${CLAUDE_PLUGIN_DATA}`. The installed plugin directory is read-only and ephemeral across updates.

## Development

Load locally with the official Claude Code plugin-development mechanism, validate the plugin, and run the Node test suite before marketplace installation tests.
