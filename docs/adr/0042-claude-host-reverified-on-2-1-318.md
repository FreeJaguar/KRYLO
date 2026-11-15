# ADR-0042: Claude host re-verified live on Claude Code 2.1.318 -- hook lifetime, fail-closed gates, and a raised floor

## Status

Accepted

## Context

KRYLO's Claude-host safety claims were last proven live on the pinned `2.1.223` floor (ADR-0025, ADR-0027, ADR-0028). Between `2.1.224` and `2.1.322` upstream changed several things those proofs depended on, read from the official CHANGELOG and documentation on 2026-11-12:

- `2.1.284`: interactive terminal and VS Code sessions with no configured permission mode now start in **auto mode**, on every plan and provider (`2.1.283` did the same for third-party providers or telemetry off).
- `2.1.295`: command and HTTP hooks gained `onFailure: "block"` -- a hook that cannot start, times out, or exits with an unexpected code blocks the action instead of letting it through.
- `2.1.259`: frontmatter `model:` on skills and commands was previously ignored in interactive sessions; it now applies.
- Current documentation (code.claude.com/docs/en/hooks, "Hooks in skills and agents"; and the `hooks` row of the skills frontmatter reference) states that **skill hooks are registered when the skill is invoked and keep running for the rest of the session**, unless a hook sets `once: true`. Subagent hooks are still removed when the subagent finishes. No CHANGELOG line records when this became the documented behavior.

ADR-0021 placed every KRYLO hook in the run skill's frontmatter on the premise, documented at the time, that skill hooks "are automatically cleaned up once it finishes".

## Live verification (Claude Code 2.1.318, Windows 11 with Git Bash, 2026-11-12)

All runs used `claude -p` with `--setting-sources local` and `--strict-mcp-config` in a disposable repository, so no user or project settings or plugins loaded. The native-ask matrix wired the repository's own `risk-gate.mjs` through `--settings`, behind a logging wrapper that recorded the `permission_mode` the hook received and the decision it emitted, against an isolated `KRYLO_DATA_ROOT` and a run bound to a pre-chosen `--session-id`. The push target was a local bare repository, so a push that got through would have been observable and harmless.

### Native ask (ADR-0025/0027/0028), `git push origin main`

| Case | `permission_mode` in payload | Hook decision | Pushed |
|---|---|---|---|
| Negative control: no hook, `--allowedTools "Bash(git push *)"`, `manual` | -- | -- | **yes** |
| `--permission-mode auto` | `auto` | `ask` | no |
| no `--permission-mode` flag | `default` | `ask` | no |
| `--permission-mode manual` | `default` | `ask` | no |
| `--permission-mode default` | `default` | `ask` | no |
| `--permission-mode dontAsk` | `dontAsk` | `deny` (allowlist fail-safe) | no |
| `manual` + pre-existing allow rule | `default` | `ask` | no |
| `auto` + pre-existing allow rule | `auto` | `ask` | no |

Findings: the hook's `ask` is honored in auto mode, including over a matching allow rule; `--permission-mode manual` now reaches the hook as `default`; a headless session with no flag starts in `default`, not `auto`; every observed value that should receive `ask` (`auto`, `default`) is already in `ASK_ELIGIBLE_PERMISSION_MODES`, and `dontAsk`, which is not, still falls to `deny`. The negative control, which ADR-0028 disclosed as not run, now exists and proves the setup could push, so each block above came from the hook. As in ADR-0025, headless mode reports `ask` and `deny` alike as a denial because no human is present; a live interactive prompt in auto mode was not exercised here.

### Skill hook lifetime

A probe plugin whose only skill declared a logging `PreToolUse` hook was driven through four sequential turns of one stream-json session, each turn sent only after the previous turn's `result`:

| Turn | Hook fired |
|---|---|
| 1. Bash call before the skill is invoked | no |
| 2. The skill's own turn (Bash call inside it) | yes |
| 3. Bash call on the next turn | **yes** |
| 4. Bash call on a later turn | **yes** |

ADR-0021's lifetime premise does not hold on 2.1.318: after `/krylo:run` is invoked, KRYLO's hooks stay registered for the rest of that session. An ordinary session that never invokes the skill still launches no KRYLO hook process (turn 1).

With no active run, each gate exits silently (`risk-gate.mjs` and `stop-gate.mjs` both call `allowClaudeSilently()` when `resolveActiveRun()` finds none). Measured cost of that pass-through, 12 runs each: `risk-gate.mjs` median 69 ms, `posttool-telemetry.mjs` 69 ms, `stop-gate.mjs` 59 ms, against 39 ms for a bare Node start. After a run, a session therefore pays roughly 140 ms per tool call and 60 ms per turn end.

