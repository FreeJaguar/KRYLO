# KRYLO Agents

Plugin agents are scoped under the KRYLO plugin namespace.

## Rules

- Use the smallest effective team.
- Builder is the normal source-code writer.
- Read-only roles do not receive Write or Edit.
- Agents that require command execution may receive Bash, with KRYLO risk hooks enforcing role and action policy.
- Optional external tools are called by the main KRYLO workflow under adapter policy, not inherited casually by every agent.
- Reviewers receive fresh task context and actual evidence.
- Agents return the structured KRYLO agent-result format.

Plugin agents must not declare `permissionMode`, `hooks`, or `mcpServers` in frontmatter because Claude Code ignores those fields for plugin-provided agents.
