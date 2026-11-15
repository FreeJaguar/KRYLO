# ADR-0044: Codex 0.167.2 is a reviewed, supported runtime, and apply_patch is classified from the field Codex actually sends

## Status

Accepted

## Context

The reviewed runtime contract (`plugins/krylo/policies/codex-runtime-compatibility.json`, ADR-0034) listed `0.120.0` and `0.154.0`. Every current Codex build was therefore `SAFE_BLOCKED` for a full autonomous `$krylo-run`. Between `0.155.0` and `0.167.2` upstream changed several things KRYLO's Codex host depends on:

- `0.164.0` (#54619) binds plugin hook trust to the plugin's file contents. Any write into the plugin directory voids the grant.
- `0.166.0` (#57198) reports a command's own working directory as the PreToolUse `cwd`.
- `0.164.0` added the `PreModelRequest`/`PostModelRequest` events.
- `0.155.0` added a `fork` SessionStart source.

Of these, the moved `cwd` let a governed session pass the gate. It was fixed for both hosts by ADR-0043 before this checkpoint.

## Method

The method follows ADR-0035, ADR-0037 and ADR-0038:

- **Isolated environment.** A temporary `CODEX_HOME` held only a copied `auth.json`, the KRYLO plugin installed with `codex plugin add` from the repository, and project trust appended to that sandbox `config.toml`.
- **Sandbox test repository.** A throwaway repository had a local bare remote, a `sub` directory, and a `.env` holding a fake test value.
- **Binary and session flags.** Codex `0.167.2` was installed into its own folder with `npm install --ignore-scripts`. Sessions ran `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --approve-for-me`.
- **The user's real Codex setup was not modified.** Their own `~/.codex/config.toml` was never written.
- **Reaching the enforcement paths.** Enforcement paths need an active run, so a sandbox-only contract listing `0.167.2` was supplied through the sanctioned `KRYLO_CODEX_COMPAT_TEST_MODE=1` override, exactly as in ADR-0037. The shipped contract was edited only afterwards, and the result was then re-verified with no override of any kind.

## Live results on codex-cli 0.167.2

| Case | Observed |
|---|---|
| Hook events | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` fire. `SessionEnd` fires: its telemetry marker appeared for a session that ended with an active run. |
| `git status` | runs; the gate is not blanket-denying |
| `git push origin main` | `hook: PreToolUse Blocked`, KRYLO's require-approval reason; remote unchanged |
| `cat .env` | blocked, secret-path reason |
| `git push origin main` through `exec_command` with `workdir` = the project's `sub` directory | blocked |
| `apply_patch` adding `notes.md` | **denied as unparseable before this ADR**; applied after it |
| `apply_patch` appending to `.env` | denied, secret-path reason |
| `git push origin main` issued by a subagent started with `spawn_agent` | blocked inside the subagent; the subagent's transcript records the block, and its hooks carry the parent's `session_id` |
| Stop gate | blocks while the run is active, completes once terminal |
| Telemetry | counters and categories only. No command text or `.env` value is anywhere in the data root. |
| Plugin directory | byte-identical before and after the sessions (217 files), as content-bound hook trust requires |
| Shipped contract **without** `0.167.2`, with `0.167.2` first on PATH | the runtime gate refused the run: `SAFE_BLOCKED` with a `codex-runtime-compat` finding naming `0.167.2` as unreviewed |
| Shipped contract **with** `0.167.2`, no override, `0.167.2` first on PATH | the gate admitted an active run, with no finding, and the Stop gate held it |

## Finding: apply_patch was denied on every reviewed Codex build checked

`risk-policy.mjs` classified `apply_patch` from `tool_input.patch`. Codex sends the raw patch as `tool_input.command` (`codex-rs/core/src/tools/handlers/apply_patch.rs`, `pre_tool_use_payload`, identical at `rust-v0.154.0` and `rust-v0.167.2`). `patch` was never set, no file target could be extracted, and every real `apply_patch` call was denied as `apply-patch-unparseable`.

This failed closed, so nothing unsafe got through. But a KRYLO run on the Codex host could not edit files at all. The test fixture used `{ patch }`, a shape neither checked Codex build (rust-v0.154.0, rust-v0.167.2) sends, so the test asserting "not a blanket apply_patch deny" passed while the real behavior was exactly that. ADR-0037 exercised only shell commands.

## Finding: reading the real field exposed a parser differential, closed before merge

Once `command` was read, an automated security review found that KRYLO extracted headers only at column 0.

Codex's parser (`codex-rs/apply-patch/src/streaming_parser.rs`, `rust-v0.167.2`) works differently:
- It trims each line before it matches the exact header prefixes.
- Inside an Update hunk it trims only the end of the line, so an indented header there is context.
- After the prefix it keeps the path **verbatim** (`PathBuf::from(path)`). That path is joined to the working directory and `..` is resolved lexically.

A patch could therefore pair a benign `*** Add File: notes.md` with an indented `*** Update File: .env` on the following line. KRYLO saw only the benign target and passed the patch. Per Codex's parser source, Codex would have treated the indented line as a header for `.env`. That half was read from source, not executed. A unit test reproduced KRYLO's half on the first revision of this change.

The extractor now works as follows.

1. **Splitting and trimming.** It splits on `\n` only and trims each line with the union of Rust's and JavaScript's whitespace sets. Rust's set includes U+0085, JavaScript's does not. It trims by scanning code points from each end, not with a regex; see below. Over-trimming can only reveal more headers.
2. **Exact prefixes.** It matches the exact header prefixes.
3. **Whitespace-padded targets are denied.** A target that would change under trimming is denied as ambiguous, never classified by its trimmed name. Codex keeps that whitespace in the path, so for example ` /../../data/x` is `<cwd>/ /../../data/x` to Codex (KRYLO's data directory) but a filesystem-root path to a check that trims it first. Trailing whitespace is not affected: Codex trims the whole line first, so it never reaches the path. U+FEFF is trimmed by JavaScript but kept by Rust, so a header line containing it is denied too.
4. **Look-alike lines fail closed.** Any line that looks like a header but is not in the exact form (other case, missing spaces) is denied as `apply-patch-ambiguous` rather than guessed at.
5. **Other environments are denied.** A patch carrying `*** Environment ID:` addresses another execution environment's filesystem, which cannot be checked against this machine's protected paths. It is denied as `apply-patch-remote-environment`.

Accepted cost of failing closed: header-like context lines in an Update hunk (for example a Markdown line ` **Update file:** …`, or an indented `*** Move to:` that Codex treats as context) are denied, although Codex would not treat them as headers. Mirroring Codex's per-mode trimming exactly would remove these false positives, at the price of a bypass if that mode tracking ever diverged from Codex's.

A benign `apply_patch` edit was re-verified live on `0.167.2` with the final code and no override, and the `.env` edit was denied.

### Hardening from two independent review rounds

Each item below has a test that fails on the revision before it.

- **Targets with hidden characters are denied.** A target containing a control character (NUL, other C0, DEL) or U+2028/U+2029 is denied as ambiguous. Because lines are split on `\n` only, those separators can no longer cut a path short.
- **Path work is bounded.** Each target runs the full per-path checks, which resolve its components on disk. The reviews measured about 22 s for 5,000 targets, 45 s for one 32 KB path, and 52–81 s for 100 deep targets inside the length and count caps, against a 30 s hook timeout. A patch is denied as `apply-patch-oversized` if it exceeds any of these:
  - 1,000,000 characters;
  - 100 targets;
  - a path over 1,024 characters;
  - 1,000 path components across all targets.

  The worst case inside the bounds measured under 0.7 s on Windows. Large file content in a single-target patch is unaffected.
- **Trimming is linear.** The first union-whitespace trim was a regex with an unanchored trailing branch, which made it quadratic. One content line of 300,000 spaces, inside the length cap, took about 70 s. Code-point scanning classifies 300,000 spaces, `*` or U+0085 in about 10 ms.
- **Fields must be text.** A `command` or `patch` field that is present but not a string is denied, instead of being ignored beside a benign string in the other field.
- **Mutation testing.** The second round removed, one at a time:
  - ASCII-only trimming;
  - U+0085 handling;
  - the look-alike check;
  - the forbidden-character check;
  - the target cap;
  - `patch` handling;
  - non-string handling.

  Each mutation was caught by a test. The target cap is now pinned by a deterministic test (101 benign targets) instead of a timing assertion.

Not verified: what Codex does with the tool call when a PreToolUse hook exceeds its timeout. The bounds above keep KRYLO's own classification well inside it.

## Finding: the runtime gate verifies the binary PATH resolves, not the one running the session

In the first sessions a different Codex installation (`0.154.0`, supported) came first on PATH. The gate admitted an active run while the session itself ran on the then-unreviewed `0.167.2`. With `0.167.2` first on PATH, the gate refused it as it should. Hooks do inherit the session's PATH; the gap is per-binary identity when more than one installation exists. ADR-0038 already disclosed it, and it was observed live here.

Codex records the running binary's version as `cli_version` in the first (`session_meta`) record of the session transcript, whose path every hook payload carries as `transcript_path`. Using it would close the gap. That changes ADR-0034's design and is left to a separate decision.

## Decision

1. `0.167.2` is added to `supported`, with the evidence and the residuals below in its own `evidence` and `notes` fields. `0.120.0` and `0.154.0` are unchanged; `blocked` stays empty.
2. `risk-policy.mjs` classifies `apply_patch` from `tool_input.command`, still accepting `tool_input.patch`. When both are present, both are classified, so neither can mask the other. Headers are extracted the way Codex parses them, and header look-alikes fail closed. The fixtures in `tests/hooks/risk-gate-codex.test.mjs` now use the real shape, and `tests/unit/risk-policy.test.mjs` pins the masking rule and the parser differential.

## Residuals this approval accepts

- **Hook trust was bypassed in the sandbox.** `0.164.0`'s content-bound trust was not exercised through its real review flow. On a real machine untrusted hooks never run, and any change to the plugin directory voids the grant until it is re-approved.
- **The per-binary identity gap described above.**
- **Unregistered events.** `PermissionRequest`, `PreModelRequest`/`PostModelRequest`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop` and `Interrupt` are recognized by this build but unregistered by KRYLO and unexercised.
- **No `ask` on Codex.** PreToolUse `permissionDecision: "ask"` still fails open on this build, so the Codex gate stays deny-only.
- **Platform.** Verified on Windows 11 only.
- **Upstream moved on.** It is at `0.169.0` already, and the weekly checks will keep reporting that.

## Consequences

- On `0.167.2`, `$krylo-run` bootstraps an active run, and the Codex host can edit files through `apply_patch` under the same per-target checks as Claude's Write/Edit.
- `codex-tested-version-vs-latest-upstream` now measures from `0.167.2`.
- `codex-hook-event-names-recognized` still reports `SessionEnd` unconfirmed on `0.120.0`. That remains true until `0.120.0` is re-verified or retired.

## Supersedes

None. Applies ADR-0034's amendment procedure, as ADR-0038 did, and corrects the `apply_patch` input handling ADR-0029's design assumed.

## Superseded by

None.
