# KRYLO Multi-Host, Cross-Harness, and Ecosystem Maintenance Design

- Design date: 2026-08-20
- Repository: `FreeJaguar/KRYLO`
- Baseline branch: `main`
- Baseline commit verified before this design: `be76b9ff8302c428598e97f7e289734d08340fd1`
- Current product version at baseline: `0.1.1`
- Target capability release: `0.2.0`
- Intended repository path: `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md`
- Design status: Approved in product discussion, pending repository commit and implementation plan

## 1. Executive summary

KRYLO will evolve from a Claude Code-only plugin into a multi-host software-development orchestration product with two first-class execution hosts: Claude Code and Codex. The product will retain a single shared KRYLO Core for run state, Orbit, evidence, completion, approvals, tool governance, data-egress policy, telemetry, and logical agent roles. Claude Code and Codex will each provide a thin host adapter that translates host-specific invocation, hooks, session metadata, agent configuration, model routing, and packaging into the shared Core contract.

The existing Claude Code public command remains `/krylo:run <task>`. Codex will expose an explicit `krylo-run` Skill, invoked through Codex's explicit Skill mechanism, with implicit invocation disabled. Codex CLI will receive a native plugin package. Because the Codex IDE extension does not currently support plugins, VS Code support will use a standalone Codex Skill plus explicitly installed project-scoped Codex hooks for full KRYLO enforcement.

KRYLO will also support optional cross-harness advisory workers. A Claude-hosted KRYLO run may invoke Codex through `codex exec`, and a Codex-hosted KRYLO run may invoke Claude Code through `claude -p`. Initial cross-harness roles are read-only advisory roles only. The external harness cannot become the Builder, cannot approve risk, cannot declare completion, and cannot recursively delegate to another harness. Cross-harness delegation depth is limited to one.

A new maintenance subsystem will run in GitHub Actions rather than as a permanent process on a user's machine. A weekly read-only upstream watch will detect drift in reviewed integrations. A monthly read-only ecosystem radar will discover high-signal Skills, Plugins, MCP servers, and related tools. Scheduled workflows may detect and analyze, but they may not install candidates, execute candidate code, change trust, create pull requests, merge, release, or publish.

The migration must preserve existing Claude behavior first. Host-neutral Core extraction is completed and regression-verified before native Codex support is added.

## 2. Source-of-truth baseline

This design follows the KRYLO source-of-truth order and was prepared against the repository state listed above.

The current repository is Claude-centric:

- `PRODUCT_SPEC.md` defines KRYLO as a Claude Code plugin and `/krylo:run` as the primary command.
- `ARCHITECTURE.md` already separates a Markdown control plane from a deterministic Node.js runtime, which provides a natural foundation for a shared Core.
- `docs/adr/0021-hook-scoping-to-run-skill.md` deliberately keeps Claude hooks Skill-scoped so normal Claude Code sessions launch zero KRYLO hook processes.
- `docs/adr/0022-claude-code-compatibility-policy.md` defines a pinned compatibility floor plus a separate weekly current-version signal.
- `docs/adr/0013-no-silent-settings-mutation.md` requires dry-run, backup, explicit approval, and rollback for user configuration changes.
- `docs/adr/0014-one-writer-per-worktree.md` permits one normal application-code writer per worktree.
- `SECURITY.md` and `THREAT_MODEL.md` treat KRYLO policy integrity, source code, credentials, external content, tool poisoning, supply-chain compromise, command injection, and false completion as protected security concerns.
- `plugins/krylo/catalog/tools.json` already records reviewed versions or commits and re-review triggers for external integrations.

Current official platform behavior that constrains this design:

- Claude Code supports hooks in Skill and agent frontmatter while the component is active.
- Codex supports lifecycle hooks from user, repository, managed, and plugin sources, but does not currently provide the same Skill-scoped hook lifecycle as Claude Code.
- Codex `PreToolUse` can inspect or deny local shell, `apply_patch`, MCP, and other local function tools, but hosted tools can bypass this hook path.
- Codex `PreToolUse` output semantics are not identical to Claude Code. Unsupported control fields can cause the hook to fail while the tool continues, so host-specific response adapters are mandatory.
- Codex plugin hooks receive `PLUGIN_ROOT` and `PLUGIN_DATA`, and compatibility aliases `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`.
- Codex standalone Skills work in Codex CLI and the IDE extension. Codex plugins do not currently work in the IDE extension.
- Codex explicit Skill invocation uses the Skill mention mechanism, and `allow_implicit_invocation: false` keeps a Skill explicit-only.
- `codex exec` is non-interactive, defaults to a read-only sandbox, and supports JSON Schema structured final output.
- `claude -p` is non-interactive and supports tool restriction and JSON Schema structured final output.

Official references to re-verify immediately before implementation:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/plugins
- https://learn.chatgpt.com/docs/plugins
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/build-plugins
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/non-interactive-mode

No implementation may rely on a remembered platform schema when the current official documentation differs.

## 3. Goals

KRYLO 0.2 must:

1. Make Claude Code and Codex first-class KRYLO hosts without duplicating KRYLO Core behavior.
2. Preserve `/krylo:run <task>` and current Claude Code behavior for existing users.
3. Expose an explicit Codex KRYLO entry point without making KRYLO the default Codex workflow.
4. Support Codex CLI natively and provide a safe standalone-Skill path for the Codex VS Code extension.
5. Keep Orbit, evidence, approvals, security policy, tool governance, and completion semantics host-neutral.
6. Preserve one normal Builder per worktree.
7. Permit bounded, optional, read-only cross-harness advisory workers without creating recursive agent loops.
8. Keep KRYLO Core free of mandatory third-party services, external MCP servers, or SDK dependencies.
9. Detect upstream integration drift weekly without automatically changing trust.
10. Discover promising ecosystem integrations monthly without installing or executing them.
11. Keep scheduled maintenance read-only by default.
12. Preserve Windows, macOS, and Linux support.
13. Preserve local-only KRYLO telemetry and existing privacy exclusions.
14. Keep release, publication, push, merge, deployment, production, and external-write actions human-gated.

