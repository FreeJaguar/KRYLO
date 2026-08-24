# ADR-0022: Claude Code compatibility policy — pinned floor plus separate current-version check

## Status

Accepted

## Context

`validate-plugin.yml` installs `@anthropic-ai/claude-code@2.1.223` (the minimum supported version) and runs strict plugin/marketplace validation against it. That pin is deliberate: it is the release-producing, PR-blocking compatibility floor, and it must never silently drift to whatever CLI version happens to be current when the workflow runs — an unpinned `@latest` install in that job would make the same commit pass or fail non-deterministically as upstream ships new CLI releases, and a breaking upstream schema change could block every PR with no actionable signal.

At the same time, KRYLO only benefits users if it keeps working on the CLI they actually have installed, which is normally newer than the pinned floor. Nothing in the pinned job exercises that.

### Version bump: 2.1.197 → 2.1.223 (security-hardening checkpoint)

ADR-0025 (native permission approval) requires a Claude Code version where official documentation guarantees that a PreToolUse Hook's `permissionDecision: "ask"` reliably produces a blocking human prompt, rather than being silently overridden by auto-mode or other permission configuration (`anthropics/claude-code#39344`; ADR-0024's original context). This project's own CHANGELOG (`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, checked in full through the current released version) states, for v2.1.211 exactly:

> Fixed auto mode overriding a PreToolUse hook's `ask` decision for unsandboxed Bash — a hook `ask` now floors the decision at a prompt

That confirmation alone would justify a floor of 2.1.211. Independent security review of that decision found the CHANGELOG carries two more directly relevant entries at later versions, both quoted verbatim after independent verification against the raw upstream file:

> (v2.1.221) Fixed a Bash tool permission-check bypass where zsh could execute hidden commands in `[[ ]]` regex conditionals; affected commands now prompt for permission
>
> (v2.1.223) Fixed a Bash permission bypass where a crafted command could hide parts of itself from permission checks

Relying on a human's native `ask` prompt for informed consent requires that the prompt the human actually sees reflects the real command being run. A version where part of a Bash command could still hide from the permission layer's own analysis would undermine that premise even though the auto-mode-override bug itself was already fixed at 2.1.211 — the human could be shown, and approve, an incomplete view of what actually executes. The floor is therefore raised to **2.1.223**, the version that closes the more recent and most directly relevant of these two bypasses (2.1.223 supersedes 2.1.221 as a floor).

No CHANGELOG entry through the current released version extends the underlying auto-mode-`ask`-flooring guarantee to PowerShell or to any MCP tool's permission dialog (see ADR-0025/ADR-0026 for why `ask` is accordingly not used for those tool types, and is further narrowed on Bash itself to only the `git-push`/`git-force` action classes).

**Residual, disclosed limitation**: this project's own local validation environment runs Claude Code CLI `2.1.197` (confirmed via `claude --version`), below this floor. Every `claude plugin validate --strict` and `npm test` run performed while raising this floor was executed against the locally installed `2.1.197`, not `2.1.223` — the floor itself is a declared, evidence-backed CI/documentation decision, not a behavior locally exercised at that exact version in this environment. `RELEASE_READINESS.md` states this explicitly rather than implying the newer version was verified locally.

This bump is a real cross-reference to check going forward: ADR-0016 (`subagentStatusLine`, requires 2.1.207) was deferred solely because the previous 2.1.197 floor was below that requirement. The new floor is now above it — this ADR does not itself implement `subagentStatusLine` (out of this checkpoint's scope), but ADR-0016 should be revisited as a now-unblocked, not-yet-implemented opportunity.

### Critical discovery during the final verification checkpoint: npm has not published past 2.1.197

Attempting `npm install -g @anthropic-ai/claude-code@2.1.223` in this checkpoint failed outright:

```
npm error code E404
npm error 404 No match found for version 2.1.223
```

Direct verification (`npm view @anthropic-ai/claude-code versions`/`dist-tags`, checked live during this session) confirmed the npm registry's `latest`, `next`, and every other dist-tag for this package currently resolve to **2.1.197** — the exact same version this project pinned before this whole checkpoint began — and no version above it has ever been published there. Cross-checked against GitHub: `v2.1.197` was released 2026-06-30; GitHub Releases have continued steadily since (v2.1.223 published 2026-08-06; v2.1.241, the CHANGELOG's current top entry, published 2026-08-23 — the day before this checkpoint). **The npm registry has been roughly two months and 44 versions behind the upstream GitHub release cadence.** This means:

