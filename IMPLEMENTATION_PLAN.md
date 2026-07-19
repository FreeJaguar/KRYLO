# KRYLO v0.1.0 Implementation Plan

## Goal

Build a public, testable Claude Code plugin and marketplace that implements the approved KRYLO architecture without requiring an existing KRYLO installation.

## Delivery strategy

Implementation is divided into independently verifiable milestones. No milestone may depend on undocumented behavior from a previous KRYLO experiment.

## Milestone 1: Repository and marketplace skeleton

Deliverables:

- Public-ready repository structure.
- Root `CLAUDE.md` as a compact operating index of at most 130 lines, with progressive references to authoritative documents.
- Marketplace catalog.
- Plugin manifest.
- License, security, contribution, and release documentation.
- Official plugin validation in CI.

Acceptance:

- `claude plugin validate .` succeeds.
- Local marketplace add and plugin install succeed.
- `/krylo:run` appears in the command list, even if runtime behavior is initially minimal.
- A clean Claude Code session in the repository loads the compact `CLAUDE.md`, its references resolve, its line count is at most 130, and plugin installation does not copy it into application repositories.

## Milestone 2: Core skill and state model

Deliverables:

- `/krylo:run` skill.
- Run-state schema.
- Goal, lane, risk, and completion contracts.
- Local plugin-data storage.
- Redaction and retention behavior.

Acceptance:

- A fixture run initializes valid state.
- Raw prompts and tool arguments are absent from persisted state.
- State can be resumed after a simulated process restart.

## Milestone 3: Agent system

Deliverables:

- All twelve plugin agents.
- Minimal-team routing rules.
- Structured agent-result contract.
- One-writer enforcement at orchestration level.

Acceptance:

- Read-only agents cannot use Write or Edit.
- Builder is the normal source-code writer.
- Reviewer receives goal, diff, evidence, and conventions rather than only the Builder summary.

## Milestone 4: Orbit loop

Deliverables:

- Deterministic stop gate.
- Delta generation.
- Failure fingerprinting.
- Stagnation detection.
- Six terminal states.
- Maximum iteration enforcement.

Acceptance:

- The loop stops on verified completion.
- The loop stops at its configured hard limit.
- Repeated failure changes strategy rather than repeating the same instruction.
- Background work is not duplicated.

## Milestone 5: Question and risk gates

Deliverables:

- Question-token mechanism.
- Production and destructive-action gate.
- External-write classification.
- Environment profiles.

Acceptance:

- Routine AskUserQuestion attempts are blocked.
- A valid one-use exceptional question is allowed.
- Production write, deploy, publish, merge, payment, and destructive actions require approval.

## Milestone 6: Observability

Deliverables:

- Subagent status line.
- Optional main status-line wrapper installed only through setup.
- Local agent, model, tool, duration, and Orbit counts.
- Stuck-state heuristics.

Acceptance:

- Status shows actual available model data without guessing.
- A running agent can show working, waiting, no activity, or suspected stuck.
- No prompts, commands, source code, or secrets are displayed or logged.

## Milestone 7: Tool governance and adapters

Deliverables:

- Tool trust registry.
- Audit-tool skill and scanner.
- Data-egress rules.
- Initial optional adapters.

Acceptance:

- KRYLO runs with zero adapters.
- An unreviewed version is not auto-approved.
- Blocked versions are rejected.
- Optional tools remain detection-based and policy-gated.

## Milestone 8: Setup, doctor, and alias

Deliverables:

- User-config schema.
- Setup checks.
- Doctor report.
- Optional personal `/krylo` wrapper.
- Alias removal and rollback.

Acceptance:

- Setup performs a dry run before external file changes.
- Existing personal skill named `krylo` is never overwritten silently.
- The official namespaced command always works without the alias.

## Milestone 9: Test and evaluation suite

Deliverables:

- Unit tests.
- Hook fixture tests.
- Cross-platform path tests.
- Prompt-policy evaluations.
- Security and privacy tests.

Acceptance:

- Tests run on Windows and Linux.
- Plugin validation runs in CI.
- Critical policy regressions fail CI.

## Milestone 10: Release and public pilot

Deliverables:

- Version `0.1.0`.
- GitHub release.
- Checksums and attestation where practical.
- Installation documentation.
- Pilot feedback template.

Acceptance:

- A clean machine can add the marketplace, install the plugin, run setup, and complete a fixture task.
- Uninstall removes only KRYLO-owned state.
- No production or external write occurs during the pilot fixture.
