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
- The approval TTL (15 minutes from resolution) is a fixed constant (`APPROVAL_TTL_MS` in `scripts/runtime/update-state.mjs`); a future release may make it configurable if real usage shows it is too short or too long.
