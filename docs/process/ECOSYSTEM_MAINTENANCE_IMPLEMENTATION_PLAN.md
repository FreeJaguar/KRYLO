# KRYLO Ecosystem Maintenance implementation plan (Plan 4)

Governing task: "Implement KRYLO Ecosystem Maintenance — Plan 4" (repository-local task input, not itself a committed source document). Verified starting branch `feat/multi-host-0.2`, HEAD `4de997877abf49a6dd501fb69adec39ceb9c780d` — an exact match to Plan 4's own stated expected starting HEAD (the final HEAD of the Cross-Harness v1 checkpoint, ADR-0030). Foundation, Claude Host, Codex Host, and Cross-Harness are accepted and are not reopened by this checkpoint except where a genuine regression in code this plan touches requires it (none found).

## 1. Relationship to the approved multi-host design

`docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 15 ("Upstream maintenance subsystem") already describes a **Weekly Upstream Watch** — but that feature watches KRYLO's own *reviewed third-party tool catalog* (`plugins/krylo/catalog/tools.json`: `mattpocock/skills`, OmniRoute, code-review-graph, Superpowers, OpenWiki) for drift in externally-integrated Skills/Plugins/MCP servers. Plan 4's own task specification is narrower and different in kind: it never mentions `tools.json` or any third-party Skill/Plugin/MCP-server catalog at all. It asks specifically whether **KRYLO's own upstream platform dependencies** — the Claude Code CLI, the Codex CLI, pinned GitHub Actions, Node.js runtime support, and KRYLO's own (currently zero) npm dependencies — have drifted from what KRYLO's documentation and CI pins claim.

Per this repository's own decision-authority order (`CLAUDE.md`: the user's latest explicit approved decision outranks a draft design document), this checkpoint implements exactly what Plan 4's own task specification describes: a **provider/Action/runtime/dependency compatibility-drift checker**, deliberately scoped away from Section 15's third-party-tool-catalog watch and from Section 16's "Monthly Ecosystem Radar" (discovery of *new* ecosystem tools, itself an entirely separate, scored-discovery feature). Both of those remain explicitly out of scope, exactly as they already are in ADR-0029's own "Consequences" section ("the weekly Upstream Watch, the monthly Ecosystem Radar... remain out of scope for this ADR"). This checkpoint's own new ADR (ADR-0031) records this specialization explicitly, mirroring how ADR-0030 (Cross-Harness) recorded its own narrowing of the design doc's broader role list.

## 2. What already exists that this checkpoint reuses, not duplicates

- **`claude-code-compat.yml`** (ADR-0022): an existing weekly/manual workflow that installs `@anthropic-ai/claude-code@latest` and runs the full strict-validation + test suite against it. This is coarse (pass/fail of the whole suite, no structured evidence, no separate minimum/tested/latest distinction, no Codex/Actions/Node/dependency coverage) but already catches the single highest-value Claude-side signal. Plan 4's own Claude-compatibility check (category A) is complementary, not a replacement: it adds structured, versioned, severity-classified evidence (is the pinned floor `2.1.223` still a real, fetchable GitHub release; does every doc that states the floor agree) without re-running the full test suite against `@latest` a second time.
- **`actions-security.yml`**'s `pin-check` job: an existing, already-CI-enforced `grep`-based check that every `uses:` reference in `.github/workflows/**` is pinned to a full 40-hex commit SHA (not a mutable tag/branch/`latest`). Plan 4's own Action-pin check (category C) does not re-implement this exact invariant as new CI-blocking logic; it reuses the same acceptance shape (full-SHA-only) as a cheap internal sanity check inside a broader, genuinely new capability actions-security.yml does not have: verifying, over the network, that each pinned SHA still resolves to the exact tagged release/publisher the workflow's own trailing `# vX.Y.Z` comment claims — drift here (a SHA that no longer matches its own stated tag, e.g. because a tag was force-moved, or a comment fell out of sync with a later re-pin) is new signal, not duplicated CI.
- **`dependency-security.yml`** (OSV scanner + `dependency-review-action`) and **`sbom.yml`**: already cover dependency vulnerability scanning and SBOM generation in CI. Plan 4's dependency check (category E) does not duplicate a vulnerability database query; it runs `npm audit --json` (repository's own already-available package-manager tooling, per Section 8's explicit instruction to prefer existing reviewed utilities) as a second, independent, always-available signal usable in `--offline` mode too (`npm audit` reads the local lockfile; it does not require network access to enumerate KRYLO's own dependency tree, only to check advisories, which is itself covered separately by `dependency-security.yml`'s network-backed OSV scan in CI). KRYLO currently has **zero** runtime/dev dependencies (`package.json` has no `dependencies`/`devDependencies` key at all), so this check's primary value is drift detection (a dependency was added) rather than vulnerability scanning of an empty tree.
- **`plugins/krylo/scripts/validation/validate-runtime.mjs`**: the existing syntax/schema/host-isolation self-check. Not modified; the new maintenance checker is a sibling standalone script (`plugins/krylo/scripts/maintenance/check-ecosystem.mjs`), following the same `scripts/<category>/` convention as `scripts/validation/` and `scripts/setup/`, not a run-lifecycle Hook and not part of Shared Core's run-state machinery (it never touches `state.json`, never requires a `HostIdentity`/`HostContext`, and is not gated by the risk gate — it is read-only by construction, has no tool-call surface for the risk gate to intercept, and is invoked directly by a human or by the new scheduled workflow).

## 3. Verified current pinned/reference values (baseline this checkpoint's checks are written against)

| Surface | Current value | Source |
|---|---|---|
| KRYLO product version | `0.1.1` | `package.json`, `plugins/krylo/.claude-plugin/plugin.json`, `plugins/krylo/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`'s top released heading `## [0.1.1]` — all currently agree |
| Claude Code CLI minimum supported | `2.1.223` | `docs/adr/0022-claude-code-compatibility-policy.md`, `.github/workflows/validate-plugin.yml`, `.github/workflows/release.yml`, `RELEASE_READINESS.md` |
| Claude Code CLI locally installed (this environment) | `2.1.197` | live `claude --version`; a disclosed, pre-existing gap (npm registry has not published past `2.1.197`; the `2.1.223` floor is real on GitHub Releases as a checksummed binary) — ADR-0022's own "Critical discovery" section |
| Codex CLI verified/tested against | `codex-cli 0.120.0` (GitHub tag `rust-v0.120.0`) | `docs/codex-capability-matrix.md`, `docs/adr/0029-codex-host-packaging-and-approval-boundary.md`; live `codex --version` in this environment agrees |
| Node.js supported | `>=22.0.0` (`package.json` `engines`); CI matrix tests `22` and `24`; `release.yml`/`validate-plugin.yml`/`claude-code-compat.yml` install `24` | `package.json`, `package-lock.json`, `.github/workflows/test.yml` |
| npm dependency count | `0` (no `dependencies`/`devDependencies`) | `package.json`, `package-lock.json` |
| GitHub Action pins | every `uses:` in `.github/workflows/*.yml` is a full 40-hex SHA with a trailing `# vX.Y.Z`-style comment | direct inspection of all 10 existing workflow files |

These are read at runtime by the checker (parsing the actual repository files), never hardcoded as literals in the checker's own source — the table above documents the values *observed while writing and testing the checker*, not values the checker assumes.

## 4. Architecture

One host-neutral maintenance library plus category-specific check modules, mirroring Shared Core's own "one shared implementation, thin specific pieces" convention (ADR-0023) even though this subsystem has no host adapters of its own (it is not part of a KRYLO run):

```text
plugins/krylo/scripts/lib/maintenance-schema.mjs   # MaintenanceReport/MaintenanceCheck shape,
                                                    # builder + validator, deterministic ordering
plugins/krylo/scripts/lib/version-compare.mjs      # minimal, correct X.Y.Z comparator; malformed
                                                    # input -> explicit failure, never silently accepted
plugins/krylo/scripts/lib/upstream-client.mjs      # safe fetch: domain allowlist, timeout, size cap,
                                                    # redirect-boundary enforcement, bounded single retry
plugins/krylo/scripts/maintenance/checks/claude-compat.mjs
plugins/krylo/scripts/maintenance/checks/codex-compat.mjs
plugins/krylo/scripts/maintenance/checks/actions-pins.mjs
plugins/krylo/scripts/maintenance/checks/node-runtime.mjs
plugins/krylo/scripts/maintenance/checks/dependencies.mjs
plugins/krylo/scripts/maintenance/checks/internal-drift.mjs
plugins/krylo/scripts/maintenance/check-ecosystem.mjs   # CLI entrypoint: --offline, --json, orchestration
.github/workflows/ecosystem-maintenance.yml              # read-only scheduled + workflow_dispatch
plugins/krylo/schemas/maintenance-report.schema.json      # hand-written schema (ADR-0017 convention)
```

Each check module exports one function taking `{ repoRoot, offline, fetchUpstream }` and returning an array of normalized check results (never throws; a check that fails to run reports its own `status: "unavailable"` entry instead of aborting the whole run). `check-ecosystem.mjs` aggregates every module's results into one `MaintenanceReport`, computes the top-level `status`, and is the only place that decides the process exit code.

## 5. Result model

```jsonc
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-08-26T12:00:00.000Z",
  "repositoryVersion": "0.1.1",
  "mode": "offline | live",
  "status": "ok | attention-required | blocked",
  "checks": [
    {
      "id": "claude-pinned-floor-available",
      "category": "claude-compat | codex-compat | actions-pins | node-runtime | dependencies | internal-drift",
      "status": "ok | changed | warning | blocked | unavailable",
      "severity": "info | low | medium | high | critical",
      "current": "2.1.223",
      "observed": "2.1.223",
      "evidence": ["https://api.github.com/repos/anthropics/claude-code/releases/tags/v2.1.223"],
      "recommendedAction": "none",
      "requiresHumanReview": false
    }
  ]
}
```

`current` and `observed` are always short, bounded scalar strings (a version, a SHA, a count) — never raw upstream response bodies, never source code, never secret-shaped content. `evidence` is a bounded array (max 5 entries) of short strings: a URL, a repository-relative file path, or a one-line normalized fact — never a full upstream JSON dump. `status: "ok"` at the top level requires every individual check to be `ok`, `warning`, or (in offline mode) `unavailable`; any `changed`/`blocked` check with `severity` `high`/`critical` forces top-level `status: "attention-required"` (or `"blocked"` for a genuine checker/config failure distinct from a detected drift — see Section 9).

## 6. Version comparison

`version-compare.mjs` implements exactly the shapes actually in use, per Section 8's explicit instruction not to write a fake semver parser that silently accepts malformed input:

- **Claude Code**: `X.Y.Z` (optionally `v`-prefixed in a git tag, e.g. `v2.1.223`); no prerelease/build-metadata segments observed in any real Claude Code release tag.
- **Codex**: GitHub tags use the `rust-vX.Y.Z` prefix (confirmed directly against the real `rust-v0.120.0` tag, ADR-0029); `codex --version`'s own output is `codex-cli X.Y.Z`. The comparator strips either known prefix before parsing.
- **Node.js**: `X.Y` major.minor pairs (engines-range comparison, not full semver — KRYLO's own `engines` field is a `>=` floor, not a pinned exact version).

Anything not matching one of these three exact, narrow shapes returns an explicit `{ ok: false, reason: "malformed-version" }` — the calling check module turns that into a `status: "unavailable"` (or `"blocked"` if the malformed value came from KRYLO's *own* repository content rather than upstream) result, never a silently-assumed pass.

## 7. Safe upstream fetch

`upstream-client.mjs` uses only Node built-ins (`fetch`, `URL`, `AbortController` — no `axios`/`got`/`octokit`/`semver` dependency, per Section 8). A fixed domain allowlist (`api.github.com`, `github.com` — for the `codeload`-free `tags`/`commits` API responses and `html_url` cross-references only, never for cloning) is enforced on both the initial request and every redirect hop — a redirect to a domain outside the allowlist is treated as a failure (`unavailable`), never silently followed. Bounded: 10s request timeout (`AbortController`), 2MB response-size cap (checked incrementally while streaming, not only via a possibly-absent `Content-Length` header), max 3 redirects, `Accept: application/vnd.github+json` for every GitHub REST API call. Exactly one bounded retry for a network-level failure (connection reset, timeout) on an idempotent `GET` only — never a second attempt after a response was already received (Section 21) and no request in this system ever writes. A `429`/`5xx`/timeout/malformed-JSON response becomes `unavailable`/`SOURCE_UNAVAILABLE`, never a fabricated "up to date."

**Verified directly against official sources (not memory) before implementation:**

- GitHub REST API unauthenticated rate limit: **60 requests/hour per IP** (`https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`). This checker issues on the order of 10-15 GET requests per run (one `releases/latest` + one `tags`/`commits` lookup per pinned GitHub Action owner/repo, plus Claude Code and Codex), comfortably within budget for a monthly scheduled cadence, and does not require a token.
- `GET /repos/{owner}/{repo}/releases/latest`, `GET /repos/{owner}/{repo}/tags`, and `GET /repos/{owner}/{repo}/commits/{ref}` (`{ref}` may be `tags/<name>` to resolve a tag to its commit SHA) are all current, confirmed, unauthenticated-accessible REST endpoints (`docs.github.com/en/rest/releases/releases`, `.../rest/repos/repos`, `.../rest/commits/commits`).
- GitHub's official Actions security-hardening guidance (`docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`) confirms full-commit-SHA pinning and least-privilege `GITHUB_TOKEN` scoping as the current recommended practice, unchanged from what this repository's existing workflows already do; `persist-credentials: false` is documented by `actions/checkout` itself (default `true`), not the general hardening guide, and is likewise already applied everywhere in this repository.
- **The npm-vs-GitHub-Releases lag ADR-0022 disclosed (npm stuck at `2.1.197` while GitHub had reached `2.1.223`+) has since closed**: a live check performed while writing this plan found npm's `@anthropic-ai/claude-code` `latest` dist-tag and `anthropics/claude-code`'s newest GitHub Release both at `2.1.246`. This is exactly the kind of fact this checker exists to detect fresh each run, not assume from a prior checkpoint's own disclosure — the checker's Claude-compatibility check therefore treats **GitHub Releases as the sole authoritative source** (matching what `validate-plugin.yml`/`release.yml` actually install from) and does not poll the npm registry at all: npm's registry API proved unreliable to reach directly in this environment's own network path during research (redirected/blocked), and since it is not KRYLO CI's install source of truth, adding it as a second, less-reliable, non-essential upstream dependency was rejected as unnecessary surface area (YAGNI) rather than worked around.
- Codex's real current upstream state (checked live, same research pass): latest stable GitHub Release `0.149.1`, with newer `0.150.0-alpha.*` pre-releases beyond that — confirming `codex-cli 0.120.0` (what KRYLO is verified/tested against) is genuinely, substantially behind current upstream. This is exactly the `ATTENTION_REQUIRED`-shaped signal category B exists to surface (`severity: medium`, "tested provider version is old enough to merit review" per Section 14) — not itself evidence of a broken contract, since Codex Host remains unpublished and no compatibility floor has been formally raised.
- Node.js LTS schedule (`nodejs.org/en/about/previous-releases`, `nodejs.org/en/about/eol`): 22.x ("Jod") entered Maintenance LTS in October 2025 (EOL April 2027); 24.x ("Krypton") is the current Active LTS line (EOL April 2028) as of `24.11.0`. This is publicly fixed, long-published schedule data, not a fast-moving fact — category D (Section 5.D of the parent task) only asks for *internal* consistency across `package.json`/workflows/docs, which is fully deterministic and needs no live network call, so no runtime fetch to `nodejs.org` was added for this category (YAGNI); the schedule fact above is recorded here only as verification context for why `engines: >=22.0.0` remains a reasonable floor.

## 8. GitHub Actions workflow

`ecosystem-maintenance.yml`: `workflow_dispatch` plus a monthly schedule (deliberately less frequent than the existing weekly `claude-code-compat.yml`, since Actions-pin/dependency/internal-drift signals do not change as fast as "does the plugin still validate against the latest Claude Code" and duplicate-but-more-frequent scheduling would be exactly the "permanent noisy CI" Section 10 warns against). `permissions: contents: read` at the top level, nothing broader. Checkout pinned to the same SHA already used everywhere else in this repository's workflows, `persist-credentials: false`. No PAT, no repository-write credential, no step that creates a branch/commit/PR/issue/release/tag. On `ATTENTION_REQUIRED` the job step exits non-zero only for a `high`/`critical`-severity check (matching Section 10's explicit "informational newer upstream release -> should not necessarily make main permanently red"); the full structured report is written to the GitHub Actions Job Summary (`$GITHUB_STEP_SUMMARY`) in the human-readable CLI format, never as a giant JSON dump.

## 9. Exit codes

- `0`: checker ran to completion; no `high`/`critical` check.
- `1`: at least one `high`/`critical`-severity check reports `changed`/`blocked` (a verified, human-actionable drift or contract break).
- `2`: the checker itself failed to run correctly (a config/parse error in KRYLO's own repository content, not an upstream network condition) — distinct from `1` so a broken checker is never confused with "everything's fine" (exit `0`) or "found something" (exit `1`).

An `unavailable` upstream source alone never produces exit `1`; it can only ever produce, at most, a `medium`-severity `warning` (an unresolved live-verification gap is worth surfacing, never worth treating as equivalent to a confirmed break) and is always distinguishable in the report from a confirmed contract break.

## 10. Testing (TDD, Section 19 categories A-J)

New test directory `plugins/krylo/tests/maintenance/`, plus a `test:maintenance` `npm` script. Deterministic fixtures (canned upstream JSON responses, a fake `fetch` injected via the check modules' own `fetchUpstream` parameter) so the normal suite never depends on live network access; a separate, explicitly-labeled live probe script (not part of `npm test`) exercises the real upstream sources when network access is available, matching the same "deterministic tests + a separate live smoke probe" split this repository already used for Cross-Harness.

## 11. Documentation

ADR-0031 (next available number, confirmed by listing `docs/adr/`) records: read-only maintenance, no automatic remediation, no scheduled repository writes, official-source-only upstream verification, drift-is-evidence-not-authorization, minimum/tested/latest version separation, least-privilege workflow permissions, network-failure semantics, and this checkpoint's specialization away from the design doc's broader Section 15/16 scope. `ARCHITECTURE.md`, `SECURITY.md`, `THREAT_MODEL.md`, `RELEASE_READINESS.md`, `FILE_MANIFEST.md`, and `CHANGELOG.md` are updated to describe what shipped; `README.md` gets a short mention only if a maintainer-facing command is worth documenting there.
