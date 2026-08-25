# ADR-0028: Foundation final closure — live always-allow proof, settings-weakening protection, edge-case fixes

## Status

Accepted

## Context

This is the final Foundation security/correctness checkpoint before Codex Host work may begin. It closes four remaining classes of concern that prior checkpoints (ADR-0024 through ADR-0027) left open, deferred, or merely disclosed rather than fixed or empirically tested:

1. Whether Claude Code's native "always allow" persistence (or a pre-existing `permissions.allow` rule) could silently disable a KRYLO hook's `ask` decision -- an explicitly untested, disclosed gap since ADR-0025.
2. Whether the model could weaken KRYLO's or Claude Code's own enforcement surface directly (editing `.claude/settings.json`, disabling a hook, editing KRYLO's own installed policy/hook files) -- never previously addressed at all.
3. Four specific edge cases in the risk classifier: a relative-path gap in the destructive-delete pattern, a wildcard/glob evasion of sensitive-path protection, an availability regression treating `.env.example`-style shareable templates as secrets, and an over-broad git-push pattern -- all previously disclosed as accepted residuals, never fixed.
4. A fresh CHANGELOG review from the pinned 2.1.223 floor through the current latest release (2.1.245, checked via the GitHub API), to decide whether any newer fix is one KRYLO's own design actually depends on.

An important operational discovery made while investigating (1): this session's test-isolation env vars (`KRYLO_DATA_ROOT`) were being silently ignored by the runtime CLI scripts invoked via the path baked into the `/krylo:run` Skill's own instructions (`~/.claude/plugins/cache/krylo-marketplace/krylo/0.1.1/scripts/...`). That path is the **installed plugin cache**, a stale snapshot dated before ADR-0024 (still uses the deleted KRYLO-APPROVE mechanism, has no PowerShell/Read/Glob/Grep coverage, no `host/claude/context.mjs`, and does not recognize `KRYLO_DATA_ROOT` at all -- only the older `CLAUDE_PLUGIN_DATA`). The actual source repository (`plugins/krylo/scripts/...`, this checkpoint's own working tree) correctly honors `KRYLO_DATA_ROOT` once invoked directly. This is disclosed as an important operational fact, not a KRYLO code defect: a plugin's installed cache naturally lags its source repository until explicitly reinstalled/updated, which is normal for the plugin development lifecycle, but is worth knowing because it means this environment's own installed KRYLO has not received any hardening from ADR-0019 onward without an explicit update. All live testing in this checkpoint invokes the repository's own scripts directly, with `KRYLO_DATA_ROOT` verified to actually isolate before any test ran.

## Decision

### A. Live always-allow / pre-existing-rule testing

Official Claude Code documentation (`code.claude.com/docs/en/permissions`, "Extend permissions with hooks") states, verbatim: *"Hook decisions don't bypass permission rules. Claude Code evaluates deny and ask rules regardless of what a PreToolUse hook returns: a matching deny rule blocks the call, and a matching ask rule still prompts even when the hook returned `"allow"` or `"ask"`... A blocking hook also takes precedence over allow rules."* This states the hook's own decision is a first-class part of the evaluation, but does not explicitly spell out the exact interaction this checkpoint most needed evidence for (a hook `ask` versus a *pre-existing* `allow` rule specifically), so it was tested live rather than inferred.

Three live tests were run against the pinned, checksum-verified `2.1.223` binary, in an isolated disposable repository, isolated `KRYLO_DATA_ROOT`, and a fresh KRYLO run per test, with a matching `permissions.allow` rule seeded **before** the session started (test case 5/6's scenario -- the most directly scriptable without a human clicking a live UI):

- **Bash, rule via `.claude/settings.local.json`** (`"allow": ["Bash(git push *)"]`), attempting `git push origin main`: blocked. `permission_denials` populated; the model's own report quoted KRYLO's exact denial reason verbatim and confirmed no push occurred.
- **Bash, rule via a `--settings <file>` layer** (a different settings source than local project settings), same command: blocked, identical result.
- **PowerShell, rule via `--settings <file>`** (`"allow": ["PowerShell(Remove-Item *)"]`), attempting `Remove-Item -Recurse -Force ./scratchsubdir`: blocked; the target directory was confirmed to still exist afterward.

All three: the hook's `ask` decision was honored over a pre-existing, matching `allow` rule, from two independent settings sources, on two tool types. **This directly answers the ADR-0025 open question for the pre-existing-rule scenario with real evidence, not inference.**

**Not separately live-tested, disclosed honestly:**
- **The mid-session "click Always Allow, then repeat the same action" dynamic scenario** (test case 2). No interactive human or `--permission-prompt-tool` harness was built to simulate a live click. This is covered by the *same* mechanism just tested: rule evaluation happens fresh on every matching tool call regardless of when the competing rule was written, so a rule saved mid-session is architecturally identical, at evaluation time, to one that existed before the session -- which the live tests directly exercised. This is a reasoned inference from a real, adjacent test, not an untested assumption, but it is disclosed as not itself directly observed.
- **A live MCP require-approval variant.** No live, write-capable MCP server was available in this environment to exercise. The same code-level guarantee applies (the `ASK_ELIGIBLE_PERMISSION_MODES` allowlist and the tool-eligibility check in `risk-gate.mjs` treat Bash/PowerShell/MCP identically, and the host-side rule-evaluation-versus-hook-decision behavior just tested is a host-level mechanism with no documented MCP-specific carve-out), but it was not independently observed for MCP specifically.
- **New-session/worktree persistence** (test cases 3/4) were not separately run; they are the same "pre-existing rule at session start" scenario already covered by tests 1-3 above, just reached via a different mechanism for how the rule came to exist beforehand.

**Section A's core question is resolved: Always Allow and pre-existing allow rules do NOT bypass KRYLO's native ask, confirmed with real, reproducible evidence.** No fallback ConfigChange-hook defense is implemented, per the task's own instruction not to add that complexity when live testing proves `ask` already forces a prompt over persistent allow rules.

### B. Model-driven security-config weakening

Two new protections in `scripts/security/risk-policy.mjs`, both `deny` (not `require-approval` -- a model must never negotiate for this, and a human editing this configuration directly is not the threat model, only a model doing so silently is):

- **`touchesClaudeSettings()`**: denies Write/Edit/NotebookEdit targeting `.claude/settings.json` or `.claude/settings.local.json` (project or user-level, any depth), and any Bash/PowerShell command referencing either path. Reading these files is unaffected (not itself a threat, and the model may legitimately need to inspect current configuration). This directly closes the three required regression scenarios: a model can no longer add a `permissions.allow` rule, remove the `hooks.PreToolUse` registration, or set `defaultMode` to `bypassPermissions` by writing to its own settings files.
- **`touchesPluginInstallation()`**: denies Write/Edit/NotebookEdit and Bash/PowerShell references targeting a path under the KRYLO plugin's own **installed** location (`pluginRoot`, threaded through from `risk-gate.mjs`'s normalized Claude identity -- the real `CLAUDE_PLUGIN_ROOT` a host sets). This is scoped to the installed location specifically, not to filenames like `risk-gate.mjs` matched anywhere, so it does not interfere with KRYLO's own source-repository development (a different path in ordinary use) -- verified by an explicit negative-case test.

Both are regression-tested at the shared-policy unit level and (for the settings-file case) end-to-end through the real Hook process.

### D. Classifier edge cases

1. **Relative-path destructive-delete gap.** The Bash `rm` pattern required an absolute/home-anchored target (`\brm\s+(-[a-z]*[rf][a-z]*\s+)+(/|~|\$HOME|[a-z]:\\)`), so `rm -rf ./build`, `rm -rf node_modules`, `rm -rf .`, `rm -rf *`, `rm -rf ../` all passed through completely ungated. Fixed by dropping the anchor requirement (`(?<!git )(?<!docker )(?<!npm )\brm\s+(-[a-z]*[rf][a-z]*\s+)+\S`) -- a negative lookbehind specifically excludes `git rm`/`docker rm`/`npm rm` (a different tool's subcommand, not the actual filesystem-delete shell command), preserving the exact existing hygiene-command negative tests. Per this task's own explicit direction, the consequence of this widening is `require-approval` (native `ask`, per ADR-0027 -- a real, immediate human-approval path), not an accidental unconditional deny: this is only safe to do now that ADR-0027 restored native ask to every require-approval class, including `destructive-operation`.
2. **Sensitive-path wildcard evasion.** The `.env` and `id_rsa` sensitivePaths patterns anchored their trailing boundary to end-of-string, a literal `.`, or a path separator -- never a literal `*` -- so `cat .env*`, `Grep(glob: '.env*')`, and `Glob(pattern: '**/.env*')` (shell/tool wildcards that expand to the exact same secret file at execution time) evaded the pattern entirely. Fixed by adding `\*` to the accepted trailing-boundary alternation for both patterns (and, separately, for the `.pem`/`.pfx`/`.key`/... and `secrets.json`/`.yaml`/`.toml` end-anchored patterns). Schema-aware, not a blanket wildcard ban: Grep's `pattern` field (a content regex, never a path) remains untouched, per the existing ADR-0027 distinction.
3. **`.env.example` regression.** The same `.env` pattern's boundary (matching `.env` followed by end-of-string, `.`, `*`, or a separator) treated `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, and `.env.defaults` -- conventional, public, non-secret templates committed to version control on purpose -- identically to a real secret `.env`. Fixed with a narrow, explicit exception (`ENV_TEMPLATE_EXCEPTION`) checked before the general sensitive-path match, matched at a full path-segment boundary so `.env.example.secret` or a directory literally named `.env.example` containing a real secret is not accidentally exempted.
4. **git-push over-match.** `\bgit\b[^|;&\n]*?\bpush\b` matched the literal word "push" anywhere after "git" with no requirement that it be the actual subcommand -- `git commit -m "push button feature"` classified as `git-push`, and whitespace normalization (`firstMatchingClass()`) neutralized the pattern's own newline exclusion, so a multi-line script with "git" on one line and "push" on a later one matched too. Tightened to require "push" immediately follow "git" plus only recognized global option tokens (`-C`, `-c`, `--git-dir=`, etc.): `\bgit\b(?:\s+(?:-{1,2}[\w-]+(?:[=\s]\S+)?))*\s+push\b`. All previously-required matches (`-C`/`-c`/`--git-dir=` variants, `+refspec`/`--force` force-push detection) still match; the false-positive case no longer does.

All four are covered by new, deterministic regression tests (`tests/unit/risk-policy.test.mjs`), and the full suite (309 tests at the point these were added) passes with no regressions.

### E. Audit trail

Not implemented this checkpoint. KRYLO already records that a native `ask` was *raised* (`{event: 'risk-gate', category, status: 'ask'}`) but, as ADR-0027 already disclosed, never learns the human's subsequent choice -- Claude Code does not expose a dedicated "human selected Allow once" post-event to a PreToolUse hook. Per this task's own explicit instruction ("do not invent evidence the platform does not expose... document that limitation honestly as observability-only and do not block Foundation solely for missing unsupported telemetry"), this remains an honestly-disclosed, accepted gap, not a blocker. ADR-0027's own follow-up suggestion (correlate `PostToolUse`/`PostToolUseFailure` via `tool_use_id` to record "an asked action subsequently executed or failed," writing an audit-only, never-`approved` record) remains a reasonable future enhancement, not attempted in this checkpoint given the explicit non-blocking framing and this checkpoint's already-large scope.

### F. Claude Code version / supply-chain review

Reviewed the full official CHANGELOG (fetched via the GitHub Contents API, not `raw.githubusercontent.com` -- that redirected to a `*.opendns.com` host, which was treated as an untrusted redirect and not followed) from `v2.1.223` through the current latest release, `v2.1.245` (confirmed via `gh api repos/anthropics/claude-code/releases`). Findings relevant to KRYLO's own design:

- The two entries most directly relevant to permission-prompt display integrity -- "Fixed a Bash permission bypass where a crafted command could hide parts of itself from permission checks" and "Fixed permission prompts so commands padded with tabs or invisible Unicode can no longer hide part of the command from the approval dialog" -- are **both already in v2.1.223**, the currently pinned floor. No newer version is needed for this specific concern.
- v2.1.232 fixed a real PowerShell permission bypass (`$PSDefaultParameterValues` variable-writing parameters silently redirecting later commands' file access) and a Windows Git-Bash Cygwin-style-symlink bypass; v2.1.233 **partially reverted** the Cygwin-symlink and input-redirection parts of that same fix ("a narrower version will return in a later release"). Neither constitutes a fix KRYLO's own PreToolUse-hook-decision design depends on: both are about Claude Code's own native execution-layer file-access checks (what happens to file operations *after* a command is permitted to run), not about whether KRYLO's hook correctly receives and classifies the raw command text, or whether a human sees an accurate command before approving -- KRYLO's own classification operates on the same raw stdin text regardless of either bypass. Disclosed as a residual host-level risk, not actioned.
- No CHANGELOG entry in this range documents a change to permission rule precedence, to how a hook's `ask` interacts with a pre-existing `allow` rule, or to MCP permission handling in a way relevant to KRYLO's design.

**The floor stays at 2.1.223.** No version bump is warranted under this task's own stated criterion ("raise the floor only for a security/runtime fix that KRYLO actually depends on") -- the fixes KRYLO's design does depend on are already included at the current floor.

## Consequences

- Every require-approval class now has both a real human-approval path (ADR-0027) *and* live-verified evidence that a pre-existing allow rule cannot silently disable it (this ADR) -- the two together substantively answer KRYLO's product contract for the approval boundary.
- The model can no longer weaken its own security surface by editing Claude Code's settings files or the KRYLO plugin's own installed files, closing a previously entirely-unaddressed gap.
- Four real, previously-disclosed-but-unfixed classifier gaps are now fixed and regression-tested.
- The mid-session dynamic "always allow" click and a live MCP variant remain not directly observed, disclosed rather than assumed; this is an accepted, reasoned gap given this checkpoint's environment constraints (no interactive human, no live write-capable MCP server), not an oversight.
- Section E (audit trail) is explicitly deferred with the task's own stated permission to do so.
- The stale-installed-plugin-cache discovery is recorded as important operational context for anyone relying on this development environment's "installed" KRYLO for further live testing; it does not affect the correctness of the source repository this checkpoint hardens.

## Supersedes

None (adds new decisions; does not reverse any prior ADR's decision).

## Superseded by

None.