## 4. Non-goals

KRYLO 0.2 will not:

- Replace Claude Code or Codex.
- Make KRYLO the default agent or implicit orchestrator for ordinary host sessions.
- Build a standalone KRYLO daemon or hosted control plane.
- Require OpenAI, Anthropic, GitHub, or third-party API keys to use KRYLO Core on its native host.
- Require the Codex SDK or another orchestration framework.
- Allow a cross-harness worker to be the normal application-code Builder in the initial release.
- Permit a cross-harness worker to approve risk or determine final completion.
- Allow unlimited Claude-to-Codex-to-Claude delegation.
- Automatically install, trust, update, merge, release, or publish external Skills, Plugins, MCP servers, or tools.
- Execute unreviewed upstream candidate code in scheduled discovery or drift workflows.
- Publish KRYLO to the OpenAI universal plugin directory without separate explicit authorization.
- Change the existing Claude `/krylo` personal alias contract as part of Codex support.

## 5. Chosen architecture

### 5.1 System shape

```text
KRYLO
|
+-- Shared Core
|   +-- run identity
|   +-- state machine
|   +-- acceptance criteria
|   +-- evidence
|   +-- Orbit
|   +-- stagnation detection
|   +-- completion contract
|   +-- risk and approvals
|   +-- tool governance
|   +-- data-egress policy
|   +-- adapter registry
|   +-- telemetry and redaction
|   `-- logical agent roles
|
+-- Claude Code Host
|   +-- Claude plugin manifest and marketplace
|   +-- /krylo:run
|   +-- Claude Skills
|   +-- Claude agents
|   `-- Skill-scoped Claude hooks
|
+-- Codex Host
|   +-- Codex plugin manifest
|   +-- explicit krylo-run Skill
|   +-- Codex agents
|   +-- Codex hook transport
|   `-- VS Code standalone-Skill bridge
|
+-- Cross-Harness
|   +-- Claude -> Codex advisory worker
|   `-- Codex -> Claude advisory worker
|
`-- Maintenance
    +-- weekly upstream watch
    `-- monthly ecosystem radar
```

### 5.2 Architectural rule

Host-specific code may translate, discover, and validate host capabilities. It may not reimplement KRYLO policy. If two host adapters contain independent copies of risk classification, approval rules, completion rules, Orbit decisions, evidence semantics, or tool trust policy, the design has failed.

## 6. Shared Core boundary

The Shared Core owns all behavior that must remain equivalent between hosts:

- KRYLO `runId` allocation and lifecycle.
- Goal normalization and acceptance-criteria state.
- Lane and risk classification inputs and deterministic policy outputs.
- Run state schema and migrations.
- Evidence record schema and staleness rules.
- Orbit cycle budget, delta calculation, stagnation fingerprints, strategy-change requirement, and terminal decisions.
- Question and risk approval lifecycle, including scope, expiry, atomic consumption, and replay resistance.
- Tool trust registry interpretation.
- Environment and data-egress policy.
- External adapter policy.
- Agent result schema and validation.
- Completion contract and final terminal-state decision.
- Local telemetry redaction, retention, and safe aggregation.
- Cross-harness recursion policy and advisory-result validation.

The Shared Core must not depend directly on:

- `CLAUDE_SESSION_ID`.
- `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}`.
- Codex-specific `session_id`, `turn_id`, or `permission_mode` field names.
- Claude model aliases.
- Codex model slugs.
- Claude or Codex hook response JSON shapes.
- A specific host's Skill frontmatter extensions.

## 7. HostContext and run identity

### 7.1 HostContext

Every native KRYLO invocation resolves a normalized immutable context before Core logic begins.

```ts
interface HostContext {
  host: "claude" | "codex";
  hostSessionId: string;
  hostTurnId?: string;
  runId: string;
  projectRoot: string;
  pluginRoot: string;
  dataRoot: string;
  configuredModel?: string;
  resolvedModel?: string;
  permissionMode?: string;
}
```

This is a conceptual contract. The implementation may split it into smaller validated objects, but these semantics must remain available.

### 7.2 KRYLO-owned run identity

The host session identifier is not the KRYLO run identifier.

A KRYLO run receives its own `runId`. Host session and turn IDs are metadata attached to that run. This allows one KRYLO run to contain native agents and an external advisory worker without treating the external host session as another independent KRYLO run.

The state model must distinguish at least:

```text
runId
host
hostSessionId
hostTurnId optional
parentRunId optional
externalWorker boolean
delegationDepth integer
```

### 7.3 Data-root resolution

- Claude plugin runs continue to use the platform-provided Claude plugin data directory.
- Codex plugin runs use the platform-provided Codex `PLUGIN_DATA` directory.
- Standalone Codex Skill runs use a KRYLO-owned local data directory resolved by portable Node.js code. The default fallback is `path.join(os.homedir(), ".krylo", "data")` unless a KRYLO launcher explicitly supplies a different owned path.
- Runtime state must never be stored in the application repository by default.
- Cross-harness workers do not share a writable persistent state directory with the primary host. They receive only the minimum parent-run metadata necessary for their advisory task.

A standalone-data setup must create only KRYLO-owned paths and must not overwrite an unknown existing path without an ownership check.

## 8. Claude Code Host

The Claude surface remains backward compatible.

### 8.1 Public interface

```text
/krylo:run <task>
```

The optional personal `/krylo` wrapper remains a Claude-specific convenience alias and retains its existing ownership, dry-run, backup, and rollback rules.

### 8.2 Hooks

ADR-0021 remains valid for Claude:

- KRYLO runtime hooks remain declared in the `run` Skill frontmatter.
- Plugin-wide `hooks/hooks.json` remains empty unless future Claude platform behavior requires a superseding ADR.
- Ordinary Claude sessions that do not activate `/krylo:run` must not launch KRYLO runtime hooks.