- Every CHANGELOG-cited version this ADR and ADR-0025 rely on (2.1.211, 2.1.221, 2.1.223) is real, genuinely released, and downloadable directly from GitHub Releases as a checksummed binary (`SHASUMS256.txt` + detached `.sig` per release) — this is not a documentation error or a hallucinated version number.
- It is, however, **not installable via the standard `npm install -g @anthropic-ai/claude-code@<version>` command** that most users' own update path (and `claude update`'s own self-update mechanism, which explicitly falls back to `npm view` and fails the same way in this environment) likely relies on.
- `validate-plugin.yml`/`release.yml`'s pin (as previously written) would have failed with the exact 404 above the first time either workflow actually ran — a real, previously undetected break in this project's own CI, introduced by this checkpoint's earlier version bump and only caught by this final verification pass.
- `claude-code-compat.yml`'s `@latest` install is unaffected in the sense that it will not fail, but it is currently not testing anything newer than the pinned floor either, since npm's own `@latest` tag is the same 2.1.197 — its whole purpose (catching drift against the actually-current CLI) is temporarily degraded until npm publishing resumes. No code change was made for this: it is intentionally unpinned and will self-correct once npm catches up, with no maintainer action required.

**Decision**: keep the pinned floor at **2.1.223** (the version this ADR's and ADR-0025's security reasoning is anchored to, and which was live-verified against a real running binary during this checkpoint — see ADR-0025's verification log), but change how `validate-plugin.yml` and `release.yml` install it: both now download the exact GitHub release binary for the runner's platform (`claude-linux-x64.tar.gz`) directly, verifying its published SHA-256 checksum before ever executing it, rather than through npm. This keeps the floor meaningful and CI actually installable, instead of either silently reverting the floor to 2.1.197 or leaving a workflow step that would 404 on its first real run.

This is disclosed as a genuinely open, unresolved product question, not a decision made unilaterally on the maintainer's behalf: if most real KRYLO users update Claude Code via `npm`/`claude update` (which currently caps at 2.1.197), then a "minimum supported" floor above that is not actually reachable by those users through their normal update path, regardless of what CI installs. Whether to also document/prefer the GitHub-binary install path in KRYLO's own user-facing setup guidance, revert the floor until npm catches up, or accept this gap as temporary and npm-registry-side, is a maintainer decision this ADR does not make on its own.

## Decision

Two separate, independently-scoped checks:

1. **Pinned floor (`validate-plugin.yml`, unchanged)** — runs on every push to `main` and every PR, installs `@anthropic-ai/claude-code@2.1.223` exactly, and is a required, PR-blocking check. This version is the documented minimum supported Claude Code release and changes only through an explicit ADR update, never automatically.
2. **Current-version compatibility (`claude-code-compat.yml`, new)** — runs on a weekly schedule and on manual `workflow_dispatch`, installs `@anthropic-ai/claude-code@latest` (intentionally unpinned — that is the entire point of the check), and runs the same strict plugin/marketplace validation plus the full test suite. It never runs on `push` or `pull_request` and is not a required check, so a failure here can never block a PR or a release.

A failure of the current-version job:

- Produces a normal failed GitHub Actions run (visible in the Actions tab and, if configured by the repository owner, via the default failed-scheduled-workflow email/notification) — clear, durable evidence.
- Does **not** change `validate-plugin.yml`'s pinned version, touch `RELEASE_READINESS.md`'s stated minimum, or otherwise mutate any file. Any version bump is a separate, human-reviewed change.

## Version upgrade policy

- The pinned minimum (`validate-plugin.yml` and every doc that states it) advances only when a maintainer deliberately reviews a `claude-code-compat.yml` failure or a new CLI release, decides KRYLO now requires it, and updates the pin, this ADR, and `RELEASE_READINESS.md` together in one reviewed change.
- The floor is never advanced by CI itself, by a scheduled run, or as a side effect of an unrelated commit.

## Handling breaking Claude Code schema changes

- A `claude-code-compat.yml` failure caused by a schema/behavior change upstream is triaged as a normal bug: reproduce locally against the new CLI, determine whether KRYLO's plugin/hook/skill manifests need updating for the new schema, and whether the minimum supported version should move forward (dropping compatibility with older CLI lines) or whether KRYLO can support both old and new shapes.
- Until triaged and fixed, the pinned floor and the shipped plugin are unaffected: users on the pinned floor or between the floor and the breaking version continue to work exactly as before, because the pinned job never installs the newer, breaking CLI.

## Consequences

- The release-producing job stays fully deterministic and pinned; only a deliberate, reviewed commit ever changes what "minimum supported" means.
- Drift against the current published CLI is caught within a week (or on demand) instead of silently, without ever gating a release or a PR on it.
- A `claude-code-compat.yml` failure is a triage signal for maintainers, not an automatic policy change.
