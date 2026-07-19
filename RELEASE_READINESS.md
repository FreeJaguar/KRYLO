# KRYLO 0.1.0 Release-Readiness Report

Persistent implementation progress record. Every `done` entry cites evidence that was actually produced; nothing here is written ahead of execution.

Status legend: `done` (locally verified with evidence), `static` (statically inspected only), `ci-pending` (configured, awaiting GitHub-hosted execution), `open`.

## Environment (preflight evidence)

- OS: Windows 11 (MINGW64), x86_64. Target support: Windows, macOS, Linux.
- Git 2.54.0.windows.1, Node v24.17.0, npm 11.5.2, Claude Code 2.1.197.
- Blueprint integrity: `BLUEPRINT_MANIFEST.json` verified 2026-07-19 — 108/108 files, all sizes and SHA-256 hashes match. The original blueprint is preserved in the baseline commit (b6818a5); post-baseline documentation updates (README, CHANGELOG, CLAUDE.md, FILE_MANIFEST) are implementation-reality updates required by Milestone 10.
- Git repository initialized locally (`main`). No remote configured. No push occurred.

## Verified platform contracts

- `claude plugin validate <path> [--strict]`, `claude plugin marketplace add <local path>`, `claude plugin install|update|uninstall <plugin>@<marketplace>`, `--plugin-dir` all verified working locally.
- Official schema check (docs fetched 2026-07-19): `plugin.json` supports `userConfig`; `${CLAUDE_PLUGIN_DATA}` is the supported persistent data directory; hook events used: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`; PreToolUse decisions via `hookSpecificOutput.permissionDecision`; Stop blocking via `decision: "block"` + `reason`.
- Plugin `settings.json` supports only `agent` and `subagentStatusLine`; `subagentStatusLine` documented as v2.1.207+ while local CLI is 2.1.197 → ADR-0016 defers the settings key; the renderer ships and is offered through setup.

## Milestones

| # | Milestone | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Repository and marketplace skeleton | done | `claude plugin validate --strict` passes for plugin and marketplace (exit 0); isolated-config marketplace add + install succeeded; `plugin details` shows 5 skills, 12 agents, 6 hook events; installed copy contains 0 `CLAUDE.md` files; root `CLAUDE.md` = 113 lines (≤130). |
| 2 | Core skill and state model | done | 53 unit/platform tests (state, redaction, atomic writes, telemetry whitelist, cleanup/retention, CLI, resume-after-restart); secret-bearing goal never persisted; corrupted state preserved as `state.corrupt-*` with recovery; `validate-runtime.mjs` full mode passes incl. schema/validator consistency. |
| 3 | Agent system | done | 12 agents discovered by `plugin details`; structural tests: only Builder holds Write/Edit, portable aliases only, no unsupported frontmatter; reviewer flow receives diff+evidence per run skill; agent-result schema shipped. |
| 4 | Orbit loop | done | stop-gate fixture tests: block-with-delta, budget consumption per block, exhaustion → ITERATION_LIMIT_REACHED with pointer cleared, stagnation → SAFE_BLOCKED, `stop_hook_active` respected, bounded-loop proof (blocks ≤ budget); fingerprint repeat → requiredStrategyChange; six terminal states in schema and gate. |
| 5 | Question and risk gates | done | Fixture tests: routine AskUserQuestion denied; granted exceptional token allowed exactly once then denied; budget refusal; git push/force, npm publish, gh release, terraform apply, kubectl delete, DROP TABLE, supabase db reset, git reset --hard, gh pr merge, gh secret set all denied pending approval; sensitive paths (.env, id_rsa, secrets.yaml) denied incl. token-level Bash matching; approved override allows only its class; no-active-run pass-through (ADR-0009); injection fixtures never executed and never echoed. |
| 6 | Observability | done | statusline tests: renders from state only, resolved model only when present, minimal/detailed modes, truncation, secret-bearing labels redacted, empty when no run; agent-events start/stop capture with whitelist extraction (canary fields never persisted); wrapper preserves original status line and degrades gracefully. |
| 7 | Tool governance and adapters | done | Catalog/policy consistency tests; audit-tool tests: malicious fixture → critical findings + refuse verdict + canary never executed; benign unlisted → unreviewed-no-automatic-use; version drift → not auto-trusted; blocked version → refuse; KRYLO Core runs with zero adapters (fixture run used none). |
| 8 | Setup, doctor, and alias | done | doctor healthy-path exit 0 with correct inventory and read-only guarantee (directory snapshot identical); unwritable storage → exit 1 with remediation; foreign alias reported; alias dry-run changes nothing; apply installs marked wrapper; re-apply backs up; foreign skill refused in all modes; remove restricted to krylo-owned files; --restore-backup roundtrip verified. |
| 9 | Test and evaluation suite | done (local) / ci-pending (hosted) | Full suite `node --test`: **120 pass, 0 fail, 0 skipped** on Windows/node 24; syntax check 25/25 scripts; evals.json (12 scenarios) validated against state enums; 9 CI workflows with all actions pinned to full commit SHAs (verified by local pin-check) and least-privilege permissions; Linux/matrix execution awaits GitHub. |
| 10 | Release and public pilot preparation | done (local) | RELEASE_MANIFEST.json generated with per-file SHA-256; isolated-config install/update/uninstall/reinstall cycle verified; smoke tests via `--plugin-dir`: `/krylo:doctor` (exit 0), `/krylo:status` (renders fixture state exactly), `/krylo:run` read-only fixture ended VERIFIED_COMPLETE through the completion gate (2 criteria proven with passing evidence, 0 questions, 0 cycles, no file modified, no subagents); publication steps remain approval-gated and were not executed. |

## Local validation matrix

| Check | Command | Status | Result |
|---|---|---|---|
| Blueprint integrity | node SHA-256 verification | done | 108/108 match |
| Plugin manifest strict | `claude plugin validate --strict plugins/krylo` | done | pass, exit 0 |
| Marketplace manifest strict | `claude plugin validate --strict .` | done | pass, exit 0 |
| Node syntax | `npm run syntax` | done | 25/25 scripts pass |
| Runtime self-validation | `npm run validate:runtime` | done | ok:true (syntax + schema consistency + runtime smoke), exit 0 |
| Full test suite | `node --test "plugins/krylo/tests/**/*.test.mjs"` | done | 120 pass, 0 fail, 0 skipped |
| Local plugin load | `claude --plugin-dir plugins/krylo -p` | done | skills resolve and execute (doctor, status, run) |
| Isolated marketplace lifecycle | temp `CLAUDE_CONFIG_DIR`: add, install, update, uninstall, reinstall | done | all exit 0; 5 skills + 12 agents + 6 hook events discovered |
| Doctor smoke | `/krylo:doctor` via --plugin-dir | done | exit 0, read-only report |
| Status smoke | `/krylo:status` via --plugin-dir | done | renders fixture run state (AC-1 pending, budget 3, phase INITIALIZING) |
| Run fixture (read-only) | `/krylo:run` audit fixture via --plugin-dir | done | terminal VERIFIED_COMPLETE via completion gate; no writes; no subagents |
| Alias dry-run/rollback | isolated `KRYLO_TEST_HOME` tests | done | 6/6 alias tests pass |
| Data hygiene | inspect `~/.claude/plugins/data/krylo` | done | does not exist — no stray writes to real user data |
| Action pinning | local pin-check grep | done | all `uses:` references pinned to full 40-hex SHAs |

Note: an interim commit message stated "126 pass"; the correct verified count at that point was 120 (a governance-only run of 16 tests overlapped 6 already-counted audit tests). The authoritative numbers are in this table.

## Deviations from blueprint (each covered by an ADR)

- ADR-0016: no plugin `settings.json` with `subagentStatusLine` in 0.1.0 (CLI floor 2.1.197 < 2.1.207). Renderer ships; setup offers a user-level wrapper with dry run + backup.
- ADR-0017: hand-written structural state validator (zero dependencies); tests and validate-runtime cross-check it against the JSON Schemas.
- `plugins/krylo/monitors/monitors.json` not shipped: optional per blueprint, "should not require a monitor" (docs/07). No monitor was needed.
- Additional runtime files beyond FILE_MANIFEST's plan: `scripts/lib/*` (paths, atomic, redact, state, telemetry, hook-utils), `scripts/runtime/posttool-telemetry.mjs`, `scripts/status/agent-events.mjs` — implementation reality, documented in FILE_MANIFEST.md.

## Release items requiring GitHub-hosted execution or approval

- GitHub-hosted CI runs (all 9 workflows `ci-pending`): validate-plugin, test (ubuntu+windows × node 20/24), codeql, semgrep, dependency-security (OSV + dependency-review), secret-scan (TruffleHog), actions-security (zizmor + pin-check), sbom (Syft), release (manual dispatch, draft release + attestation).
- CODEOWNERS `@OWNER` placeholders must be replaced with the real account/team before first push.
- Repository creation, first push, GitHub release, marketplace publication: require explicit user approval. Exact command sequence is in the final report.
- macOS execution: covered by portable code and POSIX path tests; no macOS runner exercised locally.

## Prohibited actions confirmed absent

No remote created, no push, no release, no publication, no deployment, no production change, no `git reset --hard`, no stash of user work, no global CLI update, no user-settings mutation (isolated `CLAUDE_CONFIG_DIR`/`KRYLO_TEST_HOME`/`CLAUDE_PLUGIN_DATA` used for all install and alias tests).