### 8.3 Host adapter

The Claude adapter translates Claude hook and session fields into host-neutral Core requests and converts Core decisions back into the current official Claude hook output contract.

Existing hook scripts may be refactored into transport adapters plus shared policy modules, but behavior must be regression-proven before native Codex work begins.

## 9. Codex Host

### 9.1 Codex CLI package

The preferred native Codex CLI distribution is a Codex plugin with:

```text
plugins/krylo/.codex-plugin/plugin.json
```

and Codex-specific Skill, agent, and hook paths that call shared Core code.

The intended public Skill name is:

```text
krylo-run
```

and the intended explicit user experience is:

```text
$krylo-run <task>
```

The Skill must disable implicit invocation using the current official Codex Skill invocation-policy mechanism. If current official Codex syntax changes before implementation, the Skill name remains `krylo-run`; an equivalent explicit invocation syntax may be adopted without changing Core. Renaming the public Skill requires a reviewed public-interface change.

### 9.2 Packaging verification gate

The repository may contain both `.claude-plugin` and `.codex-plugin` manifests under the KRYLO bundle only if current official Codex local-marketplace and installation behavior proves that layout works without copying or escaping plugin-root boundaries.

Before implementing a final package layout, the implementation must perform a clean local Codex marketplace/install smoke test against the supported Codex version. If the same-root package is unsupported, use the smallest packaging wrapper that references or packages the shared Core without maintaining a second copy of Core source.

Do not invent an unsupported `codex plugin validate` command. If a current official validator exists, use it. Otherwise use documented manifest checks and official local marketplace installation/smoke behavior.

### 9.3 Codex hook adapter

Codex hooks are transport, not policy.

The adapter must:

- Parse the current Codex hook input schema.
- Normalize `session_id`, optional `turn_id`, `cwd`, `model`, and `permission_mode` into HostContext fields.
- Normalize `Bash`, `apply_patch`, MCP, and other supported local function tools into the Core tool-risk classifier.
- Map `apply_patch` aliases without pretending that the input tool name is a Claude `Edit` or `Write` call.
- Return Codex-native `PreToolUse` deny output using the current supported `hookSpecificOutput.permissionDecision = "deny"` contract or another currently documented blocking contract.
- Never return unsupported Codex `PreToolUse` fields such as `continue: false` as a security decision.
- Treat hosted-tool hook gaps as an enforcement limitation and keep the risk gate documented as defense in depth.
- Keep output concise and free of secrets because large hook output can be persisted by the host.

The Core may return a host-neutral decision such as:

```ts
type GateDecision =
  | { action: "pass" }
  | { action: "deny"; reason: string }
  | { action: "require-approval"; approvalClass: string; reason: string };
```

Each host adapter is responsible for representing that decision safely within its host's current capabilities.

## 10. Codex VS Code bridge

### 10.1 Constraint

The Codex IDE extension currently supports standalone Skills but not Codex plugins. Therefore full KRYLO in VS Code cannot rely on plugin installation alone.

### 10.2 Standalone Skill

A user-level Skill may be installed under the current Codex user Skill location, normally:

```text
$HOME/.agents/skills/krylo-run/
```

It includes the KRYLO Codex run instructions and the minimum deterministic launcher/runtime files needed for standalone use, or references an explicitly installed KRYLO-owned runtime location. It must set implicit invocation to false.

KRYLO setup must detect an existing `krylo-run` Skill and refuse to overwrite unknown ownership.

### 10.3 Full enforcement requires project setup

A standalone Skill without the required project hook layer is not considered a fully enforced autonomous KRYLO run.

When the Skill is present but project hooks are absent or untrusted, KRYLO may:

- run read-only diagnostics;
- explain the missing enforcement layer;
- produce a setup dry-run.

It must not silently downgrade to an autonomous run with missing risk or completion enforcement.

### 10.4 Project-scoped hooks

Full VS Code support uses a trusted repository Codex configuration layer, preferably:

```text
<repo>/.codex/hooks.json
```

Setup must:

1. inspect existing `.codex` configuration;
2. produce a dry-run plan;
3. identify the exact KRYLO-owned hook definitions and commands;
4. preserve unrelated user/project hooks;
5. use current Codex `commandWindows` support or an equivalent documented Windows-safe form where necessary;
6. create a backup before replacing KRYLO-owned older configuration;
7. refuse ambiguous ownership or unsafe semantic merge;
8. apply only after explicit user approval;
9. record enough ownership metadata for upgrade and uninstall;
10. provide a deterministic rollback path.

Project hook commands must not embed a machine-specific absolute path in shareable repository configuration. For the standard standalone bridge, setup should resolve the KRYLO runtime from the documented user Skill location through a portable environment-derived command and a Windows-specific `commandWindows` form where required. If current Codex command expansion cannot make that portable and deterministic, setup may install a thin KRYLO-owned launcher under the project `.codex/` directory, but it must not copy or fork Core policy source. The implementation must prove the chosen path on Windows, macOS, and Linux before full VS Code support is considered complete. Setup may not insert untrusted repository text into a shell command. It must report whether the project configuration is tracked or untracked and must not modify `.gitignore` automatically.

### 10.5 Hook trust

KRYLO must not bypass Codex hook review. New or changed KRYLO hooks must remain subject to Codex's exact-definition hash trust process.

If an upgrade changes hook definitions, the user must review the changed hooks through Codex's normal trust flow before they run.

### 10.6 Ordinary Codex sessions

Codex project/plugin hooks may be invoked even when KRYLO itself is not active. Every KRYLO Codex hook therefore requires a fast inactive-run path:

```text
hook fires
  -> resolve session identity
  -> no active KRYLO run for this session
  -> exit 0 with no state mutation and no model-visible output
```

The inactive path must not start Orbit, create telemetry records, perform tool classification beyond the minimum activation lookup, or change host behavior.

