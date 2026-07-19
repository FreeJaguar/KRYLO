# Maintainer Responsibilities

## Roles

### Core maintainer

Owns product scope, command compatibility, release decisions, and public roadmap.

### Runtime maintainer

Owns deterministic scripts, schemas, state migration, status rendering, and cross-platform behavior.

### Security maintainer

Owns risk gates, threat model, tool trust registry, supply-chain controls, vulnerability response, and security release decisions.

### Agent and prompt maintainer

Owns skills, agent boundaries, model routing, context cost, and behavioral evaluations.

### Documentation maintainer

Owns public documentation, ADR quality, migration notes, and contributor guidance.

## Required review

Changes to hooks, risk gates, question gates, release workflows, tool catalog trust, telemetry, or user-settings mutation require security-maintainer review.

Changes to public commands, terminal states, schemas, or setup behavior require core-maintainer review.
