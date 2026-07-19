---
name: audit-tool
description: Review a Claude Code plugin, skill, MCP server, package, CLI, or local path before KRYLO uses or recommends it. Analyze source, version, publisher, hooks, install scripts, permissions, network behavior, secrets, and production risk.
argument-hint: "<name-or-path>"
disable-model-invocation: true
user-invocable: true
model: opus
---

# KRYLO Tool Audit

Target: `$ARGUMENTS`

1. Remain read-only.
2. Identify publisher, source, exact version or commit, license, and update mechanism.
3. Inspect relevant manifests, hooks, scripts, lockfiles, MCP definitions, and installation behavior.
4. Flag remote execution, `postinstall`, shell interpolation, unverified downloads, home-directory access, secret access, broad network access, settings mutation, auto-update, and permission bypasses.
5. Compare the target with KRYLO's trust registry and blocked-version records.
6. Classify data egress and environment suitability.
7. Return a trust tier, evidence, required isolation, allowed modes, prohibited modes, and re-review triggers.
8. Do not install or execute the target unless a separate explicit task requests it after the audit.