A performance test must establish an explicit no-op latency budget before release. The implementation plan must choose the numeric threshold after measuring the current local baseline on supported platforms rather than inventing an unmeasured threshold in this design.

## 11. Agent roles and model routing

### 11.1 Logical roles belong to Core

KRYLO continues to define logical roles such as:

- scout
- builder
- verifier
- reviewer
- security-reviewer
- architect
- design-reviewer
- product-strategist
- migration-reviewer
- ai-eval-engineer
- performance-reviewer
- deep-debugger

The role definition owns purpose, write capability, expected evidence, and independence requirements.

### 11.2 Vendor model names do not belong to Core

The Core asks for capabilities such as:

```text
role = reviewer
writeAccess = false
reasoningClass = high
```

The Claude host may map that request to its current supported Claude aliases. The Codex host maps the request to current available Codex model, reasoning, and sandbox capabilities after runtime capability detection.

The Core must not infer a resolved model from an agent name and must not hard-code current Codex model slugs.

### 11.3 One-writer rule

The native host's Builder remains the normal application-code writer for a KRYLO run. Independent verification and review remain read-only with respect to product code.

Cross-harness workers are not Builders in KRYLO 0.2.

## 12. Cross-Harness advisory workers

### 12.1 Transport choice

Use existing host CLIs rather than a new daemon or mandatory SDK:

```text
Claude-hosted KRYLO -> codex exec
Codex-hosted KRYLO  -> claude -p
```

This keeps dependencies small, reuses user-managed authentication, and allows the feature to degrade gracefully when the other CLI is absent.

### 12.2 Initial eligible roles

Cross-harness delegation is limited to read-only advisory work such as:

- scout
- reviewer
- security-reviewer
- deep-debugger
- other explicitly read-only analysis roles approved by policy

The following are prohibited in the initial release:

- builder
- deployment operator
- release operator
- merge/push operator
- secret-management operator
- financial or production-write operator

### 12.3 Invocation policy

KRYLO should request an external worker only when expected value justifies latency and data-egress cost, for example:

- security-sensitive changes;
- architectural changes;
- difficult repeated debugging failures;
- conflicting evidence;
- migration review;
- large or high-risk diff review;
- explicit user request.

A small low-risk patch should not automatically invoke a second provider.

### 12.4 Read-only enforcement

Codex external workers use `codex exec` with the read-only sandbox by default. Do not opt into `workspace-write` for initial cross-harness roles.

Claude external workers use `claude -p` with an explicit read-only tool allowlist. Shell and write-capable tools are excluded by default. The exact current Claude tool names must be verified against the supported CLI before release.

External workers must not receive broad MCP toolsets by default.

### 12.5 Structured worker result

Both external hosts return the same logical result schema:

```ts
interface ExternalWorkerResult {
  status: string;
  summary: string;
  evidence: unknown[];
  filesInspected: string[];
  filesModified: string[];
  commandsObserved: string[];
  findings: unknown[];
  risks: unknown[];
  unresolvedItems: unknown[];
  recommendedNextAction: string;
}
```

For an initial read-only worker, `filesModified` must be empty. A non-empty value is a policy violation and the result is rejected as trusted advisory evidence.

Codex uses `--output-schema` or the current equivalent. Claude uses `--json-schema` or the current equivalent. Schema validation is performed again by KRYLO after process exit.

### 12.6 Authority boundary

An external worker may report an opinion such as "review passed" inside its advisory summary, but it has no authority to:

- consume a KRYLO risk approval;
- create a KRYLO approval;
- set `VERIFIED_COMPLETE`;
- override the native verifier;
- override the deterministic completion gate;
- mutate the KRYLO tool trust registry;
- initiate another cross-harness delegation.

Only the Shared Core decides whether evidence satisfies the KRYLO completion contract.

### 12.7 Recursion prevention

Every external invocation carries bounded delegation metadata equivalent to:

```text
KRYLO_EXTERNAL_WORKER=1
KRYLO_PARENT_RUN_ID=<runId>
KRYLO_DELEGATION_DEPTH=1
```

The exact transport may use environment variables plus validated structured invocation metadata.

Rules:

- Native run starts with delegation depth `0`.
- An external worker runs at depth `1`.
- Any cross-harness request at depth `1` is deterministically denied.
- The external-worker role instructions also forbid further KRYLO delegation, but prompt text is not the primary control.
- Claude's KRYLO run Skill remains non-model-invokable.
- Codex's KRYLO Skill remains implicit-invocation disabled.

A recursive-delegation test is release-blocking.

### 12.8 Availability and credentials

KRYLO detects whether the external CLI exists, is compatible, and is already authenticated. KRYLO does not ask the user to paste API keys into KRYLO configuration and does not copy host auth files.

If the external harness is unavailable, unauthenticated, incompatible, times out, or returns invalid structured output:

- record a safe advisory failure;
- continue using native KRYLO if the task can proceed safely;
- do not weaken verification or approval rules to compensate.

## 13. Data egress and privacy for cross-harness use

Sending repository context from one model provider to another is data egress and must be treated explicitly.

### 13.1 Default policy

- Public repository context may be eligible under a policy profile that already permits public-repository external reads.
- Private repository context requires an explicit project/run policy that permits sending the required code context to the second provider.
- Production data, secrets, credentials, identity material, and sensitive personal data are denied unless a separately defined high-risk policy explicitly permits the exact transfer. The initial design does not require such a policy.

### 13.2 Never transfer by default

Cross-harness context packing must exclude:

- `.env` and secret files;
- PATs, API keys, cookies, session tokens, and auth files;
- `~/.codex/auth.json` or equivalent host credentials;
- Claude auth material;
- production database values;
- raw sensitive logs;
- KRYLO local telemetry containing user-specific metadata not required by the worker;
- unrelated source files.

### 13.3 Minimum context

