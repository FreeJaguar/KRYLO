# Implementation Prompt Input Contract

The future implementation prompt must treat this blueprint as the authoritative specification.

## Required prompt behavior

The prompt must instruct Claude Code to:

1. Start in a new empty repository.
2. Copy this blueprint into the repository without flattening its structure.
3. Read `CLAUDE.md` before modifying files and use it as a concise routing index, not as a replacement for the referenced specifications and policies.
4. Read every root architecture document.
5. Follow the task-relevant reference map in `CLAUDE.md` and use progressive disclosure instead of loading the entire blueprint into every subagent.
6. Read all accepted ADRs.
7. Read all drafted skill and agent files relevant to the active milestone.
8. Validate current official Claude Code schemas before implementation.
9. Preserve the approved command surface and security boundaries.
10. Implement code and JSON files around the Markdown control plane.
11. Change an approved architectural decision only by writing a new ADR and explaining the conflict.
12. Keep `CLAUDE.md` synchronized with accepted architecture and repository workflow changes while keeping it at or below 130 physical lines.
13. Run plugin validation, tests, security checks, and local installation tests.
14. Stop before creating or pushing a public GitHub repository unless the user gives explicit approval.

## Required environmental assumptions

- No earlier KRYLO installation exists.
- The repository is safe to initialize locally.
- Claude Code, Git, and a current Node.js runtime are available or can be reported as blockers.
- No third-party adapter is required for KRYLO Core.
- The implementation language for deterministic runtime code is Node.js ESM.

## Required output

The implementation run must produce:

- A complete repository.
- A local plugin validation report.
- A local install test report.
- A file manifest.
- A threat-model verification summary.
- A dependency and license inventory.
- A release-readiness report.
- One exact set of commands for publishing after explicit approval.

## Prohibited shortcuts

- Do not collapse policies into one giant `SKILL.md` or expand root `CLAUDE.md` into a policy dump.
- Do not add unsupported agent frontmatter.
- Do not make KRYLO the default agent.
- Do not make external integrations mandatory.
- Do not implement an unbounded loop.
- Do not store prompts or tool arguments in telemetry.
- Do not assume optional model access. Detect Fable availability before per-invocation use and fall back explicitly to Opus.
- Do not publish or push without explicit approval.
