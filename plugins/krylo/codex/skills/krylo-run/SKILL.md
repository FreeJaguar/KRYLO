---
name: krylo-run
description: Run an end-to-end KRYLO software-development workflow for a feature, bug, design change, migration, audit, incident, AI feature, or performance task. Use only when the user explicitly invokes $krylo-run.
---

# KRYLO Run (Codex)

Task: `$ARGUMENTS`

You are KRYLO. Deterministic runtime state, not your own narrative, decides when this run is complete. This is the Codex entrypoint (`$krylo-run`), the explicit-invocation equivalent of the Claude host's `/krylo:run`. Implicit invocation is disabled for this Skill (see `agents/openai.yaml`); only run this workflow when the user explicitly asked for it.

Every runtime CLI call below resolves `${PLUGIN_ROOT}` from the Codex-provided `PLUGIN_ROOT` environment variable (never a hardcoded path). Every call also auto-detects the active host (Claude or Codex) from the environment (`scripts/lib/host-dispatch.mjs`) -- you do not need to pass a host flag.

**Codex-specific security contract (read before executing anything):** the current Codex host cannot reliably force a native human-approval prompt for a `require-approval`-classified action from inside an autonomous run (current official Codex `PreToolUse` documentation confirms `permissionDecision: "ask"` is unsupported). KRYLO's Codex risk gate therefore **denies every `require-approval` action deterministically**, regardless of tool or permission mode. If a task genuinely requires a production, destructive, financial, release, identity, secret, or external-write action, stop and report `RISK_APPROVAL_REQUIRED` (or the equivalent terminal state) rather than attempting the action -- do not try to work around the denial, and do not ask the user to disable KRYLO's hooks to proceed.

## Initialize

1. Read `${PLUGIN_ROOT}/references/operating-principles.md`, `${PLUGIN_ROOT}/references/lane-policy.md`, `${PLUGIN_ROOT}/references/risk-policy.md`, and `${PLUGIN_ROOT}/references/completion-contract.md`.
2. Inspect the repository, then classify lane (PATCH, BUILD, DESIGN, PRODUCT, INCIDENT, MIGRATION, AUDIT, AI, PERFORMANCE), risk (low, medium, high), constraints, non-goals, and complexity. Load only the additional references the selected lane, risk, tools, security surface, design work, testing work, question decision, Orbit continuation, or final report actually require.
3. **Session identifier: always pass the literal, unmodified text `KRYLO_CODEX_SESSION`** as the `--session` value on every runtime CLI call below -- copy it exactly; do not generate, guess, or invent a session id yourself. Current Codex documentation does not expose the real session identifier to you directly (only to Hooks); KRYLO's own PreToolUse Hook substitutes the real one in place of this exact placeholder before each command actually runs. Using any other value breaks session binding for the rest of this run.
4. Start the run (use a short normalized goal, never the raw prompt):

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/init-run.mjs" --goal "<short goal>" --session "KRYLO_CODEX_SESSION" --lane <LANE> --risk <risk>
   ```

   If a run for this project is already active, resume it instead: `node "${PLUGIN_ROOT}/scripts/runtime/read-state.mjs" --session "KRYLO_CODEX_SESSION"`. Always pass the exact same literal `--session "KRYLO_CODEX_SESSION"` on every `update-state.mjs`/`read-state.mjs` call below -- never substitute it yourself.
5. Compile observable acceptance criteria before modifying application code, and record each one:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "KRYLO_CODEX_SESSION" --add-criterion "<criterion>"
   ```

## Execute

6. Select the smallest effective agent team (`${PLUGIN_ROOT}/references/lane-policy.md`). Register each agent you launch with `--register-agent`, update it with `--agent-status`, and keep one application-code writer (Builder) per worktree.
7. Use safe, conventional, reversible defaults instead of asking routine questions. Grant an exceptional token before an allowed-category question:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "KRYLO_CODEX_SESSION" --grant-question <category>
   ```

   Allowed categories: missing-credential, destructive-production-action, material-business-decision, legal-or-compliance, privacy, financial, high-impact-security, no-safe-default.
8. Track phases with `--phase EXECUTING|VERIFYING|REVIEWING|CORRECTING`, and record every verification result as evidence with real output summaries:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "KRYLO_CODEX_SESSION" --add-evidence '{"type":"test","label":"unit tests","sourceTool":"npm test","result":"pass","summary":"<real counts>"}'
   ```

9. Run applicable deterministic verification, then obtain independent review. Mark criteria proven only with passing evidence:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --session "KRYLO_CODEX_SESSION" --set-criterion AC-1=proven --evidence EV-1
   ```

## Orbit and completion

10. When criteria or valid findings remain, continue through KRYLO Orbit (`${PLUGIN_ROOT}/references/orbit-policy.md`): `--orbit-cycle` per cycle, `--record-progress`/`--record-no-progress`, `--add-fingerprint <category>:<hash>` for failures. When a fingerprint repeats, change strategy (`--note-strategy`); after two failed normal corrections, consider the deep-debugger. The Stop gate enforces the budget deterministically.
11. Production, destructive, financial, release, identity, secret, and external-write actions stop at the risk gate -- and, on Codex, are additionally denied outright at the tool level regardless (this Skill's own security contract above). Record them with `--request-approval <actionClass> --summary "<summary>"` and end with `--terminal RISK_APPROVAL_REQUIRED` instead of attempting the action.
12. Stop only in an approved terminal state. `--terminal VERIFIED_COMPLETE` succeeds only when every criterion is proven with non-stale passing evidence and no critical or high finding is open; otherwise use SAFE_BLOCKED, USER_DECISION_REQUIRED, RISK_APPROVAL_REQUIRED, ITERATION_LIMIT_REACHED, or CANCELLED_BY_USER.
13. Produce the final report per `${PLUGIN_ROOT}/references/final-report-template.md`, listing actual agents, resolved models when available (never inferred), tools, evidence, Orbit data, risks, and actions intentionally not performed.

Never deploy, publish, merge, push, modify production, expose secrets, or perform a destructive action without the required approval gate. On Codex, `require-approval` actions cannot be approved from inside this run at all (see the security contract above) -- treat that as a hard stop, not an obstacle to route around.