The native KRYLO run prepares the smallest task-specific read-only context required for the advisory role. The external worker should inspect repository files directly only when the local sandbox and policy permit it, instead of receiving broad copied prompt payloads.

KRYLO telemetry must record only safe metadata that an external advisory worker was used, its host, role, status, timing, and safe evidence references. It must not persist the raw cross-provider prompt or raw model output.

## 14. Repository layout

Preferred logical layout:

```text
plugins/krylo/
|-- .claude-plugin/
|   `-- plugin.json
|-- .codex-plugin/
|   `-- plugin.json
|-- skills/                    # existing Claude surface
|-- agents/                    # existing Claude agent files
|-- codex/
|   |-- skills/
|   |-- agents/
|   `-- hooks/
|-- scripts/
|   |-- lib/
|   |-- runtime/
|   |-- orbit/
|   |-- security/
|   `-- host/
|       |-- claude/
|       `-- codex/
|-- schemas/
|-- policies/
|-- catalog/
|-- adapters/
|-- references/
`-- tests/
```

This is a target boundary, not a mandate for a large file-move refactor. Implementation should move or split only files whose current host coupling blocks the next phase. Unrelated refactoring is out of scope.

If official Codex packaging requires a separate wrapper directory, the wrapper may be added outside `plugins/krylo/`, but it must consume the same Core implementation and must not fork policy source.

## 15. Upstream maintenance subsystem

### 15.1 Purpose

Existing reviewed external integrations can drift after KRYLO reviews them. KRYLO needs early detection without automatically trusting new upstream state.

### 15.2 Weekly Upstream Watch

Add a scheduled GitHub Actions workflow with manual dispatch support.

Properties:

- cadence: weekly;
- GitHub-hosted ephemeral runner;
- `permissions: contents: read` unless a future ADR explicitly authorizes more;
- checkout with persisted credentials disabled;
- no user workstation or permanent daemon required;
- no candidate code execution;
- no repository writes;
- no automatic pull request or issue creation.

Initial watched integrations include:

- `mattpocock/skills`;
- OmniRoute;
- code-review-graph;
- Superpowers when an exact reviewed source can be identified;
- OpenWiki provider integration when applicable;
- future reviewed external Skills, Plugins, MCP servers, and tools.

### 15.3 Trusted review data versus observed upstream data

`plugins/krylo/catalog/tools.json` remains the trusted record of what KRYLO has reviewed.

Add a separate watch-policy catalog such as:

```text
plugins/krylo/catalog/upstream-watch.json
```

It stores watch configuration, not automatically trusted latest state. Example conceptual record:

```json
{
  "id": "mattpocock-skills",
  "source": "https://github.com/mattpocock/skills",
  "reviewedRefSource": "tools.json",
  "cadence": "weekly",
  "riskClass": "medium",
  "watch": [
    "skill-list",
    "hooks",
    "plugin-manifests",
    "package-lifecycle",
    "license"
  ]
}
```

The scheduled run computes `observedLatestRef` at runtime and compares it with the trusted `reviewedVersion` or `reviewedCommit`. Because the scheduled workflow is read-only, `observedLatestRef` is emitted to the Job Summary and scan artifact rather than committed back to the repository.

This separation avoids a security contradiction in which an unreviewed upstream reference becomes persistent trusted repository state through scheduled automation.

### 15.4 Drift analysis

If no upstream change is detected, the workflow reports healthy/no-drift and exits.

If a new upstream ref exists, static analysis examines only the relevant delta and metadata, including:

- Skill inventory changes;
- hooks added or changed;
- MCP tool inventory and write capability changes;
- permissions or credential scope changes;
- network destination changes;
- install/lifecycle scripts;
- dependency changes;
- data-egress behavior;
- license changes;
- new generated binaries or download behavior;
- blocked or security-sensitive versions.

The workflow must treat upstream file contents, commit messages, package metadata, and documentation as untrusted data.

### 15.5 Prohibited scheduled behavior

The weekly workflow must not run:

- `npm install` against a candidate;
- `npx` from a candidate package;
- `pip install` against a candidate;
- candidate shell scripts;
- candidate postinstall/preinstall hooks;
- candidate MCP servers;
- candidate plugin hooks;
- candidate build systems;
- any command copied from upstream documentation.

### 15.6 Review result

The workflow output classifies drift as one of:

```text
NO_DRIFT
DRIFT_LOW_RISK
REVIEW_REQUIRED
SECURITY_REVIEW_REQUIRED
SOURCE_UNAVAILABLE
```

A changed upstream version is never promoted into `tools.json` by this workflow.

A deep re-review is a separate human-initiated process against an exact source and exact version or commit.

## 16. Monthly Ecosystem Radar

### 16.1 Purpose

The Radar looks for new tools that materially improve KRYLO instead of accumulating integrations for novelty.

### 16.2 Execution

Add a monthly GitHub Actions workflow with manual dispatch support.

It remains read-only and uses no mandatory paid discovery API. It may use:

- public GitHub search/API reads;
- official Anthropic/Claude public ecosystem sources;
- official OpenAI/Codex public ecosystem sources;
- official vendor repositories;
- reviewed publisher repositories;
- public high-signal Skill registries or indexes that pass source-policy review.

If a source has no stable public interface, the workflow skips it rather than scraping through brittle or credentialed behavior.

### 16.3 Candidate categories

The Radar considers:

- Claude Code Skills and Plugins;
- Codex Skills and Plugins;
- MCP servers;
- repository/code intelligence;
- testing and evaluation tooling;
- security tooling;
- context management;
- review and debugging workflows;
- browser/design workflows;
- agent-development utilities.

Competing orchestration frameworks may be researched for ideas but cannot control KRYLO.

### 16.4 Scoring

Candidate prioritization uses a transparent score, for example:

