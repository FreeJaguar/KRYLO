# OpenWiki Policy

## Status

OpenWiki is an optional documentation adapter, not a KRYLO dependency and not an organizational source of truth.

## Default configuration

```yaml
openWiki:
  enabled: false
  codeModeAllowed: false
  approvedProvider: null
  personalModeAllowed: false
  connectorsAllowed: false
```

## Allowed use

Code mode may be approved when:

- The repository is public or approved for the selected inference provider.
- The repository is large or poorly documented.
- Secrets and sensitive files are excluded.
- The generated documentation records its source revision.

## Prohibited default use

- Personal mode.
- Gmail, Slack, Notion, X, or personal connectors.
- Automatic initialization on every repository.
- Automatic update after trivial edits.
- Use as the final authority over code, tests, schemas, or migrations.

## Freshness

KRYLO must mark OpenWiki content stale when the repository materially diverges from the recorded source revision.
