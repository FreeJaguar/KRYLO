# KRYLO Skills

The plugin exposes five manually invoked skills.

| Skill | Purpose |
|---|---|
| `run` | Execute the autonomous development workflow |
| `setup` | Validate environment and configure optional convenience features |
| `doctor` | Read-only health and conflict diagnostics |
| `audit-tool` | Read-only trust and security review of a tool or plugin |
| `status` | Read-only current or recent run status |

All skills use `disable-model-invocation: true` so Claude does not start KRYLO or maintenance operations automatically.
