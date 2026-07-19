# KRYLO 0.1.0 Release-Readiness Report

Persistent implementation progress record. Survives context compaction. Updated at every milestone boundary. Every `done` entry must cite evidence that was actually produced; nothing here may be written ahead of execution.

Status legend: `done` (locally verified with evidence), `static` (statically inspected only), `ci-pending` (configured, awaiting GitHub-hosted execution), `in-progress`, `open`.

## Environment (preflight evidence)

- OS: Windows 11 (MINGW64), x86_64. Target support: Windows, macOS, Linux.
- Git 2.54.0.windows.1, Node v24.17.0, npm 11.5.2, Claude Code 2.1.197.
- Blueprint integrity: `BLUEPRINT_MANIFEST.json` verified 2026-07-19 — 108/108 files, all sizes and SHA-256 hashes match.
- Git repository initialized locally (`main`), blueprint committed as baseline (b6818a5). No remote configured. No push will occur.

## Verified platform contracts

- `claude plugin validate <path> [--strict]` available.
- `claude plugin marketplace add <local path>` and `claude plugin install <plugin>@<marketplace>` available.
- `--plugin-dir <path>` session-local plugin loading available.
- Official schema check (docs fetched 2026-07-19): `plugin.json` supports `userConfig`; `${CLAUDE_PLUGIN_DATA}` is the supported persistent data directory (`~/.claude/plugins/data/<plugin>/`); hook events include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `Stop`; PreToolUse decisions use `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`); Stop hooks use top-level `decision: "block"` + `reason`.
- Plugin `settings.json` supports only `agent` and `subagentStatusLine`; `subagentStatusLine` is documented as v2.1.207+ while the local CLI is 2.1.197 — see Deviations.

## Milestones

| # | Milestone | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Repository and marketplace skeleton | done | `claude plugin validate --strict plugins/krylo` → pass (exit 0); `claude plugin validate --strict .` → pass (exit 0); isolated `CLAUDE_CONFIG_DIR` marketplace add + `plugin install krylo@krylo-marketplace` → success; `plugin details` shows 5 skills + 12 agents; installed copy contains 0 `CLAUDE.md` files; root `CLAUDE.md` = 112 lines (≤130). |
| 2 | Core skill and state model | open | |
| 3 | Agent system | open | |
| 4 | Orbit loop | open | |
| 5 | Question and risk gates | open | |
| 6 | Observability | open | |
| 7 | Tool governance and adapters | open | |
| 8 | Setup, doctor, alias | open | |
| 9 | Test and evaluation suite | open | |
| 10 | Release and public pilot preparation | open | |

## Local validation matrix

| Check | Command | Status | Result |
|---|---|---|---|
| Blueprint integrity | node SHA-256 verification | done | 108/108 match |
| Plugin manifest strict | `claude plugin validate --strict plugins/krylo` | done | pass, exit 0 |
| Marketplace manifest strict | `claude plugin validate --strict .` | done | pass, exit 0 |
| Node syntax | `npm run syntax` | open | |
| Unit tests | `npm run test:unit` | open | |
| Hook fixture tests | `npm run test:hooks` | open | |
| Security tests | `npm run test:security` | open | |
| Cross-platform path tests | `npm run test:platform` | open | |
| Integration tests | `npm run test:integration` | open | |
| Full suite | `npm test` | open | |
| Local plugin load | `claude --plugin-dir` | open | |
| Isolated marketplace install | temp config add/install | open | |
| Doctor smoke | `/krylo:doctor` fixture | open | |
| Status smoke | `/krylo:status` fixture | open | |
| Run fixture (read-only) | `/krylo:run` harmless fixture | open | |
| Alias dry-run/rollback | isolated HOME | open | |

## Deviations from blueprint

- (pending ADR) `plugins/krylo/settings.json` with `subagentStatusLine`: the installed CLI (2.1.197) predates documented support (2.1.207+). Decision and ADR to be recorded before Milestone 6.

## Release items that require GitHub-hosted execution or approval (not claimable locally)

- GitHub-hosted CI runs (all workflows will be `ci-pending` until first push).
- CodeQL, Semgrep, OSV, TruffleHog, zizmor, SBOM hosted results.
- Repository creation, first push, GitHub release, marketplace publication: require explicit user approval.
- Release attestation (requires GitHub Actions).

## Prohibited actions confirmed absent so far

No remote created, no push, no release, no publication, no deployment, no production change, no `git reset --hard`, no stash of user work, no global CLI update, no user-settings mutation.
