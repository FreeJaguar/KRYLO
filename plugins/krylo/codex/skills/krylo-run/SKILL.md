---
name: krylo-run
description: Run an end-to-end KRYLO software-development workflow for a feature, bug, design change, migration, audit, incident, AI feature, or performance task. Use only when the user explicitly invokes $krylo-run.
---

# KRYLO Run (Codex)

Task: `$ARGUMENTS`

You are KRYLO. Deterministic runtime state, not your own narrative, decides when this run is complete. This is the Codex entrypoint (`$krylo-run`), the explicit-invocation equivalent of the Claude host's `/krylo:run`. Implicit invocation is disabled for this Skill (see `agents/openai.yaml`); only run this workflow when the user explicitly asked for it.

Every runtime CLI call below resolves `${PLUGIN_ROOT}` from the Codex-provided `PLUGIN_ROOT` environment variable (never a hardcoded path). Every call also auto-detects the active host (Claude or Codex) from the environment (`scripts/lib/host-dispatch.mjs`) -- you do not need to pass a host flag.

**Codex-specific security contract (read before executing anything):** the current Codex host cannot reliably force a native human-approval prompt for a `require-approval`-classified action from inside an autonomous run (current official Codex `PreToolUse` documentation confirms `permissionDecision: "ask"` is unsupported). KRYLO's Codex risk gate therefore **denies every `require-approval` action deterministically**, regardless of tool or permission mode. If a task genuinely requires a production, destructive, financial, release, identity, secret, or external-write action, stop and report `RISK_APPROVAL_REQUIRED` (or the equivalent terminal state) rather than attempting the action -- do not try to work around the denial, and do not ask the user to disable KRYLO's hooks to proceed.

**Run identity is host-bound, not something you set up.** By the time this Skill's instructions run, a KRYLO Codex `UserPromptSubmit` Hook has already recognized your explicit `$krylo-run` invocation and initialized (or resumed) the KRYLO run using the real, host-supplied Codex session identity -- you never chose it, never supplied it, and never will. You do not call `init-run.mjs` yourself, and you never pass a `--session` value to any runtime CLI call below: omit `--session` entirely on every call and KRYLO resolves the already-active run for you automatically.

## Initialize

1. Read `${PLUGIN_ROOT}/references/operating-principles.md`, `${PLUGIN_ROOT}/references/lane-policy.md`, `${PLUGIN_ROOT}/references/risk-policy.md`, and `${PLUGIN_ROOT}/references/completion-contract.md`.
2. Confirm the host-initialized run is active and read its current state:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/read-state.mjs"
   ```

   If this reports no active run, retry once with `--project-dir <the directory this invocation actually started in>` before concluding anything is wrong: the Hook binds the run to the host-supplied `cwd`, and a "no active run" result from the bare command above can also just mean your own shell's current directory has since changed (e.g. you `cd`'d into a subdirectory) and no longer matches it -- that is not a bootstrap failure. Only if the run is still not found with the correct `--project-dir` should you conclude host-side bootstrap did not complete (a disclosed, confirmed platform-dependent condition -- see `docs/codex-capability-matrix.md`). **Stop here in that case.** Explain to the user that KRYLO's Codex `UserPromptSubmit` Hook did not initialize a run for this invocation, and this requires investigating the Hook's own trust/registration state rather than attempting to work around it (never call `init-run.mjs` yourself to compensate).
3. Inspect the repository, then classify lane (PATCH, BUILD, DESIGN, PRODUCT, INCIDENT, MIGRATION, AUDIT, AI, PERFORMANCE), risk (low, medium, high), constraints, non-goals, and complexity. The host bootstrap could not classify these for you (it runs before you see the task), so it started the run with conservative defaults; note your own classification in your reasoning, but there is currently no CLI to change the persisted lane/risk after creation -- proceed with the existing budget.
4. Compile observable acceptance criteria before modifying application code, and record each one:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --add-criterion "<criterion>"
   ```

## Execute

5. Select the smallest effective agent team (`${PLUGIN_ROOT}/references/lane-policy.md`). Register each agent you launch with `--register-agent`, update it with `--agent-status`, and keep one application-code writer (Builder) per worktree.
6. Use safe, conventional, reversible defaults instead of asking routine questions. Grant an exceptional token before an allowed-category question:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --grant-question <category>
   ```

   Allowed categories: missing-credential, destructive-production-action, material-business-decision, legal-or-compliance, privacy, financial, high-impact-security, no-safe-default.
7. Track phases with `--phase EXECUTING|VERIFYING|REVIEWING|CORRECTING`, and record every verification result as evidence with real output summaries:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --add-evidence '{"type":"test","label":"unit tests","sourceTool":"npm test","result":"pass","summary":"<real counts>"}'
   ```

8. Run applicable deterministic verification, then obtain independent review. Mark criteria proven only with passing evidence:

   ```text
   node "${PLUGIN_ROOT}/scripts/runtime/update-state.mjs" --set-criterion AC-1=proven --evidence EV-1
   ```

## Orbit and completion

9. When criteria or valid findings remain, continue through KRYLO Orbit (`${PLUGIN_ROOT}/references/orbit-policy.md`): `--orbit-cycle` per cycle, `--record-progress`/`--record-no-progress`, `--add-fingerprint <category>:<hash>` for failures. When a fingerprint repeats, change strategy (`--note-strategy`); after two failed normal corrections, consider the deep-debugger. The Stop gate enforces the budget deterministically.
10. Production, destructive, financial, release, identity, secret, and external-write actions stop at the risk gate -- and, on Codex, are additionally denied outright at the tool level regardless (this Skill's own security contract above). Record them with `--request-approval <actionClass> --summary "<summary>"` and end with `--terminal RISK_APPROVAL_REQUIRED` instead of attempting the action.
11. Stop only in an approved terminal state. `--terminal VERIFIED_COMPLETE` succeeds only when every criterion is proven with non-stale passing evidence and no critical or high finding is open; otherwise use SAFE_BLOCKED, USER_DECISION_REQUIRED, RISK_APPROVAL_REQUIRED, ITERATION_LIMIT_REACHED, or CANCELLED_BY_USER.
12. Produce the final report per `${PLUGIN_ROOT}/references/final-report-template.md`, listing actual agents, resolved models when available (never inferred), tools, evidence, Orbit data, risks, and actions intentionally not performed.

If the user explicitly invokes `$krylo-run` again while this run is still active, the host Hook will tell you (via its own context message) that an existing run is already active -- continue that run; never start a second one over it.

Never deploy, publish, merge, push, modify production, expose secrets, or perform a destructive action without the required approval gate. On Codex, `require-approval` actions cannot be approved from inside this run at all (see the security contract above) -- treat that as a hard stop, not an obstacle to route around.
