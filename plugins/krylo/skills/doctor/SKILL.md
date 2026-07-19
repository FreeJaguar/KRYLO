---
name: doctor
description: Perform a read-only KRYLO health, compatibility, conflict, and optional-tool inventory check. Use for installation diagnosis, upgrades, missing agents, broken hooks, model-routing issues, or plugin conflicts.
argument-hint: "[--verbose]"
disable-model-invocation: true
user-invocable: true
model: haiku
---

# KRYLO Doctor

Run a read-only diagnostic.

Report:

- KRYLO and Claude Code versions.
- Plugin source and scope.
- Skill, agent, hook, and status-line discovery.
- User configuration.
- Supported and configured models.
- Runtime storage and retention.
- Alias ownership.
- Optional adapters and authentication state.
- Tool trust and reviewed-version status.
- Conflicting orchestration frameworks or hooks.
- Missing prerequisites.
- Exact remediation steps.

Do not install, update, delete, authenticate, or modify settings during doctor mode.
