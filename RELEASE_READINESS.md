# KRYLO 0.1.1 Release-Readiness Report

Persistent implementation progress record. Every `done` entry cites evidence that was actually produced; nothing here is written ahead of execution.

Status legend: `done` (locally verified with evidence), `static` (statically inspected only), `ci-pending` (configured, awaiting GitHub-hosted execution on this branch), `open`.

## Repository reality (as of 2026-07-20)

- **Repository**: public — `https://github.com/FreeJaguar/KRYLO` (confirmed via the public GitHub API: `private: false`, `visibility: "public"`).
- **Default branch**: `main`, HEAD `c86c4fd2c8162df334efca56dabcba062169afd9` (last push `2026-07-20T08:12:34Z`, content = the `0.1.0` release).
- **This hardening work**: branch `hardening/v0.1.1`, based on `main` at the same commit. Not yet pushed; exists only as local commits in this working copy.
- **Tags / GitHub Releases**: none exist yet (confirmed via the GitHub API: zero tags, empty releases list).
- **Marketplace publication**: this repository IS the marketplace (`.claude-plugin/marketplace.json` at the repo root, self-hosted); it has not been submitted to or listed in any third-party/official Claude Code marketplace index.
- **CI status on `main` @ `c86c4fd` (the `0.1.0` content currently public)**: all 9 configured workflows green — `test`, `validate-plugin`, `codeql`, `semgrep`, `dependency-security`, `secret-scan`, `actions-security`, `sbom`, plus Dependabot's own update workflow — verified via the GitHub Actions API (`conclusion: "success"` for each, at `c86c4fd`). The `release` workflow has never run (manual `workflow_dispatch` only; correct, since no release has been cut).
- **`hardening/v0.1.1` CI status**: not yet available — GitHub-hosted CI only runs once this branch is pushed. Every check below was run locally.

## Environment (preflight evidence)

- OS: Windows 11, x86_64. Target support: Windows, macOS, Linux (macOS not exercised by a local runner; see Known limitations).
- Git, Node v24.17.0, npm. The globally-installed Claude Code CLI in this environment (`claude`, on PATH) is `2.1.197` -- `claude plugin validate --strict` throughout this document was run against that installed version. The pinned minimum-supported floor is `2.1.223` (native-permission-approval security-hardening checkpoint; see `docs/adr/0022-claude-code-compatibility-policy.md` and `docs/adr/0025-native-permission-approval.md`).
- **`2.1.223` is not published on the npm registry** (confirmed live: `npm view @anthropic-ai/claude-code@2.1.223` returns HTTP 404; every npm dist-tag, including `latest`, resolves to `2.1.197`) even though it is a genuine, checksummed upstream GitHub release (published 2026-08-06). During the final verification checkpoint, an isolated `2.1.223` binary was downloaded directly from GitHub Releases, its published SHA-256 verified, and used to interactively exercise the real native `permissionDecision:"ask"` flow end-to-end against this repository's actual `risk-gate.mjs` (see ADR-0025's verification log for the full transcript of results) -- without replacing or otherwise touching the globally-installed `2.1.197`. `.github/workflows/validate-plugin.yml` and `release.yml` now install the pinned floor the same way (checksum-verified GitHub binary), since the npm-based install they previously specified would 404.

## Current release: what changed since 0.1.0

Full detail in `CHANGELOG.md` under `[0.1.1]`. Summary: MCP/external-tool write protection in the risk gate; scoped single-use expiring risk approvals; per-project-per-session concurrent-run support; hooks scoped to the `run` skill so ordinary sessions launch zero KRYLO hook processes; a separate current-Claude-Code-CLI compatibility CI check; Orbit-cap semantics made consistent everywhere; the committed local Claude Code runtime lock file removed and guarded against regression; repository-quality documentation (badges, known limitations, roadmap, rollback docs, security-sensitive-contribution guidance).

## Validation matrix (this branch, local)

