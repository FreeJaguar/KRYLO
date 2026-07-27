# Adapter: mattpocock/skills

- **Detection:** the `mattpocock-skills` Claude Code plugin listed as enabled in the user's `~/.claude/settings.json` (`enabledPlugins`). Read-only file check; never installs or enables the plugin.
- **Publisher / source:** Matt Pocock (aihero.dev), `https://github.com/mattpocock/skills`. Catalog ID: `mattpocock-skills`.
- **Reviewed identity:** commit `ed37663cc5fbef691ddfecd080dff42f7e7e350d` (`.claude-plugin/plugin.json` version `1.2.0`; `package.json` version `1.1.0`). A different commit or plugin version is not automatically trusted (`audit-tool.mjs`, `catalog/tools.json`).
- **License:** MIT. KRYLO does not vendor or copy any of its skill files or prompts; this adapter only detects and classifies.
- **Trust tier:** B. Optional compatibility only, never a dependency.
- **Authentication / network / secrets:** none at the reviewed commit. `package.json` has no `preinstall`/`install`/`postinstall` script; no `hooks.json`; no MCP server. One skill (`git-guardrails-claude-code`) ships a local shell script (`scripts/block-dangerous-git.sh`) that is not registered as a Claude Code Hook anywhere in the repository — it has no effect unless a user wires it in themselves.
- **Allowed environments:** all profiles (no network egress at the reviewed commit).

## Control rule

KRYLO remains the only orchestrator. This plugin is never a second orchestration layer, and none of its Skills are ever invoked automatically outside their own Claude Code invocation rules.

## Compatibility matrix (as inspected at the reviewed commit)

The plugin ships 22 Skills across two families. Each `SKILL.md`'s frontmatter determines model-invocation eligibility (`disable-model-invocation: true` means user-invoked only). KRYLO does not re-implement that mechanism; it classifies which Skills, *if* the user or the plugin's own invocation rules bring one up, are safe to treat as advisory input during a KRYLO run.

**Never auto-invoked — treated as conflicting or user-invoked-only** (setup, ticket/issue-tracking, triage, planning, or multi-session/handoff shaped, per each Skill's own description in `.claude-plugin/plugin.json`):

- `setup-matt-pocock-skills` — confirmed `disable-model-invocation: true` (user-invoked only); configures the repo's own issue tracker, triage labels, and domain-doc layout. KRYLO never runs this.
- `triage`, `to-tickets`, `to-spec` — ticket/issue-tracker-shaped; would write to project issue tracking, labels, or generated spec/ticket documents outside KRYLO's own acceptance-criteria and evidence model.
- `wayfinder`, `handoff` — multi-session/handoff-shaped orchestration aids; a second orchestration layer is exactly what KRYLO's own architecture (one orchestrator) forbids.
- `improve-codebase-architecture`, `prototype`, `resolving-merge-conflicts` — broader-scope, potentially multi-step workflows that overlap with KRYLO's own lane classification (BUILD/MIGRATION/INCIDENT); treated as conflicting unless a future re-review of the exact reviewed commit demonstrates otherwise.

**Optional, non-controlling advisory disciplines** (confirmed model-invokable — `tdd`'s `SKILL.md` frontmatter has no `disable-model-invocation` — and each maps onto an existing KRYLO phase/agent instead of adding a competing lifecycle):

| Upstream Skill | Maps onto |
|---|---|
| `tdd` | Builder execution style (red-green-refactor guidance) |
| `diagnosing-bugs` | Deep Debugger's root-cause investigation |
| `codebase-design` | Architect's design decisions |
| `domain-modeling` | Scout / Architect |
| `research` | Untrusted supporting evidence only, never authority |
| `code-review` | Reviewer's review pass — KRYLO's independent Verifier and Reviewer remain authoritative regardless of any guidance this Skill offers |

`ask-matt`, `grill-with-docs`, `grill-me`, `grilling`, `teach`, `writing-great-skills` and the remaining productivity/in-progress/deprecated/personal Skills are out of scope for a KRYLO run (personal-workflow or meta-Skill-authoring tools, not engineering-lifecycle input) and are neither invoked nor relied upon.

## Rules

- KRYLO never runs `setup-matt-pocock-skills` or any other upstream setup flow.
- KRYLO never lets an upstream Skill modify project issue tracking, labels, repository instructions, `CONTEXT.md`, ADRs, or personal configuration unless the current KRYLO task explicitly requires that exact write and KRYLO's own risk/question gates approve it.
- An approved advisory Skill's guidance is input, never authority: KRYLO's own completion contract, acceptance criteria, and independent Verifier/Reviewer decide when work is done, exactly as for any other untrusted external content (`PROMPT_INPUT_CONTRACT.md`).
- Re-review is required on any commit/version change, or if the plugin's skill list, `hooks.json`, or MCP configuration changes (`catalog/tools.json` `reReviewTriggers`).
- **Degraded behavior:** KRYLO works identically whether this plugin is present or absent; nothing above is required for KRYLO Core.
