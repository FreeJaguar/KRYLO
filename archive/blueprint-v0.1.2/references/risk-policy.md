# Risk Policy

## Low

Examples: documentation, isolated bug, safe style correction, local refactor.

Default Orbit budget: 3.

## Medium

Examples: normal feature, new API, UI workflow, reversible data-model change, multi-module behavior.

Default Orbit budget: 5.

## High

Examples: authentication, authorization, personal data, payments, secrets, file upload, data export, migrations, infrastructure, security controls, production-like incident, AI tools with external actions.

Default Orbit budget: 7 or the platform-safe maximum, whichever is lower.

## Risk escalation

Escalate when:

- The changed attack surface expands.
- The task reaches production or an external write.
- A migration becomes irreversible.
- Evidence conflicts.
- Repeated failures suggest a broader root cause.

## Mandatory approval

Production deployment, production data writes, destructive operations, release, publish, merge, push not explicitly requested, IAM, RBAC, DNS, firewall, secret changes, payment actions, and broad external messaging require approval.
