# Command Surface

## Public commands

### `/krylo:run <task>`

The primary and portable command. It starts a KRYLO run in the current project.

Properties:

- Manual invocation only.
- Receives free-form task text in any supported language.
- Initializes run state.
- Selects lane, risk, agents, models, tools, and Orbit budget.
- Returns one explicit terminal state.

### `/krylo:setup`

Performs environment checks and optional convenience setup.

It may:

- Display plugin and runtime versions.
- Read plugin user configuration.
- Test Node, Git, Claude Code, and plugin components.
- Offer an optional personal `/krylo` alias.
- Offer an optional main status-line wrapper.
- Back up user files before approved changes.

It must not silently weaken user permissions or enable Auto Mode.

### `/krylo:doctor`

Read-only diagnostic command.

It reports:

- Plugin version and source.
- Claude Code version.
- User configuration.
- Available agent models.
- Hook health.
- Runtime storage health.
- Optional adapter inventory.
- Tool trust and review status.
- Alias and status-line state.
- Conflicting orchestration frameworks.

### `/krylo:audit-tool <name-or-path>`

Read-only tool, plugin, skill, MCP, or package review.

It inspects manifests, hooks, scripts, installation behavior, versions, publishers, network access, secret access, and known KRYLO policy violations.

### `/krylo:status`

Shows the current or most recent KRYLO run without changing application files.

## Optional personal alias

The setup command may create `~/.claude/skills/krylo/SKILL.md` as a wrapper that invokes `/krylo:run` with the same arguments.

Rules:

- Never overwrite an existing personal `krylo` skill silently.
- Show a dry run.
- Back up a replaced KRYLO-owned alias.
- Provide an explicit removal path.
- The plugin remains usable without the alias.

## Commands intentionally excluded

- `/krylo-orbit`: Orbit is internal.
- `/krylo-deploy`: deployment is a task routed through risk policy.
- `/krylo-agent`: users should not manage internal routing during normal use.
- `/krylo-install-tools`: KRYLO does not bulk-install a tool stack.
