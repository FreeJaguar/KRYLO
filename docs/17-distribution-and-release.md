# Distribution and Release

## Distribution model

The GitHub repository contains both:

- A marketplace catalog at `.claude-plugin/marketplace.json`.
- The KRYLO plugin under `plugins/krylo/`.

## Installation

Users add the marketplace, install the plugin, and reload plugins. Exact commands are documented in the public README after the GitHub owner is known.

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
