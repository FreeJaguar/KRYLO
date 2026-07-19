# Agent System

## Design rule

Use the smallest effective agent team. Agents exist to isolate context, enforce tool boundaries, and provide independent review. They are not personas for entertainment.

## Core agents

| Agent | Model | Write access | Purpose |
|---|---|---:|---|
| scout | Haiku | No | Focused discovery and impact map |
| builder | Sonnet | Yes | Product code and tests |
| verifier | Sonnet | No product writes | Independent execution evidence |
| reviewer | Opus | No | Diff and test-integrity review |
| security-reviewer | Opus | No | Security analysis |
| architect | Opus | No product writes | High-impact design decisions |
| design-reviewer | Sonnet | No product writes | Browser, visual, RTL, and accessibility review |
| product-strategist | Opus | No | Smallest shippable product slice |
| migration-reviewer | Opus | No | Migration safety and rollback |
| ai-eval-engineer | Sonnet | No product writes | AI evaluation design and execution |
| performance-reviewer | Sonnet | No product writes | Baseline and measurement review |
| deep-debugger | Opus | No product writes | Difficult root-cause diagnosis |

## One-writer rule

The Builder is the normal application-code writer. Other agents return findings and evidence. If an isolated implementation agent is added later, it must use a separate worktree and merge through KRYLO-controlled review.

## Structured result

Every agent returns:

- Status.
- Summary.
- Evidence.
- Files inspected.
- Files modified.
- Commands summarized without secrets.
- Findings.
- Risks.
- Unresolved items.
- Recommended next action.

## Team examples

### Small patch

- Scout when discovery is needed.
- Builder.
- Verifier.
- Reviewer only when risk or diff size warrants it.

### Normal feature

- Scout.
- Builder.
- Verifier.
- Reviewer.

### UI feature

- Scout.
- Builder.
- Verifier.
- Design Reviewer.
- Reviewer.

### Authentication or data export

- Scout.
- Architect when design changes.
- Builder.
- Verifier.
- Reviewer.
- Security Reviewer.

### Database migration

- Scout.
- Architect.
- Builder.
- Verifier.
- Migration Reviewer.
- Security Reviewer when data exposure or permissions change.

## Context isolation

Reviewers receive fresh, task-specific context. They must inspect actual diffs and evidence, not merely repeat the Builder's conclusion.
