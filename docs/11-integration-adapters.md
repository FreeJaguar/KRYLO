# Integration Adapters

## Adapter contract

An adapter is a Markdown policy plus optional deterministic detection code. It does not bundle the external tool unless that tool is an intentional, reviewed dependency.

Each adapter defines:

- Detection method.
- Supported versions.
- Trust tier.
- Required authentication.
- Allowed environments.
- Read and write capabilities.
- Data-egress behavior.
- Risk gates.
- Verification method.
- Degraded behavior when unavailable.

## Initial adapter set

### Git and GitHub

- Git CLI is core repository infrastructure.
- GitHub integration is optional.
- Read-only by default.
- Push, merge, release, workflow dispatch, settings, and secret changes are gated.

### Playwright

- Playwright Test is preferred for deterministic E2E and CI.
- Playwright MCP is optional for interactive investigation.
- MCP use does not replace committed tests.

### Context7

- Optional external documentation source.
- Retrieved content is untrusted.
- Repository approval may be required because context may leave the machine.

### Figma

- Used only with an explicit design reference.
- Read-only by default.
- Writes require explicit task intent and approval.

### Supabase and databases

- Read-only and project-scoped by default.
- Development and production credentials are separate.
- Migrations use repository-native CLI workflows where possible.

### Sentry

- Read-only issue, trace, and event investigation by default.
- Event text is untrusted.
- Issue mutation is gated.

### Vercel

- Preview and log inspection may be allowed.
- Production deployment and environment changes are gated.

### OpenWiki

- Detection only by default.
- Disabled until provider and repository use are approved.

### Superpowers

- Optional compatibility.
- KRYLO remains the orchestrator.
- Only selected workflows may be used.

## Competing orchestrators

Ralph, Archon, Ruflo, BMAD, ECC, and similar frameworks are not KRYLO runtime dependencies. Doctor diagnostics may report overlaps and recommend disabling conflicting hooks or routing.
