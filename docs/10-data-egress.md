# Data Egress Policy

## Objective

Prevent source code, secrets, prompts, logs, personal data, and production data from leaving approved boundaries without explicit policy and user intent.

## Data classes

- Public.
- Internal.
- Confidential.
- Restricted.
- Secret.

## Repository profiles

### Local only

- No external code context.
- No external MCP server.
- No production access.
- Local-only telemetry.

### Private approved

- External access limited to approved providers.
- Official or reviewed integrations only.
- Production read-only when explicitly configured.
- Local-only KRYLO telemetry.

### Public repository

- External code context allowed when relevant.
- Official and reviewed integrations allowed.
- No automatic production access.

### Production read-only

- Allowlisted integrations only.
- Read-only credentials.
- No external writes.
- No secret retrieval.

## Adapter declaration

Each adapter declares whether it may transmit:

- Source code.
- Prompts.
- Logs.
- Repository metadata.
- Test output.
- Personal data.
- Production data.

An undeclared data flow is denied.

## Secrets

Secrets must not be stored in:

- KRYLO prompts.
- KRYLO telemetry.
- Repository Markdown.
- Tool catalog records.
- Screenshots.
- GitHub issues.
- Plugin manifests.

Use official secure storage, environment variables, OS keychains, or an approved secrets manager.