### Failure behavior of a PreToolUse hook that cannot start

A hook pointing at a script that does not exist, with an exact allow rule for `mkdir probe-dir`:

| Configuration | Directory created |
|---|---|
| No hook (control) | yes |
| Broken hook, no `onFailure` | **yes** |
| Broken hook, `onFailure: "block"` (settings) | no |
| Broken hook, `onFailure: "block"` (skill frontmatter, turns after invocation) | no; the same command was allowed on the turn before the skill |

Before this ADR, a risk gate that crashed at startup on this platform silently let the action through.

## Decision

1. **Hooks stay in the run skill's frontmatter, with the lifetime stated as it is.** The ADR-0021 placement is kept, because it still gives zero KRYLO hook processes in a session that never invokes `/krylo:run`, which keeps KRYLO from acting as the default agent. The accepted cost is the post-run pass-through measured above. Moving the hooks to `hooks/hooks.json` was rejected: every ordinary session would pay it.
2. **Both PreToolUse gates fail closed.** The run skill declares `onFailure: "block"` on the `risk-gate.mjs` and `question-gate.mjs` handlers. For the question gate this reverses its documented fail-open stance for the one case of a failure to start; internal failures still allow, and the model can still ask in plain text, so the cost is losing the structured question tool, accepted for consistency with the risk gate. No other KRYLO hook does: a `Stop` hook that blocked on its own failure could keep a session from ending, and the telemetry and status hooks gate nothing. Accepted consequence: if Node or the plugin breaks after a run, the rest of that session's gated tools are blocked until the session is restarted. `tests/governance/hook-scoping.test.mjs` enforces both rules.
3. **The pinned Claude Code floor moves from `2.1.223` to `2.1.318`.** `onFailure` requires `2.1.295`, and `2.1.318` is the build every result above was obtained on. It is installed in `validate-plugin.yml` and `release.yml` from the upstream GitHub release, verified against the SHA-256 in that release's `SHASUMS256.txt` (`e6d426ca0c123f61fad58a361da0329f2a93cd206bc87040ed8d9576dd9eb583` for `claude-linux-x64.tar.gz`). This is the deliberate, reviewed floor change ADR-0022's upgrade policy requires. npm, which lagged behind GitHub Releases when ADR-0022 was written, now publishes current versions; the checksum-pinned binary is kept as the more deterministic install for a PR-blocking gate.
4. **The run skill's `model: sonnet` now applies; recorded, not changed.** Per the `2.1.259` CHANGELOG, frontmatter `model:` on skills was previously ignored in interactive sessions, so on the new floor the orchestrator turn runs on the Sonnet alias where it used to inherit the session model. This was not observed live in this checkpoint, and whether Sonnet is the intended orchestrator model is a product decision left open here.

## Consequences

- KRYLO no longer supports Claude Code `2.1.223` to `2.1.317`.
- The native-ask guarantee is re-proven on the current floor, including in the new default auto mode, with a negative control -- **for a hook whose `cwd` is the run's project root**, which is where every case in the matrix ran. A later investigation found that a `cwd` anywhere else (a project subdirectory, an unrelated directory) made the released gate miss the active run and pass the action through silently, live on this same build; that is fixed separately by `docs/adr/0043-session-keyed-run-resolution.md`, and the guarantee holds for any `cwd` only together with that ADR.
- A crashed gate is a block, not a bypass. Verified live on Windows only; on macOS and Linux this rests on the documented `onFailure` semantics, which are not platform-specific.
- Still not established: a genuinely interactive auto-mode session showing the native prompt to a present human for a KRYLO `ask`. This needs a human at the terminal and remains a manual check.
- Not addressed here, recorded as follow-ups: newer tool surfaces outside the risk-gate matcher (Monitor, SendMessage) need an ADR-0018 scope review, and the cross-harness Claude worker should pass an explicit `--permission-mode` instead of inheriting a changing default. Also unverified: `readStdinJson` stops reading at 1 MB and the gate exits 0; if Claude Code counted the resulting broken pipe on a very large tool input as a hook failure, `onFailure: "block"` would block that call after a run. Draining stdin before exiting would remove the question.

## Supersedes

None in full. Corrects the hook-lifetime premise of ADR-0021, whose placement decision stands, and amends ADR-0022's pinned floor.

## Superseded by

None.
