# ADR-0024: Host-controlled human-approval boundary for risk approvals

## Status

Accepted

## Context

Independent review of the multi-host Foundation work found that `runtime/update-state.mjs`'s model-accessible CLI exposed a path equivalent to `update-state.mjs --resolve-approval ra-1=approved`. Because the model itself issues every Bash tool call, nothing distinguished the model requesting an approval from the model also approving its own request:

```text
model requests approval
-> model approves its own request
-> model retries the dangerous action
-> risk gate consumes the approval
-> the dangerous action is allowed
```

ADR-0019's scoped/single-use/atomic approval design (exact match, project/run binding, expiry, single consumption under a per-run lock) is meaningless if the same actor that requests an approval can also grant it. A trustworthy human-approval boundary must originate outside the model's own tool-call surface.

Current official Claude Code documentation (checked 2026-08-24 against the installed CLI, v2.1.197, matching this project's pinned compatibility floor per ADR-0022) does not provide a cryptographic or otherwise host-guaranteed mechanism for a plugin/hook script to prove that a specific action was authorized by a human rather than the model. In particular:

- `permissionDecision: "ask"` is not confirmed to reliably pause for a human across every session mode (see ADR context in `scripts/security/risk-gate.mjs` and the separate fail-safe hardening this checkpoint also applied); it is not used here as an approval mechanism.
- No hook event or API returns a signed, human-attributable authorization token.
- `permission_mode` reports the current session mode but does not attest that a specific decision was made by a human.

What IS documented and architecturally solid: the `UserPromptSubmit` hook fires "before Claude processes" a submitted prompt, so it receives the raw text of a top-level prompt submission before the model can see, alter, or react to it within that same turn. The model cannot originate a new top-level prompt submission from within its own turn -- the next one only arrives from whatever is actually driving the Claude Code session (interactively, or via a print/programmatic caller in non-interactive use). Hook payloads additionally carry `agent_id`/`agent_type` when execution is attributed to a subagent, letting a handler exclude subagent-originated context defensively.

## Decision

- `runtime/update-state.mjs`'s `--resolve-approval <id>=approved` is refused unconditionally from the CLI (`model-approval-forbidden`). `--resolve-approval <id>=denied` remains allowed: a model backing off its own request is not a security concern.
- A new Skill-scoped `UserPromptSubmit` hook, `scripts/security/human-approval-gate.mjs`, is the only path that can transition a `pending` approval to `approved` (or `denied`). It scans the raw prompt text of a genuine top-level submission for an explicit `KRYLO-APPROVE <id>` / `KRYLO-DENY <id>` phrase (case-insensitive), and only acts when the payload carries no `agent_id`/`agent_type` (i.e. it is not attributed to a subagent).
- The underlying state mutation (`applyApprovalResolution` in `scripts/lib/state.mjs`) is shared by both the CLI's denied-only path and this hook, under the same per-run file lock already used for approval consumption, and now additionally requires the approval to still be `pending` before transitioning -- a resolved approval can never be re-resolved.
- This hook never blocks, delays, or alters the prompt, and never prints anything visible to the model: it always exits 0 silently, so it never interferes with ordinary chat during a KRYLO run, matching ADR-0021's Skill-scoped hook isolation.
- The `run` Skill's guidance tells the model it cannot approve its own request and to ask the human to type the exact confirmation phrase.

## Stated guarantee and residual scope

This proves the confirmation phrase was present in the raw text of a genuine top-level prompt submission -- content the model cannot originate, edit, or replay from within its own turn, and which is not attributed to a subagent it spawned. It does not cryptographically prove that a human, specifically, is the one submitting that prompt, as opposed to some other automated caller driving the Claude Code session in a non-interactive context; no such proof is available in current official Claude Code documentation, and this is a limitation of the platform, not something this design can close on its own. This is a substantial, verifiable improvement over the prior state (zero gating on the model-accessible approval path), not a claim of absolute cryptographic authorization.

## Consequences

- `plugins/krylo/tests/hooks/human-approval-gate.test.mjs` and the updated `plugins/krylo/tests/unit/cli.test.mjs` cover: the previously-vulnerable self-approve flow now failing at the CLI step; the human-confirmation flow correctly granting and then being consumed by the risk gate; subagent-attributed prompts being ignored; ordinary chat messages being unaffected; multiple approvals in one message; nonexistent-id and already-resolved no-ops; and case-insensitivity.
- No compatibility floor change: this does not require any Claude Code version newer than the existing pinned 2.1.197 floor (ADR-0022 unchanged). `UserPromptSubmit` and its documented fields are available well within that floor.
- If a future official Claude Code mechanism provides a stronger, documented human-authorization primitive (e.g. a genuinely attested approval channel), this ADR should be revisited and superseded rather than layering a second mechanism on top silently.

## Supersedes

None. Extends ADR-0019 (scoped/single-use/atomic approvals) with the missing human-authority boundary.

## Superseded by

None.
