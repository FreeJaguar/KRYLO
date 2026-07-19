# Privacy and Telemetry

## Default

KRYLO sends no operational analytics to a KRYLO service.

## Local metadata

When enabled, local metadata may contain:

- Session and run IDs.
- Agent IDs and types.
- Configured and resolved model names.
- Start and stop timestamps.
- Lane, risk, and Orbit count.
- Tool names and counts.
- Test labels and statuses.
- Hashed failure fingerprints.
- Terminal state.

## Prohibited metadata

Do not persist:

- Raw user prompts.
- Raw agent prompts.
- Hidden reasoning.
- Tool arguments.
- Shell commands.
- Source code.
- File contents.
- Raw errors or stack traces.
- Environment values.
- Database values.
- Credentials.
- Personal information.

## Retention

Default retention is 14 days. Users may disable local telemetry or reduce retention.

## Final reports

Reports summarize evidence and actions without revealing sensitive commands, values, or content.