| Dimension | Maximum |
| --- | ---: |
| Engineering value | 20 |
| KRYLO architectural fit | 15 |
| Security and least privilege | 15 |
| Maintenance activity | 10 |
| Testing and CI quality | 10 |
| Cross-platform support | 10 |
| Claude and Codex compatibility | 10 |
| License and provenance | 5 |
| Dependency footprint | 5 |
| Total | 100 |

Risk penalties include material deductions for:

- automatic user-config mutation;
- broad secret access;
- unexplained source-code egress;
- uncontrolled external writes;
- install lifecycle scripts;
- unbounded orchestration;
- remote-code execution or unsafe downloads;
- unclear licensing;
- abandoned maintenance;
- excessive dependency footprint.

The score is a triage tool, not a trust decision.

### 16.5 Radar output

Each candidate is classified as:

```text
REJECT
WATCH
AUDIT_RECOMMENDED
```

Output contains:

- exact source;
- observed version/commit where available;
- publisher/provenance;
- license;
- maintenance signal;
- relevant capabilities;
- overlap with current KRYLO integrations;
- security and supply-chain concerns;
- data-egress concerns;
- rationale for the recommendation.

The scheduled Radar does not install, execute, branch, commit, open a PR, merge, tag, release, publish, or change the trust catalog.

## 17. Deep audit process

A future manual deep-audit workflow may be added after the scheduled maintenance workflows are stable.

Its input must include an exact candidate source and exact version/commit. It starts read-only and static. Any sandboxed execution of candidate code, if ever justified, requires a separate security design and explicit approval.

A deep audit may use Claude and Codex as independent reviewers. Their findings are advisory evidence. If they disagree materially, the result is `REVIEW_CONFLICT` and requires maintainer review. KRYLO does not automatically choose the more permissive answer.

Promotion into `tools.json` requires normal repository review and the existing security-owner governance requirements.

## 18. CI and compatibility policy

### 18.1 Preserve deterministic release gates

The existing Claude compatibility policy remains deterministic:

- a pinned supported Claude Code floor gates PRs/releases;
- a separate weekly current-version job is a non-gating drift signal;
- CI never silently advances the minimum supported version.

### 18.2 Generalize the pattern to Codex

Codex receives the same two-track policy after a supported pinned version and official validation/smoke procedure are verified:

1. pinned supported Codex version for deterministic PR/release compatibility;
2. weekly current Codex compatibility check that does not gate PRs/releases.

The Codex compatibility workflow must never invent a validator command. If no official strict validator exists, the pinned check uses the documented manifest/schema rules plus an official local marketplace install and representative smoke test.

### 18.3 Platform matrix

Keep the current full test coverage on Ubuntu and Windows for Node 22/24. Add a focused macOS Node 24 platform compatibility job so the explicit macOS product guarantee receives hosted evidence without multiplying the entire matrix.

### 18.4 Required new test categories

Add or extend tests for:

- HostContext normalization and validation;
- KRYLO-owned `runId` independent of host session IDs;
- run-state schema migration if HostContext fields affect persisted state;
- Claude adapter parity with pre-refactor behavior;
- Codex hook input normalization;
- Codex `PreToolUse` safe deny output;
- Codex unsupported-output regression, proving security logic never returns unsafe unsupported fields;
- Codex `apply_patch` and MCP classification;
- inactive Codex hook no-op behavior and measured latency;
- Codex project setup dry-run;
- install, upgrade, uninstall, rollback, and unknown-ownership refusal;
- semantic preservation of existing `.codex` config;
- Windows `commandWindows` or equivalent behavior;
- standalone data-root ownership and path traversal/symlink defenses;
- external-worker structured output validation;
- external-worker non-empty `filesModified` rejection;
- cross-harness delegation-depth enforcement;
- cross-harness unavailable/auth-failure graceful degradation;
- data-egress secret/path exclusions;
- one-writer rule with external workers;
- weekly watch static-only behavior;
- untrusted upstream metadata cannot become a shell command;
- reviewed-versus-observed ref separation;
- monthly Radar scoring determinism;
- scheduled workflow permissions remain read-only;
- version consistency across release manifests when 0.2.0 is prepared;
- Linux, Windows, and macOS path/process behavior.

### 18.5 Security and release validation

Existing action pinning, secret scanning, CodeQL/SAST, dependency scanning, SBOM, checksum, and attestation expectations remain in force. Scheduled workflows must also use SHA-pinned GitHub Actions and `persist-credentials: false`.

## 19. Versioning and release boundaries

### 19.1 One product version

KRYLO has one product version across host surfaces. Release preparation must keep consistent versions across:

- Claude plugin manifest;
- Claude marketplace metadata;
- Codex plugin manifest;
- root workspace/package metadata where versioned;
- changelog and release documentation;
- release artifacts.

Do not maintain independent Claude and Codex KRYLO version lines.

### 19.2 Target release

The recommended capability release is `0.2.0` because adding a second first-class host is a significant backward-compatible capability change in the pre-1.0 product line.

The version is not bumped during early Core extraction. It is bumped only in release preparation after the feature set is validated.

### 19.3 Separate publication approvals

Treat these as separate external-write gates:

1. create/publish a GitHub Release;
2. publish/update the Claude marketplace surface;
3. submit/publish to the OpenAI universal plugin directory.

Authorization for one does not imply authorization for another. Merge to `main` is not authorization to publish to OpenAI or Anthropic marketplaces.

The existing manual release workflow structure remains the preferred foundation. It may prepare and create a draft GitHub release only under the repository's existing explicit release gate.

## 20. Migration strategy

### Phase 1: Architecture and ADRs

- Add accepted ADRs for the new product architecture.
- Update product/architecture/security documentation to describe both hosts.
- Do not change runtime behavior yet.

### Phase 2: Host-neutral Core extraction

- Introduce HostContext and KRYLO-owned run identity.
- Split shared policy from Claude hook transport.
- Keep `/krylo:run` behavior unchanged.
- Run all existing Claude tests plus new parity tests before continuing.

Exit criterion: Claude behavior is proven equivalent enough to proceed. A regression blocks Codex work.

