# ADR-0019: Risk approvals are scoped, expiring, and single-use

## Status

Accepted

## Context

The 0.1.0 risk gate accepted a category-wide reusable approval: once one `git-push` approval existed with `status: "approved"`, every subsequent `git-push` for the rest of the run was silently allowed, with no expiry and no binding to the project, run, or the specific action the user actually approved. A prompt-injected or confused model could exploit a single approval intended for one push to authorize a different, unrelated push (or, for any other class, a different deploy, SQL write, merge, message, or secret change) for the remainder of the run.

## Decision

An approval record now binds:

- `actionClass` (unchanged).
- `projectRootHash` and `runId`, captured at request time from the requesting run's own state — an approval can only ever be consumed by the same project and run that requested it.
- an optional `environment` (the active `security_profile`), captured at request time.
- `expiresAt`, set when the user resolves the request as approved (not at request time, so an approval that sits unreviewed for a while does not burn down its usable window); an approval whose `expiresAt` has passed is treated as not-approved.
- an optional `fingerprint`/`target` pre-binding: `update-state.mjs --request-approval <class> --target "<description>"` hashes the target with the same normalization the risk gate uses on the actual command (`scripts/lib/action-fingerprint.mjs`), so a retry must match exactly — a different target or a modified command is refused. Without `--target`, the approval is untargeted and any action in the class may consume it once.
- single-use `status` transitions: `pending -> approved -> consumed` (or `denied`); consumption is atomic under a per-run exclusive file lock (`scripts/lib/lock.mjs`, `runLockPath`) so two concurrent PreToolUse evaluations for the same class can never both spend the same approval.
- `consumedAt`, recorded the moment the approval is spent.

Only `summary`/`target` are free text; every other field is a structural identifier, deliberately never passed through `deepRedact` (a 64-hex project hash would otherwise be mistaken for an opaque token and mangled).

## Consequences

- An approval authorizes exactly the one action it was granted for (or, if untargeted, exactly one action in its class) — never a second, different, or later action.
- `tests/hooks/risk-gate-approvals.test.mjs` covers exact match, different target, modified command, expired, reused, concurrent consumption, wrong project, wrong run, and wrong environment.
- The approval TTL (15 minutes from resolution) was a fixed constant, `APPROVAL_TTL_MS` in `scripts/lib/state.mjs` — **historical**: ADR-0025 removed it along with the `approved`-setting code path it existed to bound, since nothing sets `approved` any more (see this ADR's "Superseded by" below).

## Superseded by

Partially superseded by ADR-0025 (native permission approval). ADR-0024 (host-controlled human-approval boundary, itself superseded by ADR-0025) first extended this decision without changing it. ADR-0025 goes further: `consumeMatchingApproval()`/`isApprovalUsable()` (the functions that actually spent an approval record to authorize a Bash tool call) were removed entirely, because a KRYLO-local approval record must never independently authorize execution (the security requirement ADR-0025 states directly). `applyApprovalResolution()` itself now refuses any status other than `denied`, and `APPROVAL_TTL_MS`/the `approved`-setting branch were deleted (nothing remains that could set `approved`). For the Bash tool, authorization now happens live through Claude Code's native permission prompt instead of through this record's status. The scoping/expiry/single-use *schema* this ADR defines is unchanged and still governs the `riskApprovals` array and the `--request-approval`/`--resolve-approval` CLI, which remain in place for run-level audit and orchestration bookkeeping (e.g. `RISK_APPROVAL_REQUIRED`) — they are simply no longer, on their own, a path to `allow` a gated tool call.
