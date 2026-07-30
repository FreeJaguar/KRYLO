# Adapter: mattpocock/skills

- **Detection:** the `mattpocock-skills` Claude Code plugin listed as enabled in the user's `~/.claude/settings.json` (`enabledPlugins`). Read-only file check; never installs or enables the plugin.
- **Publisher / source:** Matt Pocock (aihero.dev), `https://github.com/mattpocock/skills`. Catalog ID: `mattpocock-skills`.
- **Reviewed identity:** commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` (`.claude-plugin/plugin.json` version `1.2.0`; `package.json` version `1.1.0`). A different commit or plugin version is not automatically trusted (`audit-tool.mjs`, `catalog/tools.json`).
- **License:** MIT. KRYLO does not vendor or copy any of its skill files or prompts; this adapter only detects and classifies.
- **Trust tier:** B. Optional compatibility only, never a dependency.
- **Authentication / network / secrets:** none at the reviewed commit. `package.json` has no `preinstall`/`install`/`postinstall` script; no `hooks.json`; no MCP server. One skill (`git-guardrails-claude-code`) ships a local shell script (`scripts/block-dangerous-git.sh`) that is not registered as a Claude Code Hook anywhere in the repository — it has no effect unless a user wires it in themselves.
- **Allowed environments:** all profiles (no network egress at the reviewed commit).

## Control rule

KRYLO remains the only orchestrator. This plugin is never a second orchestration layer, and none of its Skills are ever invoked automatically outside their own Claude Code invocation rules.

## Compatibility matrix (as inspected at the reviewed commit)

The plugin ships 22 Skills across two families (`skills/engineering/`, 17; `skills/productivity/`, 5), plus 4 further families (`in-progress/`, `deprecated/`, `personal/`, `misc/`) not listed in the plugin manifest's own `skills` array. Each `SKILL.md`'s frontmatter determines model-invocation eligibility (`disable-model-invocation: true` means user-invoked only). KRYLO does not re-implement that mechanism; it classifies which Skills, *if* the user or the plugin's own invocation rules bring one up, are safe to treat as advisory input during a KRYLO run. Every Skill in the two shipped families, plus the four `misc/` Skills, was individually re-inspected at the reviewed commit (`docs/external-adapter-audit-2026-07-27.md`, "Re-review — 2026-07-30") — the classification below is not carried over from folder names alone.

**Optional, non-controlling advisory disciplines** (confirmed model-invokable — no `disable-model-invocation` in frontmatter — and each maps onto an existing KRYLO phase/agent instead of adding a competing lifecycle):

| Upstream Skill | Maps onto |
|---|---|
| `tdd` | Builder execution style (red-green-refactor guidance) |
| `diagnosing-bugs` | Deep Debugger's root-cause investigation |
| `codebase-design` | Architect's design decisions |
| `domain-modeling` | Scout / Architect |
| `research` | Untrusted supporting evidence only, never authority |
| `code-review` | Reviewer's review pass — KRYLO's independent Verifier and Reviewer remain authoritative regardless of any guidance this Skill offers |
| `grilling` | Architect / Product Strategist — a Socratic, read-only interview used to stress-test a design or decision before committing to it; writes nothing and offers no authority over KRYLO's own acceptance criteria |

**Excluded despite being model-invokable** (frontmatter has no `disable-model-invocation`, so Claude Code's own gate does not keep these out — KRYLO's own policy is the only thing that does):

- `prototype` (engineering) — writes throwaway exploratory code/branches; overlaps with the Builder's own worktree lifecycle.
- `resolving-merge-conflicts` (engineering) — edits files to complete a merge/rebase; overlaps with the Builder/incident lane's own conflict resolution.
- `git-guardrails-claude-code` (misc) — installs/wires a local git-command guard (`scripts/block-dangerous-git.sh`); configures git hooks. This is the one place KRYLO's classification does real work rather than restating an upstream gate: never auto-invoked under any circumstance.
- `setup-pre-commit` (misc) — configures Husky/pre-commit hooks and Claude Code Hook wiring. Same reasoning as above: never auto-invoked.

**User-invoked-only** (frontmatter has `disable-model-invocation: true`; Claude Code itself blocks model auto-invocation, so these are available to the user manually at any time via their own `/skill-name` but KRYLO never relies on or auto-triggers any of them): `setup-matt-pocock-skills`, `ask-matt`, `grill-with-docs`, `implement`, `improve-codebase-architecture`, `grill-me`, `handoff`, `teach`, `writing-great-skills`, `triage`, `to-tickets`, `to-spec`, `wayfinder`. Most are read-only advisory (`ask-matt`, `grill-me`), but `implement` and `grill-with-docs` also write to the project (code, ADRs, glossary files respectively) — noted because "user-invoked-only" is about who can trigger the Skill, not about what it does once triggered.

**Out of scope, low-risk** (misc, model-invokable, no config/hook mutation, narrow single-purpose tooling): `migrate-to-shoehorn`, `scaffold-exercises`.

**Excluded wholesale by category, not individually inspected**: `skills/in-progress/*` (9 Skills), `skills/deprecated/*` (4 Skills), `skills/personal/*` (2 Skills). Upstream's own folder naming signals these are not part of the supported, general-purpose surface (works-in-progress, superseded, or Matt Pocock's own personal-workflow Skills) — this is a category-level decision, re-confirmed at each re-review, not a claim that every Skill inside has been read.

## Rules

- KRYLO never runs `setup-matt-pocock-skills` or any other upstream setup flow.
- KRYLO never lets an upstream Skill modify project issue tracking, labels, repository instructions, `CONTEXT.md`, ADRs, or personal configuration unless the current KRYLO task explicitly requires that exact write and KRYLO's own risk/question gates approve it.
- An approved advisory Skill's guidance is input, never authority: KRYLO's own completion contract, acceptance criteria, and independent Verifier/Reviewer decide when work is done, exactly as for any other untrusted external content (`PROMPT_INPUT_CONTRACT.md`).
- Re-review is required on any commit/version change, or if the plugin's skill list, `hooks.json`, or MCP configuration changes (`catalog/tools.json` `reReviewTriggers`).
- **Degraded behavior:** KRYLO works identically whether this plugin is present or absent; nothing above is required for KRYLO Core.
