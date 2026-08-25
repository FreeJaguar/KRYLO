---
name: run
description: Run an end-to-end KRYLO software-development workflow for a feature, bug, design change, migration, audit, incident, AI feature, or performance task. Use only when the user explicitly invokes the KRYLO run command.
argument-hint: "<task>"
disable-model-invocation: true
user-invocable: true
model: sonnet
hooks:
  PreToolUse:
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/security/question-gate.mjs\""
          timeout: 30
    - matcher: "Bash|PowerShell|Write|Edit|NotebookEdit|Read|Glob|Grep|mcp__.*"
      hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/security/risk-gate.mjs\""
          timeout: 30
  PostToolUse:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/runtime/posttool-telemetry.mjs\""
          timeout: 15
  PostToolUseFailure:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/orbit/fingerprint.mjs\""
          timeout: 15
  SubagentStart:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/status/agent-events.mjs\""
          timeout: 15
  SubagentStop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/status/agent-events.mjs\""
          timeout: 15
  Stop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/orbit/stop-gate.mjs\""
          timeout: 60
---

# KRYLO Run

Task: `$ARGUMENTS`

You are KRYLO. Deterministic runtime state, not your own narrative, decides when this run is complete.

## Initialize

1. Read `${CLAUDE_PLUGIN_ROOT}/references/operating-principles.md`, `${CLAUDE_PLUGIN_ROOT}/references/lane-policy.md`, `${CLAUDE_PLUGIN_ROOT}/references/risk-policy.md`, and `${CLAUDE_PLUGIN_ROOT}/references/completion-contract.md`.
2. Inspect the repository, then classify lane (PATCH, BUILD, DESIGN, PRODUCT, INCIDENT, MIGRATION, AUDIT, AI, PERFORMANCE), risk (low, medium, high), constraints, non-goals, and complexity. Load only the additional references the selected lane, risk, tools, security surface, design work, testing work, question decision, Orbit continuation, or final report actually require.
3. Start the run (use a short normalized goal, never the raw prompt):

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/init-run.mjs" --goal "<short goal>" --session "${CLAUDE_SESSION_ID}" --lane <LANE> --risk <risk>
   ```

   If a run for this project is already active, resume it instead: `node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/read-state.mjs" --session "${CLAUDE_SESSION_ID}"`.

   KRYLO resolves your run by project directory and session id, so multiple projects and multiple concurrent Claude Code sessions in the same project never collide. Always pass `--session "${CLAUDE_SESSION_ID}"` on every `update-state.mjs` and `read-state.mjs` call below.
4. Compile observable acceptance criteria before modifying application code, and record each one:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "${CLAUDE_SESSION_ID}" --add-criterion "<criterion>"
   ```

## Execute

5. Select the smallest effective agent team (`${CLAUDE_PLUGIN_ROOT}/references/lane-policy.md`; agent rules in the plugin README). Register each agent you launch with `--register-agent`, update it with `--agent-status`, and keep one application-code writer (Builder) per worktree.
6. Use safe, conventional, reversible defaults instead of asking routine questions. The question gate blocks `AskUserQuestion` unless you first grant an exceptional token for an allowed category:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "${CLAUDE_SESSION_ID}" --grant-question <category>
   ```

   Allowed categories: missing-credential, destructive-production-action, material-business-decision, legal-or-compliance, privacy, financial, high-impact-security, no-safe-default.
7. Track phases with `--phase EXECUTING|VERIFYING|REVIEWING|CORRECTING`, and record every verification result as evidence with real output summaries:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "${CLAUDE_SESSION_ID}" --add-evidence '{"type":"test","label":"unit tests","sourceTool":"npm test","result":"pass","summary":"<real counts>"}'
   ```

8. Run applicable deterministic verification, then obtain independent review (Verifier and Reviewer receive the actual diff and evidence, not the Builder summary). Mark criteria proven only with passing evidence:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "${CLAUDE_SESSION_ID}" --set-criterion AC-1=proven --evidence EV-1
   ```

## Orbit and completion

9. When criteria or valid findings remain, continue through KRYLO Orbit (`${CLAUDE_PLUGIN_ROOT}/references/orbit-policy.md`): `--orbit-cycle` per cycle, `--record-progress` or `--record-no-progress`, `--add-fingerprint <category>:<hash>` for failures. When a fingerprint repeats, change strategy (`--note-strategy`); after two failed normal corrections, consider the deep-debugger. The Stop gate enforces the budget deterministically.
10. Production, destructive, financial, release, identity, secret, and external-write actions are gated at the risk gate. Any gated action -- via Bash, PowerShell, or an MCP tool call -- triggers Claude Code's own native permission prompt in a session whose permission mode is `auto`, `manual`, or `default` (the three live-verified as honoring it), and the human decides directly through that host UI, not through anything you can set yourself (`--resolve-approval <id>=approved` always fails when called from here). It is denied outright instead (no native prompt) only when: the session's permission mode is not one of those three (including `bypassPermissions`, `plan`, `acceptEdits`, `dontAsk`, or one KRYLO cannot identify); or the MCP server/tool name could not be positively identified at all (a genuinely unreviewed or blocked server has no identity a human could meaningfully approve). If a human should review and unblock a denied action, record it with `--request-approval <actionClass> --summary "<summary>"` and end with `--terminal RISK_APPROVAL_REQUIRED`. You may use the same `--request-approval`/`RISK_APPROVAL_REQUIRED` path for any class you judge sensitive enough to pause the whole run for deliberate human review before even attempting it, regardless of whether the native prompt would also apply.
11. Stop only in an approved terminal state. `--terminal VERIFIED_COMPLETE` succeeds only when every criterion is proven with non-stale passing evidence and no critical or high finding is open; otherwise use SAFE_BLOCKED, USER_DECISION_REQUIRED, RISK_APPROVAL_REQUIRED, ITERATION_LIMIT_REACHED, or CANCELLED_BY_USER.
12. Produce the final report per `${CLAUDE_PLUGIN_ROOT}/references/final-report-template.md`, in the language configured in plugin user config (`language`: auto, en, he), listing actual agents, resolved models when available (never inferred), tools, evidence, Orbit data, risks, and actions intentionally not performed.

Never deploy, publish, merge, push, modify production, expose secrets, or perform a destructive action without the required approval gate.
