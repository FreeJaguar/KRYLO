# ADR-0031: Ecosystem Maintenance drift checker

## Status

Accepted

## Context

`docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 15 reserved a future "Upstream maintenance subsystem" but described it specifically as watching KRYLO's own *reviewed third-party tool catalog* (`plugins/krylo/catalog/tools.json`) for drift — a different, narrower concern than "has Claude Code, Codex, KRYLO's pinned GitHub Actions, Node.js support, or KRYLO's own npm dependencies drifted." ADR-0029's "Consequences" section explicitly left both "the weekly Upstream Watch" and "the monthly Ecosystem Radar" out of scope. This ADR implements neither of those; it implements a genuinely new, narrower capability requested directly: a read-only checker that detects drift in KRYLO's own upstream platform/tooling dependencies, distinct from and not a substitute for a future third-party-tool-catalog watch or ecosystem-discovery feature, both of which remain unimplemented and out of scope here.

## Decision

### Read-only, detection/reporting only, non-authoritative

`plugins/krylo/scripts/maintenance/check-ecosystem.mjs` and its six check modules (`plugins/krylo/scripts/maintenance/checks/*.mjs`) never edit a repository file, commit, push, open or modify a PR/issue, merge, tag, release, publish, deploy, modify a repository setting, update a dependency/pinned-version/hash/manifest automatically, send an external message, or invoke a production system. A detected drift becomes one normalized `MaintenanceCheck` entry in a `MaintenanceReport` (`plugins/krylo/scripts/lib/maintenance-schema.mjs`) — evidence for a later, separate, human-approved maintenance task, never an authorization to act. This mirrors, at a smaller and more concrete scope, the "drift is evidence, not authorization" principle Cross-Harness (ADR-0030) already established for a worker's own findings.

### Official-source-only upstream verification

The only network sources ever contacted are GitHub's own REST API (`api.github.com`, `github.com`) — enforced by a fixed domain allowlist in `plugins/krylo/scripts/lib/upstream-client.mjs`, checked on the initial request AND every redirect hop, so a redirect escaping the allowlist is a failure, never silently followed. No scraping of blogs, forums, package mirrors, or unofficial changelog sites. `npm view`/the npm registry API was deliberately NOT added as a checker source: research performed while building this ADR found the npm registry unreliable to reach directly in this environment's network path (redirected/blocked), and since GitHub Releases — not npm — is what `validate-plugin.yml`/`release.yml` actually install the pinned Claude Code floor from, adding a second, less-reliable, non-essential upstream dependency was rejected as unnecessary surface area rather than worked around.

### Minimum/tested/latest version separation

Every version-drift check keeps three distinct concepts apart: KRYLO's own pinned/documented floor or tested version (read from repository content, e.g. `validate-plugin.yml`'s embedded release URL, or `docs/codex-capability-matrix.md`'s stated tested version), the live-observed latest upstream release, and — separately — whether the pinned/tested value is still even available upstream at all. A newer observed release is reported at `severity: info` and never itself raises the pinned floor, changes a tested-version claim, or fails the checker (task-explicit: "a latest observed provider version does NOT automatically become minimum supported, tested, or pinned"). Only a human, through a separate, reviewed change, moves those values.

### Least-privilege scheduled workflow

`.github/workflows/ecosystem-maintenance.yml`: `permissions: contents: read` at the top level (no job overrides it more broadly), checkout pinned to the same SHA already used throughout this repository's other workflows with `persist-credentials: false`, no secret, no PAT, monthly schedule plus `workflow_dispatch`, and — critically — never `push`/`pull_request` triggered, so it can never block a PR or a release. `plugins/krylo/tests/governance/ecosystem-maintenance-workflow.test.mjs` statically proves each of these properties against the shipped file, not merely the intent described here.

### Network-failure semantics that cannot fabricate a pass

`upstream-client.mjs`: 10s timeout, 2MB response-size cap enforced while streaming (not only via a possibly-absent `Content-Length` header), max 3 redirects, exactly one bounded retry for a network-level failure (timeout/connection error) and never a second attempt once an HTTP response was actually received (every request in this system is a `GET`; nothing here ever writes). A `429`/`5xx`/timeout/malformed-JSON response becomes an explicit `unavailable`/`SOURCE_UNAVAILABLE`-shaped check result, never a fabricated "up to date" — verified directly (`plugins/krylo/tests/maintenance/upstream-client.test.mjs`, `network-unavailable.test.mjs`) with every scenario task Section 19.B/I requires: allowed/blocked domain, redirect within/outside the allowlist, timeout, oversized response, invalid JSON, 404, 429, 500, and a full offline run against this real repository proving every internal-consistency check still runs correctly while every genuinely network-dependent check reports `unavailable` rather than a false pass.

### Minimal dependencies, no fake semver parser

Node built-ins only (`fetch`, `URL`, `AbortController`) — no `axios`/`got`/`octokit`/`semver` added. `plugins/krylo/scripts/lib/version-compare.mjs` implements exactly the three version shapes this checker needs (Claude Code `X.Y.Z`, Codex `rust-vX.Y.Z`/`codex-cli X.Y.Z`, Node `X.Y`); anything not matching one of those narrow shapes is an explicit `malformed-version` failure, never a guessed comparison.

### Verified official sources before implementation, not memory

Recorded in full in `docs/process/ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md` Section 7: GitHub's unauthenticated REST API rate limit (60 requests/hour/IP), the `releases/latest`/`tags`/`commits/{ref}` endpoint shapes, current GitHub Actions security-hardening guidance, and two genuinely time-sensitive facts checked live rather than assumed from a prior checkpoint's own disclosure — the npm-vs-GitHub-Releases lag ADR-0022 recorded for Claude Code has since closed (both now at `2.1.246`), and Codex's real current upstream state (`0.149.1` stable, newer alphas beyond that) is substantially ahead of the `0.120.0` KRYLO is verified/tested against. Live-verified directly against this repository: a full live run correctly reports both facts as non-blocking `info`/`medium`-severity attention items (never forcing exit 1), and correctly confirms every one of this repository's 25 pinned GitHub Action SHAs still resolves to the exact commit its own version comment claims.

### Reuses, does not duplicate, existing CI

`actions-security.yml`'s pin-check job already CI-enforces the same "every `uses:` is a full commit SHA" invariant this checker's `actions-pins-format` result also checks — kept as a cheap internal sanity check, not removed or replaced, because the genuinely new capability (verifying, over the network, that a pinned SHA still resolves to its own stated tag) has no existing equivalent. `dependency-security.yml` (OSV scan) and `sbom.yml` are similarly not duplicated; this checker's dependency category runs `npm audit --json` (KRYLO's own already-available package-manager tooling) as a second, always-available signal, distinct from and not a replacement for the network-backed OSV scan already in CI.

## A genuine Windows platform bug found and fixed while building this: `npm.cmd` is not an npm `cmd-shim`

`spawn-platform.mjs` (built for Cross-Harness, ADR-0030) correctly, safely fails closed (`null`) when asked to resolve `npm` on Windows: `npm.cmd`, unlike `claude.cmd`/`codex.cmd`, is Node.js's OWN installer bootstrap script, not an npm `cmd-shim`-generated file, and resolves its real target through a `SET`-variable chain plus a dynamic `FOR /F` subprocess call — genuinely different from, and not statically parseable by, the shim-resolution logic that module documents supporting. This was caught live: the dependency-category check's `npm audit --json` call reported `unavailable` in this environment despite `npm audit` working fine when run directly from a shell. Fixed by resolving `npm-cli.js` directly relative to `process.execPath` (Node always ships it colocated with the running `node.exe`) and invoking that with `node.exe` directly — the same "resolve and invoke the REAL target, never guess" philosophy `spawn-platform.mjs` already established, applied correctly to npm's own different bootstrap shape rather than forcing `spawn-platform.mjs`'s existing parser to (unsafely) guess at a dynamic `FOR /F` resolution it cannot verify statically. Falls back to `platformSpawnTarget('npm', ...)` (correct on POSIX, and for any environment where npm was installed via an actual `cmd-shim`) if the colocated `npm-cli.js` is not found.

## Consequences

- No new third-party dependency, no new secret, no new repository-write automation.
- `plugins/krylo/catalog/tools.json`'s own reviewed third-party tool set is untouched and unwatched by this checkpoint; a future Weekly Upstream Watch (design doc Section 15) or Monthly Ecosystem Radar (Section 16) remains separate, unimplemented, out-of-scope work.
- The pinned Claude Code floor (`2.1.223`), tested Codex version (`0.120.0`), and KRYLO product version (`0.1.1`) are all unchanged by this ADR; this checker can only ever report that they should be reviewed, never change them itself.
- KRYLO Core continues to function identically whether or not this checker or its scheduled workflow ever runs — it is purely additive, read-only tooling with no runtime coupling to `init-run.mjs`/`update-state.mjs`/the risk gate/Orbit.

## Supersedes

None. Narrows `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 15's "Upstream maintenance subsystem" placeholder to exactly what this checkpoint implements, without claiming to implement Section 15's third-party-tool-catalog watch or Section 16's Ecosystem Radar.

## Superseded by

None.
