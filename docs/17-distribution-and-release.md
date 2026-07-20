# Distribution and Release

## Distribution model

The GitHub repository contains both:

- A marketplace catalog at `.claude-plugin/marketplace.json`.
- The KRYLO plugin under `plugins/krylo/`.

## Installation

Users add the marketplace, install the plugin, and reload plugins. Exact commands are documented in the public README (`https://github.com/FreeJaguar/KRYLO`).

## Claude Code compatibility (docs/adr/0022-claude-code-compatibility-policy.md)

- Minimum supported Claude Code CLI: `2.1.197`, enforced as a pinned, PR-blocking floor in `.github/workflows/validate-plugin.yml`. This pin changes only through a deliberate, reviewed update to that workflow, this document, `RELEASE_READINESS.md`, and the ADR — never automatically.
- Current-version compatibility is checked separately by the weekly (and on-demand) `.github/workflows/claude-code-compat.yml`, which installs the latest published CLI. It never runs on push or pull_request and can never block a release; a failure is a triage signal for maintainers, not an automatic change to the pinned floor.

## Versioning

Use Semantic Versioning:

- MAJOR: incompatible behavior or schema changes.
- MINOR: backward-compatible capabilities.
- PATCH: backward-compatible fixes.

Public releases use explicit plugin and marketplace versions. Development may use local `--plugin-dir` or a local marketplace.

## Release gates

A release requires:

- Plugin validation.
- Test suite.
- Security scans.
- Secret scan.
- SBOM.
- Changelog.
- Upgrade and uninstall test.
- Clean-machine install test.
- Release checksum and attestation where practical.

## Public publishing boundary

The implementation run may prepare local commits and release artifacts. Creation of the public repository, first push, marketplace publication, and official-marketplace submission require explicit user approval.