| Check | Command | Status | Result |
|---|---|---|---|
| Full test suite | `npm test` | done | **177 pass, 0 fail, 0 skipped** |
| Node syntax | `npm run syntax` | done | 28/28 scripts pass |
| Runtime self-validation | `npm run validate:runtime` | done | `ok:true` (syntax + schema consistency + runtime smoke) |
| Plugin manifest strict | `claude plugin validate --strict plugins/krylo` | done | pass, exit 0 |
| Marketplace manifest strict | `claude plugin validate --strict .` | done | pass, exit 0 |
| Isolated marketplace lifecycle | temp `CLAUDE_CONFIG_DIR`: `marketplace add` (local path) → `install` → `details` → `update` → `uninstall` | done | all exit 0; component inventory: 5 skills, 12 agents, **0 plugin-wide hooks** (all six now scoped to the `run` skill's own frontmatter — live-CLI confirmation of the item-4 hook-scoping design, not just static inspection), 0 MCP servers; always-on token cost ~696 (down from ~940 in 0.1.0, reflecting the removed plugin-wide hooks) |
| Repo hygiene | `tests/governance/repo-hygiene.test.mjs` | done | no Claude Code local-runtime/lock/session file tracked by git; `.gitignore` declares the patterns |
| MCP gate fixtures | `tests/security/mcp-classifier.test.mjs`, `tests/hooks/risk-gate-mcp.test.mjs` | done | malicious/benign/read-only/unknown-server/approved-write fixtures pass, including regression fixtures for two bypasses found and fixed during review (below) |
| Approval scoping fixtures | `tests/hooks/risk-gate-approvals.test.mjs` | done | exact-match, different-target, modified-command, expired, reused, concurrent-consumption, wrong-project, wrong-run, wrong-environment all pass |
| Concurrency fixtures | `tests/platform/concurrency.test.mjs` | done | two projects, two sessions in one project, one run finishing while another is active, concurrent init, stale-pointer cleanup, corrupted-pointer recovery, legacy-pointer migration, Windows/POSIX path equivalence, and a 12-way concurrent-mutation lock-race regression all pass |
| Hook-scoping wiring | `tests/governance/hook-scoping.test.mjs` | done | `hooks/hooks.json` registers nothing; the `run` skill's frontmatter declares all six required events against real scripts; no other skill declares an interception hook |
| Orbit-cap consistency | `tests/governance/policy-consistency.test.mjs`, `tests/unit/cli.test.mjs` | done | plugin.json/risk-policy.md/orbit-policy.md agree on low=3/medium=5/high=7 + cap semantics; `doctor.mjs` reports the real configured cap; functional cap-clamping test (cap can only lower a run's budget, never raise it) passes |
| Live doctor/status/run smoke | `/krylo:doctor`, `/krylo:status`, `/krylo:run` via `--plugin-dir` | not re-run this cycle | requires an authenticated Claude Code session, unavailable in this non-interactive isolated-config environment; the same code paths are covered by the automated fixture suite above (doctor, alias, statusline tests) plus the real isolated install/uninstall lifecycle |
| Data hygiene | inspect `~/.claude/plugins/data/krylo` | done | isolated `CLAUDE_PLUGIN_DATA`/`KRYLO_TEST_HOME` used for every test and lifecycle check; no stray writes to real user data |
| Action pinning | inspection of `.github/workflows/*.yml` | done | all `uses:` references pinned to full 40-hex commit SHAs, including the new `claude-code-compat.yml` |

## Independent review and fix loop (this hardening pass)

Two independent reviewers (fresh context, no access to each other's or the implementer's conclusions), each given the goal, acceptance criteria, base SHA `c86c4fd`, the actual working-tree diff, and prior test evidence.

**Reviewer (krylo:reviewer, correctness/regressions):** confirmed the concurrency, approval-scoping, and hook-scoping designs sound. One MEDIUM finding: `doctor.mjs`'s hook-health check read the now-intentionally-empty `hooks/hooks.json` and so could never detect a broken install — fixed to read the `run` skill's frontmatter instead. Several LOW notes accepted or fixed alongside the security review below.

**Reviewer (krylo:security-reviewer):** two HIGH findings in the new MCP classifier (`scripts/security/mcp-classifier.mjs`): (1) `writeVerbPattern` required a `_`/`-` delimiter around the verb, so camelCase operation names (`mergePullRequest`, `createRefund`, a common MCP naming convention) bypassed gating entirely; (2) server-name recognition used bidirectional substring matching, so an attacker-chosen server name merely containing a short catalog id (`digitalocean` contains `git`) or prefixed with a real one (`context7-writer`) inherited that server's trust and bypassed gating for every operation. Both fixed: operation names are now delimited at camelCase boundaries before verb matching; server recognition now requires exact (or `-mcp`/`-cli`-stripped) equality to a catalog id.

**Cross-cutting finding surfaced while fixing the above:** `update-state.mjs` mutated run state without the same per-run file lock the risk gate holds while consuming an approval, so a concurrent mutation could race an approval consumption and lose an update. Fixing this (wrapping `update-state.mjs`'s load-modify-save in the shared lock) exposed a genuine pre-existing TOCTOU race in `scripts/lib/paths.mjs`'s path-resolution helper — a separate `existsSync` check followed by `realpathSync` let a concurrent process delete the file being checked in between, crashing with ENOENT/EPERM on Windows under load. Fixed by collapsing to a single `try/catch` around `realpathSync` (one syscall, no window).

**Verification pass:** both reviewers re-read the fixed code and independently re-ran `npm test` themselves (177 pass, 0 fail) rather than trusting the implementer's report. Both confirmed every finding resolved. The security reviewer's adversarial re-probing surfaced one additional LOW finding (a bare `git` MCP server, catalog-known but matching no `serverActionClasses` rule, passed through ungated for push/force/reset/merge) — fixed with a dedicated `git` rule and a regression test, and reconfirmed by a final `npm test` run (177 pass, 0 fail).

No unresolved Critical, High, or valid Medium finding remains open.

## Deviations from blueprint / prior release (each covered by an ADR)

- ADR-0016: no plugin `settings.json` with `subagentStatusLine`. Originally deferred because the CLI floor (2.1.197) was below the 2.1.207 requirement; the floor is now 2.1.223 (≥ 2.1.207, see ADR-0022's amendment), so this deferral's original reason no longer holds. `subagentStatusLine` itself was not implemented in this checkpoint (out of scope) — tracked as a follow-up, not yet done.
- ADR-0025: native, host-controlled permission approval replaces the KRYLO-APPROVE chat-phrase mechanism (ADR-0024, superseded), only when `permission_mode` is in the live-verified allowlist (`auto`, `manual`, `default` -- not merely "outside `bypassPermissions`"); raised the CLI floor to 2.1.223 (2.1.211 confirms the core fix; 2.1.223 additionally closes a related Bash permission-check bypass). ADR-0027 restores native ask to every require-approval class (not just `git-push`/`git-force`) and to PowerShell/MCP (not just Bash), once official documentation confirmed the underlying mechanism applies to every PreToolUse tool; a malformed/unrecognized/blocked MCP server stays a hard `deny` regardless. Sensitive-path protection (`.env`, keys, credential stores) now also covers Read/Glob/Grep, not just Bash/Write.
- ADR-0026: PowerShell risk-classification parity with Bash (data-root, Hook-entrypoint, sensitive-path, oversized-command, and policy-class checks, including alias-/abbreviation-tolerant destructive-delete matching). ADR-0026's original "PowerShell keeps the `deny` fail-safe pending official `ask` confirmation" gating-outcome decision is superseded by ADR-0027: PowerShell now shares Bash's native `ask` path for every require-approval class.
- ADR-0017: hand-written structural state validator (zero dependencies), cross-checked against the JSON Schemas by `validate-runtime.mjs`. Unchanged.
- ADR-0018: MCP and external-tool write protection (item 2).
- ADR-0019: scoped, single-use, expiring risk approvals (item 3).
- ADR-0020: concurrent-run support via per-project-per-session pointers (item 5).
- ADR-0021: hook-scoping to the `run` skill (item 4), verified against the official Claude Code hooks documentation before implementation.
- ADR-0022: Claude Code compatibility policy — pinned floor plus a separate, never-release-blocking current-version check (item 7).

## Known limitations

See `README.md`'s "Known limitations" section (kept in sync with this document): MCP classification is name/pattern-based, not semantic; risk-approval TTL is a fixed 15 minutes; `subagentStatusLine` remains deferred; hook-scoping relies on documented (and now live-CLI-confirmed) Claude Code skill-frontmatter behavior; no macOS CI runner.

## Release items requiring GitHub-hosted execution or approval

- Pushing `hardening/v0.1.1` (or merging it to `main`) and observing all 9 workflows (plus the new `claude-code-compat.yml`, on its own schedule) run against the real content of this branch — not done in this pass; requires explicit approval per the task's safety boundaries.
- Creating a `v0.1.1` git tag and GitHub Release — not done; requires explicit approval.
- Marketplace/official-listing submission — not done; requires explicit approval.

## Prohibited actions confirmed absent

No push, no merge, no tag, no GitHub Release, no marketplace publication, no deployment, no production change, no `git reset --hard`, no stash or discard of unrelated work, no global CLI update, no real user-settings mutation (isolated `CLAUDE_CONFIG_DIR`/`KRYLO_TEST_HOME`/`CLAUDE_PLUGIN_DATA` used for every install, lifecycle, and alias check in this pass).