### Phase 3: Native Codex CLI host

- Add Codex packaging.
- Add explicit `krylo-run` Skill.
- Add Codex host adapter and hooks.
- Add Codex agents/model capability mapping.
- Validate through the current official local-marketplace path.

### Phase 4: Codex VS Code bridge

- Add standalone Skill setup.
- Add explicit project-hook setup with dry-run/backup/ownership/rollback.
- Refuse full autonomous mode when enforcement is missing.
- Verify Windows, macOS, and Linux paths.

### Phase 5: Cross-Harness advisory workers

- Add `codex exec` advisory worker from Claude host.
- Add `claude -p` advisory worker from Codex host.
- Enforce read-only roles and depth one.
- Add egress gating and structured result validation.

### Phase 6: Weekly Upstream Watch

- Add watch-policy catalog.
- Add read-only scheduled workflow.
- Add deterministic drift report artifact.

### Phase 7: Monthly Ecosystem Radar

- Add read-only discovery adapters and scoring.
- Add monthly summary artifact.

### Phase 8: Full review

- Run complete security, privacy, supply-chain, compatibility, setup, rollback, and cross-platform verification.
- Perform independent review of host parity and trust boundaries.

### Phase 9: 0.2.0 release candidate

- Align version references.
- Update changelog/release readiness.
- Produce release evidence.
- Stop before push, merge, tag, release publication, Claude marketplace publication, OpenAI directory publication, deployment, production access, or other external write unless explicitly authorized.

## 21. Rollback strategy

Rollback is capability-layered so a Codex problem does not require reverting the Claude product.

### 21.1 Claude rollback

If Core extraction introduces a Claude regression, revert or fix the Core extraction before proceeding. Do not ship Codex as a reason to accept weaker Claude guarantees.

### 21.2 Codex native rollback

Codex host packaging can be disabled or removed while leaving Shared Core and Claude Code intact. No run-state migration may make existing Claude state unreadable without a backward reader or backup.

### 21.3 VS Code rollback

Setup must be able to:

- remove only KRYLO-owned standalone Skill files;
- remove only KRYLO-owned project hook entries/files;
- restore backed-up KRYLO-owned previous configuration where requested;
- leave unrelated `.codex` and Skill configuration untouched.

### 21.4 Cross-harness rollback

Cross-harness adapters are optional. They can be disabled by policy without changing native-host behavior or run-state validity.

### 21.5 Maintenance rollback

Scheduled maintenance workflows are non-authoritative. They can be disabled without changing runtime trust or existing reviewed integrations.

## 22. Security invariants

The following are release-blocking invariants:

1. External content cannot alter KRYLO policy merely by being read.
2. Unknown or drifted external tools are not automatically trusted.
3. A scheduled workflow cannot promote an observed upstream ref into a trusted reviewed ref.
4. A scheduled discovery workflow cannot execute candidate code.
5. KRYLO does not persist raw prompts, source code, secrets, raw commands, database values, or sensitive tool output in telemetry.
6. Risk approvals remain scoped, expiring, project-bound, run-bound, target-bound, atomic, and single-use.
7. Cross-harness workers cannot consume or create risk approvals.
8. Cross-harness delegation depth cannot exceed one.
9. Cross-harness workers cannot be the normal Builder in 0.2.0.
10. Only one normal application-code writer operates in a worktree.
11. Codex hook schema differences are handled by a Codex-specific adapter, not by reusing Claude output blindly.
12. Hosted-tool hook gaps are documented and cannot be presented as sandbox enforcement.
13. Missing Codex VS Code hooks cannot silently downgrade full KRYLO into a weaker autonomous mode.
14. Setup cannot silently overwrite user or project configuration.
15. Production, destructive, financial, identity, secret, release, merge, push, deployment, messaging, and other external-write actions remain human-gated.
16. Marketplace publication remains separate from code merge or GitHub release approval.

## 23. ADR plan

The implementation should add the following ADRs, using the repository ADR template and explicit supersession links.

### ADR-0023: Multi-host product and shared Core

Decision:

- Claude Code and Codex are equal first-class KRYLO hosts.
- KRYLO has one Shared Core and host-specific adapters.
- KRYLO owns run identity independent of host session identity.
- KRYLO has one product version.

Supersession/impact:

- Supersedes the Claude-only scope of ADR-0001 while preserving the GitHub/Claude marketplace decision for the Claude host.
- Narrows ADR-0002 to the Claude public command surface.
- Narrows ADR-0006 to Claude host model routing until the model-routing document is generalized.
- Extends ADR-0009 from "not the default Claude agent" to "not the default orchestrator on either host".

### ADR-0024: Codex packaging and project-scoped enforcement

Decision:

- Codex CLI uses the native Codex plugin surface when validated.
- Codex IDE uses a standalone explicit-only Skill because plugins are not supported there.
- Full VS Code KRYLO requires explicit project-scoped hooks.
- Codex hooks use a host-specific adapter and inactive-run no-op path.
- Setup follows dry-run, ownership, backup, explicit approval, and rollback rules.

Impact:

- Extends ADR-0013.
- Does not supersede ADR-0021, which remains Claude-specific.

### ADR-0025: Cross-harness advisory workers

Decision:

- Use `codex exec` and `claude -p` rather than a mandatory SDK/daemon.
- Initial external roles are read-only.
- No cross-harness Builder.
- Maximum delegation depth is one.
- Shared Core remains completion and approval authority.
- Cross-provider context is policy-gated data egress.

Impact:

- Extends ADR-0014 and the data-egress/tool-governance policies.

### ADR-0026: Upstream maintenance and ecosystem discovery

Decision:

- Weekly upstream drift detection and monthly ecosystem discovery run in read-only GitHub Actions.
- Reviewed/trusted refs remain separate from observed upstream refs.
- No automatic install, execution, trust, PR, merge, release, or publication.

Impact:

