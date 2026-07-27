---
name: setup
description: Inspect and configure the local KRYLO plugin environment, including user preferences, health checks, and optional installation of the personal /krylo convenience alias or main status-line wrapper.
argument-hint: "[--dry-run] [--install-alias] [--remove-alias] [--statusline]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# KRYLO Setup

1. Run in read-only dry-run mode first.
2. Validate Claude Code, KRYLO, Node.js, Git, plugin data, hooks, agents, and skills.
3. Read plugin user configuration and display effective preferences.
4. Detect optional integrations without installing them.
5. Before changing a user file, show the exact target, ownership decision, backup path, and rollback method.
6. Never overwrite an unknown personal skill named `krylo`.
7. Never enable Auto Mode, bypass permissions, or weaken deny rules.
8. Install or remove the optional personal alias only after explicit approval.
9. Install or remove a main status-line wrapper only after explicit approval and backup.
10. Finish with a concise configuration and health report.
