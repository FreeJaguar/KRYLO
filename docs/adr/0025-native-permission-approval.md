# ADR-0025: Native host-controlled permission approval replaces KRYLO-APPROVE

## Status

Accepted

## Context

ADR-0024 introduced `scripts/security/human-approval-gate.mjs`, a `UserPromptSubmit` Hook that scanned a genuine top-level human chat message for an explicit `KRYLO-APPROVE <id>` / `KRYLO-DENY <id>` phrase, as the only path that could transition a risk approval from `pending` to `approved`. That ADR itself states the design's residual limitation plainly: it proves a confirmation phrase was present in a genuine top-level prompt submission, not that a human specifically typed it, and its own "Stated guarantee and residual scope" section says this should be revisited "if a future official Claude Code mechanism provides a stronger, documented human-authorization primitive."

Continuing the security-hardening review of the multi-host Foundation, a further look at official Claude Code documentation and the project's own CHANGELOG found exactly that primitive already exists and is more reliable than believed at the time ADR-0024 was written: `permissionDecision: "ask"` on a PreToolUse Hook puts a human-facing allow/deny prompt directly in Claude Code's own permission UI, at the moment of the actual tool-call attempt — not KRYLO-local state, not a chat-text convention the model could imitate or race, and not a second round-trip (request, wait for a human to type a phrase, retry) the way KRYLO-APPROVE required.

The reason ADR-0024 (and, earlier, `scripts/security/risk-gate.mjs`'s own header comment) did not simply use `ask` in the first place was a documented reliability concern: `anthropics/claude-code#39344` described `permissionDecision: "ask"` being silently overridden by other permission configuration, and this project's pinned compatibility floor (2.1.197, per ADR-0022) predated any fix. That reliability gap is now closed for the specific case KRYLO's risk gate depends on. This project's own verified CHANGELOG (`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, checked in full through the currently released version) states, for v2.1.211:

> Fixed auto mode overriding a PreToolUse hook's `ask` decision for unsandboxed Bash — a hook `ask` now floors the decision at a prompt

This is precisely the failure mode that made `ask` untrustworthy: "auto mode" (a real, commonly used Claude Code permission mode) could previously let a tool call proceed despite a hook saying `ask`, silently defeating the gate. From 2.1.211 onward, a hook's `ask` decision is documented to "floor" (take precedence over) that override — for the Bash tool.

That confirmation is explicitly scoped to Bash. The same CHANGELOG was searched in full for an equivalent statement covering PowerShell or any MCP tool's permission dialog, and none was found (see ADR-0026 for the PowerShell-specific consequence of this). Per this checkpoint's instruction not to invent runtime contracts, `ask` is adopted only where it is actually documented, not generalized to every tool by assumption.

## Decision

- **ADR-0022's pinned Claude Code compatibility floor is raised from 2.1.197 to 2.1.211** — the exact version the CHANGELOG confirms the auto-mode-override fix for. This is the version-specific, evidence-backed condition the task set for adopting `ask` at all: "use `permissionDecision=\"ask\"` only with a supported Claude Code version where official documentation guarantees the required behavior."
- `scripts/security/risk-gate.mjs`'s `require-approval` handling: for the **Bash** tool, the decision is `permissionDecision: "ask"`, with a reason describing the action class. Claude Code's own permission UI is where the human actually allows or denies that specific attempt.
- For every other tool that can reach a `require-approval` classification today (**PowerShell**, and MCP tool calls), the decision remains the deterministic `deny` this module used for every require-approval class before this checkpoint (see ADR-0026 for PowerShell specifically; the same absence-of-evidence reasoning applies to MCP tools, which were never covered by the Bash-scoped fix either).
- `scripts/security/human-approval-gate.mjs` is deleted. It no longer has a valid non-authority purpose: its entire reason to exist was granting the `approved` transition KRYLO-APPROVE relied on, and no code path consumes that transition to authorize execution any more.
- `scripts/security/risk-policy.mjs`'s `consumeMatchingApproval()` and `isApprovalUsable()` are deleted. They were the only code that ever read a KRYLO-local `riskApprovals` record's `approved` status and used it, by itself, to allow a tool call. Per the explicit security requirement below, that is no longer permitted for any tool, so the function has no remaining legitimate caller.
- `scripts/security/risk-policy.mjs`'s Hook-entrypoint protection list drops `human-approval-gate.mjs` (the file no longer exists; nothing is gained by continuing to name it).
- The `run` Skill's `UserPromptSubmit` Hook registration is removed (`skills/run/SKILL.md`).
- `runtime/update-state.mjs`'s CLI-level `--resolve-approval <id>=approved` remains unconditionally refused, and `--resolve-approval <id>=denied` remains allowed — this is orthogonal to the authorization question (a model backing off its own request was never the concern) and is preserved as-is.
- `riskApprovals`, `--request-approval`, and the `RISK_APPROVAL_REQUIRED` terminal state are **not** removed. They remain legitimate run-level orchestration/audit bookkeeping — a model may still register that a class of action needs human review and pause the run for it — but per the security requirement, no such record is read or consumed by the risk gate to grant execution any more, for any tool.

## Security requirements (verbatim, preserved)

- Human approval authority must belong to Claude Code's native permission UI, not mutable KRYLO local state or user prompt text.
- KRYLO local approval records may remain for audit/state purposes only if they cannot independently authorize execution.
- Preserve scoped, single-use, run/project/target-bound semantics where still applicable (ADR-0019's schema is unchanged; see its updated "Superseded by").
- Risk gates fail safe (every tool this ADR does not confirm `ask` for keeps `deny`).
- Ordinary non-KRYLO sessions remain unaffected (the Hook is still Skill-scoped, ADR-0021; nothing here changes when it runs).
- No weakening of tests or security checks: `tests/hooks/risk-gate-approvals.test.mjs` and `tests/unit/state-migrations.test.mjs`'s migration-race test were rewritten to prove the *opposite* invariant of before — a persisted, matching, unconsumed `approved` record must still never authorize the action.

## Consequences

- A require-approval Bash action is now a single, synchronous interaction: the model attempts it, the human is prompted immediately by the host, and the outcome is immediate — no separate `--request-approval`, no out-of-band chat phrase, no retry.
- A require-approval PowerShell or MCP action, once denied, has no in-run "unlock" path any more (the old approval-consumption mechanism that could unblock a retry is gone for every tool, not just Bash) — the model must either find a Bash-equivalent path that does get the native prompt, or the human must act outside the run. This is a deliberate, documented ergonomic narrowing in exchange for never letting a KRYLO-local record authorize execution; it is expected to be revisited once official documentation confirms the same `ask`-floors-auto-mode guarantee for those tool types (ADR-0026).
- No KRYLO product version change (`kryloVersion` unchanged at 0.1.1 per this checkpoint's explicit instruction).
- ADR-0022 is amended (compatibility floor 2.1.197 → 2.1.211); `.github/workflows/validate-plugin.yml`, `.github/workflows/release.yml`, `RELEASE_READINESS.md`, and `docs/17-distribution-and-release.md` are updated to match.

## Supersedes

ADR-0024 (host-controlled human-approval boundary). ADR-0024's KRYLO-APPROVE mechanism is removed outright, not merely amended; ADR-0024 is left unedited as an accurate historical record of the design and its own reasoning, marked superseded rather than rewritten.

## Superseded by

None.