- Extends ADR-0008 tool trust governance and existing supply-chain controls.

### ADR-0027: Multi-host compatibility policy

Decision:

- Preserve the existing pinned Claude floor and weekly current-version signal.
- Apply the same deterministic-floor/non-gating-current pattern to Codex after official install/validation behavior and a supported pin are verified.
- CI never auto-advances either host's compatibility floor.

Supersession:

- Supersedes ADR-0022 by generalizing it, while explicitly retaining its current Claude floor until a separate reviewed compatibility decision changes it.

## 24. Documentation impact

At minimum, implementation must review and update affected portions of:

- `CLAUDE.md`, keeping it at or below 130 physical lines;
- `README.md`;
- `PRODUCT_SPEC.md`;
- `ARCHITECTURE.md`;
- `SECURITY.md`;
- `THREAT_MODEL.md`;
- `docs/01-command-surface.md`;
- `docs/02-runtime-state-machine.md`;
- `docs/04-agent-system.md`;
- `docs/05-model-routing.md`;
- `docs/07-hooks-and-observability.md`;
- `docs/09-tool-governance.md`;
- `docs/10-data-egress.md`;
- `docs/11-integration-adapters.md`;
- `docs/12-testing-and-evals.md`;
- `docs/17-distribution-and-release.md`;
- `docs/18-setup-and-alias.md`;
- `docs/19-backward-compatibility.md`;
- `docs/20-definition-of-done.md`;
- `docs/21-public-api-and-schemas.md`;
- `docs/22-privacy-and-telemetry.md`;
- `docs/23-versioning-and-governance.md`;
- `docs/24-implementation-roadmap.md`;
- `RELEASE_READINESS.md` when compatibility/release criteria change;
- `CHANGELOG.md` during release preparation.

Do not mechanically rewrite documents that are unaffected. Preserve historical ADR text and supersede decisions rather than editing accepted history to hide it.

## 25. Definition of done for the architecture

The multi-host feature is ready for a 0.2.0 release candidate only when all applicable statements below have evidence:

- Existing Claude `/krylo:run` behavior remains compatible.
- Claude Skill-scoped hook isolation remains intact.
- Shared Core has no direct dependency on Claude-only session/model/hook fields.
- Codex CLI can install and invoke KRYLO through a documented supported path.
- Codex `krylo-run` is explicit-only.
- Codex risk-gate deny behavior is validated against the current official hook schema.
- Codex ordinary-session inactive hooks are no-op and measured.
- Codex VS Code setup is dry-run-first, ownership-safe, reversible, and refuses weakened full runs.
- One-writer behavior is preserved.
- Cross-harness workers are read-only, schema-validated, depth-one, and non-authoritative.
- Cross-harness data egress is policy-gated and secret-exclusion tests pass.
- External-harness failure degrades safely without weakening completion.
- Weekly upstream watch detects known synthetic drift without executing candidate code.
- Monthly Radar produces deterministic candidate classifications from fixture data and uses read-only permissions.
- Scheduled workflows cannot modify repository contents or trust state.
- Linux and Windows full test expectations remain satisfied and macOS receives hosted compatibility coverage.
- Host compatibility floors are deterministic and separately monitored for current-version drift.
- Version references are consistent for the release candidate.
- Security, supply-chain, install, upgrade, uninstall, rollback, and final-diff reviews are complete.
- GitHub-hosted CI status is distinguished from local verification in the final report.
- No push, merge, tag, release, marketplace publication, deployment, production access, or external write occurs without explicit authorization.

## 26. Implementation planning constraints

The implementation plan that follows this design must:

1. Re-verify repository branch, HEAD, working tree, and current official Claude/Codex documentation before edits.
2. Use a feature branch for substantial changes and preserve unrelated work.
3. Avoid `git reset --hard`, silent stashing, and published-history rewrites.
4. Use tests with each implementation phase rather than deferring all tests to the end.
5. Complete Phase 2 Claude parity before Phase 3 Codex implementation.
6. Treat exact Codex packaging, hook schemas, and supported CLI validation commands as platform contracts to verify, not assumptions.
7. Add or supersede ADRs before landing architecture-dependent code.
8. Keep dependencies minimal and justify any new dependency explicitly.
9. Prefer portable Node.js ESM and exec-form child processes with argument arrays.
10. Never weaken tests or security rules merely to make the implementation pass.
11. Include independent verifier, reviewer, and security-reviewer evidence for high-risk phases.
12. Stop before push, merge, tag, release, publication, deployment, production changes, or any other external write unless the user has explicitly authorized that action.

## 27. Explicitly deferred items

These are intentionally outside the 0.2.0 core scope and are not unresolved design placeholders:

- Cross-harness application-code Builder support.
- Parallel writable workers across multiple worktrees.
- A standalone KRYLO daemon or server.
- Mandatory Codex SDK integration.
- Automatic deep execution of discovered candidate tools.
- Automatic PR creation from weekly/monthly maintenance workflows.
- Automatic marketplace publication.
- Central KRYLO cloud telemetry or analytics.
- Production write automation.

Any future proposal for these capabilities requires its own threat review and, where architectural, a new ADR.

## 28. Design review checklist

This specification has been checked for the following:

- No placeholder or incomplete requirements remain.
- Existing Claude behavior is explicitly preserved before Codex rollout.
- Codex plugin and IDE capabilities are not conflated.
- Codex hook output is not assumed to be Claude-compatible.
- The weekly watch remains read-only even though it reports observed latest refs.
- Trusted reviewed refs are not automatically mutated by scheduled automation.
- Cross-harness recursion and authority boundaries are explicit.
- Data-egress and credential boundaries are explicit.
- One-writer and independent-review principles remain intact.
- Rollback exists independently for Claude, Codex, VS Code setup, cross-harness, and maintenance workflows.
- Release and marketplace publication remain separate human approvals.
- The design is decomposed into phases small enough for implementation and review checkpoints.
