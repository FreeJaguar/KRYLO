# Context Management

## Goal

Provide each model with the smallest context that is sufficient for its task.

## Context-pack contents

A context pack may include:

- Normalized goal.
- Relevant acceptance criteria.
- Relevant files and symbols.
- Relevant tests.
- Current failure summary.
- Project conventions.
- Required output schema.

It should not include:

- Entire conversation history by default.
- Entire repository snapshots.
- Unrelated logs.
- Secrets.
- Full tool outputs when a short summary is sufficient.

## Project profile

KRYLO may maintain a local, non-source-code project profile containing:

- Languages and frameworks.
- Package manager.
- Apps and packages.
- Important directories.
- Standard commands.
- Design-system location.
- Migration tooling.
- Deployment-provider names.
- Last analyzed Git state.

The profile is invalidated when relevant project configuration changes.

## Generated knowledge

OpenWiki or other generated documentation may be used only when:

- It is enabled and approved.
- Its source revision is known.
- It is not stale.
- It is verified against code for high-impact decisions.

## Context compaction

KRYLO's persisted run state must be sufficient to survive context compaction without storing raw prompts or source code. The main model should reconstruct the next action from structured state plus fresh repository inspection.
