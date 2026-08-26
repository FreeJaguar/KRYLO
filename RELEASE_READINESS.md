# KRYLO 0.2.0 Release-Readiness Report

Persistent implementation progress record. Every status below cites evidence that was actually produced; nothing here is written ahead of execution.

Status legend: `locally passed` (executed and verified in this environment), `statically inspected` (read/analyzed, not executed), `configured but not run` (a check/tool exists and is wired correctly but did not actually execute here), `environment-blocked` (requires something this environment cannot provide, e.g. an authenticated live host session), `GitHub-hosted CI pending` (this branch has not been pushed; the workflow has not run remotely), `external publication not performed` (deliberately, per this checkpoint's own hard-stop boundary).

## Repository reality (verified at release-preparation time, 2026-08-26)

- **Repository**: public — `https://github.com/FreeJaguar/KRYLO` (confirmed via the public GitHub API: `visibility: "PUBLIC"`, default branch `main`).
- **Public `main` HEAD**: `be76b9ff8302c428598e97f7e289734d08340fd1`. **Public product version remains `0.1.1`** (confirmed by fetching `plugins/krylo/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` directly from `main` via the GitHub API — both report `0.1.1`) — verified before preparing 0.2.0, per this checkpoint's own explicit requirement.
- **Tags / GitHub Releases**: exactly one, `krylo--v0.1.1` (confirmed via the GitHub API tags/releases endpoints) — matches the public version above.
- **Remote branches**: `main`, `hardening/v0.1.1`, `feat/optional-external-capability-adapters`, `fix/release-workflow-tag-format`, `dependabot/github_actions/actions-0cbd97c70a`. **`feat/multi-host-0.2` (this branch) does not exist on the remote** — confirmed via the GitHub API branch list. This entire 0.2.0 line of work exists only as local commits in this working copy, exactly as the task's own hard-stop boundary requires.
- **Open PRs**: one, `#8` (`dependabot/github_actions/actions-0cbd97c70a`, an unrelated GitHub Actions version-bump PR). No existing release PR for 0.2.0.
- **Marketplace publication**: this repository IS the marketplace (`.claude-plugin/marketplace.json` at the repo root, self-hosted); not submitted to or listed in any third-party/official Claude Code marketplace index. Not changed by this checkpoint.
- **Codex distribution**: no `codex plugin` CLI management subcommand exists on the tested Codex build; KRYLO's Codex host has never been published through any Codex-native distribution mechanism, and this checkpoint does not create one (README.md documents the real, current install path via `install-codex.mjs`).

## Environment (preflight evidence)

- OS: Windows 11, x86_64. Target support: Windows, macOS, Linux (macOS not exercised by a local runner — see Known limitations).
- Node `v24.17.0`, Git, npm (zero runtime dependencies; `npm audit` clean).
- **Claude Code CLI installed in this environment**: `2.1.197`. **Pinned minimum-supported floor**: `2.1.223` (`docs/adr/0022-claude-code-compatibility-policy.md`) — every `claude plugin validate --strict` and live-lifecycle check in this document was run against the locally installed `2.1.197`, below the floor; this is a disclosed, pre-existing gap (npm has not published past `2.1.197`; the floor itself was live-verified against a real, checksum-downloaded `2.1.223` GitHub-release binary during the 0.1.1 hardening pass — see ADR-0022's own "Critical discovery" section for the full account). This checkpoint did not re-download the pinned binary; `.github/workflows/validate-plugin.yml`/`release.yml` continue to install it fresh, checksum-verified, on every real CI run.
- **Codex CLI installed in this environment**: `codex-cli 0.120.0` — the version KRYLO's Codex host is verified/tested against; no formal minimum floor exists yet (Codex host is implemented, not yet published).
- Ecosystem Maintenance's own live check (re-run during this release-prep pass) confirms both facts above are still current, and additionally shows two non-blocking, already-investigated informational signals: a newer Claude Code release (`v2.1.246`) and a newer Codex release (`0.149.1`) exist upstream. Per Section 6's explicit instruction not to raise a provider floor solely because a newer version exists, and since neither newer release has been found to affect a contract KRYLO relies on, **neither floor is changed in this checkpoint**.

## What 0.2.0 represents

Full detail in `CHANGELOG.md` under `[0.2.0]`. KRYLO becomes a genuine multi-host product: one Shared Core, the released Claude Code host, and a shipped-but-not-yet-published Codex CLI host, plus two new optional capabilities built on the same Core:

- **Shared Core / multi-host foundation** (`docs/adr/0023-multi-host-product-and-shared-core.md`): one host-neutral run state, Orbit loop, risk policy, and completion contract; host adapters normalize host-specific identity/payloads into it.
- **Claude Code host** (released): `/krylo:run <task>`, native `permissionDecision: "ask"` approval for every `require-approval` class (ADR-0025/0027), hooks scoped to the `run` skill so an ordinary session launches zero KRYLO hook processes (ADR-0021).
- **Codex CLI host** (implemented, shipped, not yet published): `$krylo-run <task>`, explicit-invocation-only, `require-approval` denies deterministically (no verified native `ask` mechanism on the tested build), host-authoritative session binding at `UserPromptSubmit` (ADR-0029).
- **Cross-Harness v1** (optional, ADR-0030): a run may request one bounded, read-only, advisory review from the *opposite* provider's own CLI. Depth-1, code-enforced; native host remains sole writer; a worker's findings are evidence only.
- **Ecosystem Maintenance v1** (optional, scheduled, ADR-0031): a read-only, official-source-only checker detects drift in KRYLO's own pinned provider versions, GitHub Action pins, and internal version references. Detection only, never automatic remediation.
- Security hardening completed across the 0.2 development line: native-approval restoration to every class (ADR-0027), PowerShell parity (ADR-0026), Foundation final-closure fixes (ADR-0028), a confirmed-and-closed Windows command-injection vulnerability in Cross-Harness's process-spawning layer, and the review-round fixes recorded in each component ADR.

Windows/macOS/Linux remain the supported OS contract; macOS is not exercised by a local CI runner (see Known limitations, both here and in README.md).

## Version consistency (task Section 5)

All five authoritative product-version sources agree on `0.2.0` — verified live via `plugins/krylo/scripts/maintenance/checks/internal-drift.mjs`'s `product-version-agreement` check (status `ok`) and independently via two dedicated regression tests (`plugins/krylo/tests/governance/product-version-consistency.test.mjs`):

| Source | Value |
|---|---|
| `package.json` / `package-lock.json` | `0.2.0` |
| `plugins/krylo/.claude-plugin/plugin.json` | `0.2.0` |
| `plugins/krylo/.codex-plugin/plugin.json` | `0.2.0` |
| `.claude-plugin/marketplace.json` (`plugins[0].version`) | `0.2.0` |
| `CHANGELOG.md` (latest released heading) | `[0.2.0] - 2026-08-26` |

Two additional current-version stamps embedded in generated user-facing artifacts (`install-alias.mjs`'s `ALIAS_VERSION`, `install-codex.mjs`'s `RULES_VERSION`) were found still hardcoded to `0.1.1` by a full-suite test failure during this checkpoint and fixed — both are now `0.2.0`, confirmed by `doctor.test.mjs`/`alias.test.mjs`. Historical version references (legacy pre-0.1.1 data-root migration comments in `paths.mjs`/`state.mjs`, ADR statements describing when a past decision was made, `state-migrations.test.mjs`'s deliberate `kryloVersion: '0.1.1'` fixtures testing migration *from* that real historical version) were correctly left untouched.

## RELEASE_MANIFEST.json (task Section 7/22)

Regenerated with a rewritten, deterministic generator (`plugins/krylo/scripts/release/generate-release-manifest.mjs`): source of truth is `git ls-tree -r HEAD` (never the working tree, never a hand-maintained list), content hashed via a single `git cat-file --batch` call (SHA-256 per file, from the committed git blob, not the working-tree file).

- **File count**: 343 git-tracked files (excluding the manifest itself).
- **Independent verification**: `plugins/krylo/scripts/release/verify-release-manifest.mjs` — `{"ok":true,"errors":[],"fileCount":343}`. Every entry's hash was independently recomputed and compared (not merely re-read); every git-tracked file was confirmed present in the manifest; every manifest entry was confirmed to correspond to a real git-tracked file.
- **Determinism**: regenerated twice from the same, unchanged HEAD — byte-for-byte identical output both times (`diff` clean, matching SHA-256 of the manifest file itself both times). Task Section 22's exact requirement.
- **No checkpoint/review artifact included**: `prompt.md`, every `*.patch`/`*-status.txt`/`*-commits.txt` file present in this working copy are all untracked (confirmed via `git ls-files` containing none of them) and therefore structurally cannot appear in a manifest sourced from `git ls-tree` — proven by a dedicated regression test (`release-manifest.test.mjs`), not merely asserted.
- **Tooling test coverage**: `plugins/krylo/tests/governance/release-manifest.test.mjs` (8 tests) — determinism, hash/byte-count well-formedness, checkpoint-artifact exclusion, internal consistency, real-manifest verification, and three tamper-detection tests (a corrupted hash, a missing file, an extra untracked-file entry are all caught).

## Validation matrix (this branch, local, final HEAD)

| Check | Command | Status | Result |
|---|---|---|---|
| Full test suite | `npm test` | locally passed | **629 tests total, 628 pass, 0 fail, 1 expected skip** (a POSIX-only `spawn-platform` test correctly skipped on this Windows environment) |
| Node syntax | `npm run syntax` | locally passed | all scripts pass (`{"ok":true}`) |
| Runtime self-validation | `npm run validate:runtime` | locally passed | `{"ok":true}` (syntax + schema consistency + host isolation + runtime smoke) |
| Claude plugin manifest strict | `claude plugin validate --strict plugins/krylo` | locally passed | pass, exit 0 |
| Claude marketplace manifest strict | `claude plugin validate --strict .` | locally passed | pass, exit 0 |
| Codex packaging | `codex execpolicy check` against generated rules; plugin/skill/hook schema shape | locally passed | `plugins/krylo/tests/setup/install-codex.test.mjs`'s real-binary test passes; no `codex plugin` strict validator exists on the tested build (statically inspected instead, per task's own "do not invent a validation command" instruction) |
| Release-manifest generation + verification | `generate-release-manifest.mjs` + `verify-release-manifest.mjs` | locally passed | 343 files, 0 errors, deterministic (see above) |
| Release-tag contract | `plugins/krylo/tests/governance/release-tag-contract.test.mjs` | locally passed | the REAL shell script extracted from `release.yml`'s tag-check step, executed against real mismatch cases: `v0.2.0`/current package → pass; `v0.2.1`, `v0.1.1`, wrong-name-prefix → all correctly fail |
| Ecosystem Maintenance (offline) | `check-ecosystem.mjs --offline` | locally passed | all internal-consistency checks `ok`; every network-dependent check correctly `unavailable`, never a false pass |
| Ecosystem Maintenance (live) | `check-ecosystem.mjs` | locally passed | exit 0; all 25 pinned Action declarations (8 unique action/version pairs) resolve correctly; two genuine, non-blocking drift signals (Claude/Codex newer releases) at the correct info/medium severity |
| Cross-Harness regression | `tests/unit/cross-harness.test.mjs`, `tests/hooks/cross-harness-run.test.mjs`, `tests/security/cross-harness-process.test.mjs`, `tests/unit/spawn-platform.test.mjs` | locally passed | included in the full suite above; no regression |
| Claude Host regression | `tests/hooks/*.test.mjs`, `tests/governance/hook-scoping.test.mjs`, session-isolation, concurrency | locally passed | included in the full suite above; no regression |
| Codex Host regression | `tests/hooks/risk-gate-codex.test.mjs`, `user-prompt-submit-codex.test.mjs`, `install-codex.test.mjs` | locally passed | included in the full suite above; no regression |
| Entrypoint / opt-in guarantee | `tests/governance/agents.test.mjs`, `tests/governance/hook-scoping.test.mjs` | locally passed | `disable-model-invocation: true` (Claude) and `allow_implicit_invocation: false` (Codex) both verified on the `run`/`krylo-run` skills; no skill is model-invocable without explicit `/krylo:run` or `$krylo-run` |
| Isolated Claude clean-install lifecycle | temp `CLAUDE_CONFIG_DIR`: `marketplace add` (real 0.2.0 tree) → `install` → `list` → `update` → `uninstall` → `marketplace remove` | locally passed | all exit 0; component inventory 5 skills / 12 agents / 0 plugin-wide hooks / 0 MCP servers, always-on token cost ~696 (unchanged from 0.1.1's own baseline — no regression) |
| Isolated Claude upgrade (0.1.1 → 0.2.0) | real `krylo--v0.1.1` tag extracted via `git archive`, installed, then `marketplace update` + `plugin update` against the real 0.2.0 tree at the same path | locally passed | live confirmation: `"Plugin krylo updated from 0.1.1 to 0.2.0"`; an unrelated file placed in the isolated config directory survived every step |
| Isolated Claude uninstall / rollback | uninstall → verify unrelated data preserved → repeated uninstall (idempotency) → marketplace remove → re-install from the real `krylo--v0.1.1` tree | locally passed | uninstall clean; repeated uninstall fails safely with a clear error, no crash/corruption; rollback to the real 0.1.1 tree confirmed (`"KRYLO (krylo) 0.1.1"`) |
| Isolated Codex install/setup | `install-codex.mjs` (dry-run default, `--apply`) against isolated `KRYLO_TEST_HOME` | locally passed | dry-run changes nothing; apply installs the real Skill; idempotent re-apply auto-backs-up the prior KRYLO-owned install; a **foreign** (non-KRYLO) existing Skill is correctly refused and never overwritten (`error: "foreign-skill"`) |
| Live authenticated `/krylo:run`/`$krylo-run` smoke | — | environment-blocked | requires an authenticated interactive host session, unavailable in this non-interactive environment; covered instead by the automated fixture suite above plus the real isolated install/uninstall/upgrade lifecycle |
| Supply-chain: Actions pin format | `actions-security.yml`'s own pin-check invariant, cross-checked by `actions-pins-format` (Ecosystem Maintenance) | locally passed | all `uses:` references pinned to full 40-hex commit SHAs |
| Supply-chain: zizmor (workflow linting) | `actions-security.yml`'s `zizmor` job | configured but not run | `zizmor`/`pipx` not installed in this local environment; GitHub-hosted CI pending |
| Supply-chain: CodeQL / Semgrep / TruffleHog / OSV scan / SBOM | respective `.github/workflows/*.yml` | configured but not run | GitHub-hosted only; GitHub-hosted CI pending |
| GitHub-hosted CI (`test.yml`, `validate-plugin.yml`, etc.) | — | GitHub-hosted CI pending | this branch does not exist on the remote; not pushed during this checkpoint, per the hard-stop boundary |

## Security release review (task Section 14)

Focused on the release artifact and integration boundaries, not a re-audit of every historical finding already closed in each component's own ADR:

- **New surface this checkpoint introduces** (`plugins/krylo/scripts/release/*.mjs`): every subprocess call uses an argv array with `shell:false` (default), no user/task-derived content ever reaches argv (git ref names are fixed literals; blob content flows through stdin/stdout only) — directly inspected, no injection surface.
- **Local runtime files / scratch artifacts**: `git ls-files` grepped for secret/credential/state/telemetry/lock-shaped paths — zero matches beyond legitimate telemetry-*mechanism* source files (not leaked telemetry data) and the `secret-scan.yml` workflow name itself. `prompt.md`/`*.patch`/`*-status.txt`/`*-commits.txt` confirmed untracked.
- **`release.yml` permissions**: `verify` job `contents: read` only; `release` job (`contents: write`, `id-token: write`, `attestations: write`) is gated behind `needs: verify` and only ever runs on manual `workflow_dispatch` — never `push`/`pull_request` — confirmed both by direct reading and by `release-tag-contract.test.mjs`'s static assertions.
- **Cross-Harness data egress / worker write capability / environment leakage, Ecosystem Maintenance workflow permissions, approval authority/replay, session/run crossover, concurrent runs, command injection, PowerShell, `apply_patch`, path traversal, secret-path handling, KRYLO config weakening, telemetry leakage**: all covered by each component's own already-completed, independently-reviewed checkpoint (ADR-0025/0026/0027/0028/0029/0030/0031) and re-confirmed passing as part of the 628/629 full regression run above — not reopened, per this checkpoint's own explicit scope boundary.
- **No new Critical/High release blocker found.**

## Known limitations

See `README.md`'s "Known limitations" section (kept in sync): the Codex `require-approval` deterministic-deny asymmetry; the Codex host being shipped but not yet published through any native distribution mechanism; Cross-Harness being optional/advisory/depth-1 with the Codex-native→Claude-worker direction unable to obtain real human approval; Ecosystem Maintenance being detection-only; MCP classification being name/pattern-based; the fixed 15-minute risk-approval TTL; `subagentStatusLine` deferred; no macOS CI runner; GitHub-hosted CI pending until this branch is actually pushed.

## Independent review (task Section 29)

See "ביקורת עצמאית" in the final Hebrew report for this checkpoint for the outcome of the fresh Verifier/Reviewer/Security-Reviewer round dispatched against this exact final HEAD.

## Release items requiring GitHub-hosted execution or human approval

- Pushing `feat/multi-host-0.2` (or merging it to `main`) and observing every workflow run against the real content of this branch — not done in this pass; requires explicit approval.
- Creating the `v0.2.0` git tag and GitHub Release (draft, via `release.yml`'s manual `workflow_dispatch`) — not done; requires explicit approval. The tag-vs-version contract this workflow enforces is proven correct in isolation (see Validation matrix above), not exercised against a real dispatch.
- Marketplace/official-listing submission (Claude), and an equivalent Codex distribution step once the platform provides one — not done; requires explicit approval.

## Prohibited actions confirmed absent

No push, no remote branch/PR/merge, no tag, no GitHub Release, no marketplace/Codex-distribution publication, no deployment, no production change, no GitHub repository/branch-protection setting change, no release-asset upload, no npm package publication, no external message, no `git reset --hard`, no stash or discard of unrelated work, no global CLI update, no real user-settings mutation (isolated `CLAUDE_CONFIG_DIR`/`KRYLO_TEST_HOME`/`CLAUDE_PLUGIN_DATA` used for every install/upgrade/uninstall/rollback check in this pass; all test residue written into the real repository working tree during those checks was identified and removed before commit).

## Appendix: 0.1.1 hardening pass (historical, preserved for reference)

The following was this document's own primary content when it described the `0.1.1` release. Preserved verbatim as a historical record; superseded by the sections above for current 0.2.0 readiness.

### Validation matrix (0.1.1, `hardening/v0.1.1` branch, local)

| Check | Command | Status | Result |
|---|---|---|---|
| Full test suite | `npm test` | done | 177 pass, 0 fail, 0 skipped |
| Node syntax | `npm run syntax` | done | 28/28 scripts pass |
| Runtime self-validation | `npm run validate:runtime` | done | `ok:true` |
| Plugin manifest strict | `claude plugin validate --strict plugins/krylo` | done | pass, exit 0 |
| Marketplace manifest strict | `claude plugin validate --strict .` | done | pass, exit 0 |
| Isolated marketplace lifecycle | temp `CLAUDE_CONFIG_DIR` | done | 5 skills, 12 agents, 0 plugin-wide hooks, 0 MCP servers; always-on token cost ~696 |
| Action pinning | inspection of `.github/workflows/*.yml` | done | all `uses:` references pinned to full 40-hex commit SHAs |

### Independent review and fix loop (0.1.1 hardening pass)

Two independent reviewers found and fixed: a hook-health check reading the wrong (intentionally empty) file; two HIGH findings in the MCP classifier (camelCase verb-boundary bypass, bidirectional substring server-name matching); a concurrent-mutation race between `update-state.mjs` and the risk gate's approval consumption, which exposed a pre-existing TOCTOU race in `paths.mjs`'s path resolution; and one LOW finding (an ungated bare `git` MCP server). No unresolved Critical/High/valid-Medium finding remained open at 0.1.1's own closure.

### Deviations from blueprint (0.1.1, each covered by an ADR)

ADR-0016 (subagentStatusLine deferred), ADR-0025 (native permission approval replaces KRYLO-APPROVE), ADR-0026 (PowerShell risk parity), ADR-0017 (hand-written state validator), ADR-0018 (MCP/external-tool write protection), ADR-0019 (scoped single-use approvals), ADR-0020 (concurrent-run support), ADR-0021 (hook-scoping), ADR-0022 (Claude Code compatibility policy).
