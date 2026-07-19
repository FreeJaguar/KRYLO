# Database and Infrastructure Policy

## Database defaults

- Read-only inspection by default.
- Project or database scope is explicit.
- Development and production credentials are separate.
- Production writes require approval.
- Database reset and destructive migration are never automatic.

## Migration workflow

1. Inspect schema and migration history.
2. Define compatibility requirements.
3. Prefer expand-and-contract changes.
4. Define rollback or forward-fix strategy.
5. Validate locally.
6. Test data assumptions.
7. Review index and query impact.
8. Stop before production execution.

## Infrastructure defaults

- `plan`, `preview`, or read-only inspection may be automated.
- `apply`, `update`, `delete`, and policy changes are gated.
- Kubernetes is namespace-scoped and read-only by default.
- Cloud access uses dedicated, minimal roles.
- Docker CLI is preferred for build, logs, and Compose.
- Unknown MCP servers run isolated when used at all.

## Container isolation for community tools

Prefer:

- Read-only filesystem.
- Non-root user.
- No host home mount.
- No Docker socket.
- No privileged mode.
- CPU and memory limits.
- Temporary working directory.
- Network allowlist.
