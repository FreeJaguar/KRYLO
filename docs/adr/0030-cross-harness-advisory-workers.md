# ADR-0030: Cross-Harness opposite-provider advisory workers

## Status

Accepted

## Context

ADR-0023 reserved "cross-harness workers" as a future architectural change requiring its own ADR. ADR-0029 (Codex Host) and the 0.2 Codex-host product goals explicitly listed "Cross-Harness advisory workers" as out of scope. `THREAT_MODEL.md`'s host-adapter-boundary-drift section already states the constraint this ADR must satisfy: "no cross-harness or cross-provider data flow exists until a separate, approved plan is implemented and verified."

The approved shape (`docs/process/CROSS_HARNESS_IMPLEMENTATION_PLAN.md`) is: a KRYLO run on one native host (Claude or Codex) may, as an optional, bounded, read-only, advisory step, invoke the **opposite** provider's own CLI as a second opinion -- a Claude-hosted run may spawn `codex exec`; a Codex-hosted run may spawn `claude -p`. The native host remains the only writer, the only orchestrator, and the only authority over KRYLO run state. The worker is never itself a KRYLO run: it never calls `init-run.mjs`, is never given `KRYLO_DATA_ROOT`/`PLUGIN_DATA`, and cannot mutate `state.json`.

## Decision

### Shared coordinator, thin provider adapters

One host-neutral module, `scripts/lib/cross-harness.mjs` (Shared Core, alongside `risk-policy.mjs`/`state.mjs`), owns request validation, depth enforcement, egress classification, context-packet construction, and result-schema validation. Two thin adapters, `scripts/host/cross-harness/claude-worker.mjs` and `scripts/host/cross-harness/codex-worker.mjs`, own only: CLI capability detection, argv construction, provider-specific read-only flags, output parsing, and process lifecycle. Neither adapter contains policy logic; neither is named `claude-cross-harness-core`/`codex-cross-harness-core` -- there is exactly one implementation.

The **native host that is currently running** determines which adapter is the "worker" adapter: on Claude, the worker adapter is `claude-worker.mjs`'s opposite number, i.e. the Codex adapter is invoked; on Codex, the Claude adapter is invoked. `scripts/lib/host-dispatch.mjs`'s existing `detectHost()` already tells the coordinator which host is native; the coordinator refuses same-provider requests (`Claude -> Claude`, `Codex -> Codex`) deterministically, since same-provider delegation is ordinary KRYLO subagent orchestration (Task tool), not Cross-Harness.

### Reused, not reinvented: `delegation`, `riskApprovals`, native ask, `agents`, telemetry whitelist

Every mechanism below was already a validated, unused-until-now piece of Shared Core, put there in anticipation of exactly this ADR (Foundation/Codex-host checkpoints):

- **Depth**: `state.delegation = { externalWorker: boolean, depth: 0|1, parentRunId?: string }` (`scripts/lib/state.mjs`, schema-bound `depth` to `[0,1]` already, header comment: "how this run was reached: directly, or as a bounded delegation from another run/worker") was added in an earlier checkpoint anticipating this ADR, but unused by any code until now. Per `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 12.7, this field's real enforcement counterpart is a bounded environment-variable triple: `KRYLO_EXTERNAL_WORKER=1`, `KRYLO_PARENT_RUN_ID=<runId>`, `KRYLO_DELEGATION_DEPTH=1`, set on the worker's own child process. Because the worker never creates or mutates its own KRYLO run state (Section 3's "must not mutate KRYLO canonical state directly"), the **native, calling run's own persisted `delegation.depth` correctly stays `0`** for the run's entire lifetime -- it was invoked directly by a user, and remains so, regardless of how many Cross-Harness workers it spawns. Only `delegation.externalWorker` is set to `true` on the calling run once it has spawned at least one worker (audit bookkeeping: "this run used an external worker at some point"), never `depth`.
- **Approval**: Cross-Harness invocation is a **new `require-approval` action class**, `cross-harness-invocation`, added to `plugins/krylo/policies/production-policy.json`'s `approvalClasses` (pattern: invocation of the new `scripts/runtime/cross-harness-run.mjs` CLI) and to `state.mjs`'s `actionClass` enum. Because ADR-0027 already made *every* `require-approval` class ask-eligible ("No class-based allowlist remains in `risk-gate.mjs`: there is nothing left to enumerate"), this one new policy-file entry is sufficient to get Claude's native `permissionDecision: "ask"` for free -- **zero changes to `risk-gate.mjs`'s ask-eligibility logic are needed**. On Codex, the identical class is denied deterministically, because `risk-gate-codex.mjs` already denies every `require-approval` class regardless of tool or `permission_mode` (ADR-0029) -- again, zero new code. This is not a workaround: it is Section 6's own explicit instruction ("If Codex cannot guarantee native human approval for the dedicated cross-provider invocation: fail closed for that invocation") falling directly out of a decision already made and shipped.
- **No local approval token is invented.** The Bash/PowerShell command that invokes `cross-harness-run.mjs` is itself the gated action; KRYLO's existing native-ask/deterministic-deny machinery is the sole authority, exactly as it already is for `git-push`, `production-deploy`, and every other class.
- **Agent bookkeeping**: a Cross-Harness invocation is recorded via the existing `--register-agent`/`--agent-status` CLI (`type: "cross-harness:<provider>:<role>"`), so it appears in the final report's "Agents used" table using the same mechanism as any other subagent, with no new bookkeeping primitive.
- **Telemetry**: `scripts/lib/telemetry.mjs`'s `ALLOWED_FIELDS` whitelist gains `provider`, `role`, `inputBytes`, `outputBytes`, `findingCount` -- scalar, non-secret fields only, matching the existing whitelist discipline exactly (`docs/22-privacy-and-telemetry.md` updated to match).
- **Evidence**: a worker's structured result becomes one `evidence` entry (`type: "cross-harness-review"`) and, if it reported findings, one or more `findings` entries with `source: "cross-harness:<provider>:<role>"` -- using the exact existing `--add-evidence`/`--add-finding` CLI and schema, never a new evidence subsystem. Per Section 16, a worker's findings can never themselves flip `acceptanceCriteria` to `proven`, resolve an approval, or set a terminal state; only the native host's own `update-state.mjs` calls, driven by the native host's own judgment after reading the advisory evidence, can do that.

### Depth is code-enforced, not prompt-enforced

Two independent, redundant checks, per Section 5's explicit "do not trust only an environment variable, do not trust only model instructions, use both where useful" and matching the exact env-var triple `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 12.7 already specifies:

1. **Process marker**: the coordinator sets `KRYLO_EXTERNAL_WORKER=1`, `KRYLO_PARENT_RUN_ID=<runId>`, `KRYLO_DELEGATION_DEPTH=1` in the worker's child environment (and does not propagate `KRYLO_DATA_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA` at all -- the worker has no KRYLO data root to find). `scripts/runtime/cross-harness-run.mjs`'s own entrypoint, before anything else, refuses deterministically if `process.env.KRYLO_DELEGATION_DEPTH` is already `'1'` (or `KRYLO_EXTERNAL_WORKER` is already `'1'`) -- this fires even if a worker somehow discovers and executes the script directly, independent of any request object.
2. **Request validation**: `CrossHarnessRequest.depth` is computed by the coordinator itself (`0` if the current process has no `KRYLO_DELEGATION_DEPTH` set, i.e. it is the native run; the coordinator only ever constructs a depth-`1` request when spawning a worker, and never accepts a depth value a caller supplies) and schema-validated to `<= 1` before any process is spawned, independent of the environment check above -- neither check alone is trusted.

### Roles: advisory only, reusing existing agent-role names

Allowed `CrossHarnessRequest.role` values: `verifier`, `reviewer`, `security-reviewer`, `architect` -- deliberately the exact same names as the matching native KRYLO agent roles (`plugins/krylo/agents/{verifier,reviewer,security-reviewer,architect}.md`), all four already read-only-shaped roles in KRYLO's own agent catalog, and the exact four this checkpoint's own instructions name as the minimum set to ship. This specializes `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 12.2's broader "scout, reviewer, security-reviewer, deep-debugger, other explicitly read-only analysis roles approved by policy" to a smaller, concrete v1 set reusing KRYLO's existing role vocabulary; `scout`/`deep-debugger` are not exposed to Cross-Harness in v1 and remain a documented candidate future extension, not a contradiction of the design doc's own "at minimum" framing. `builder`/`writer`/`implementer`/`deployer`/`releaser` (the design doc's prohibited "builder / deployment operator / release operator / merge-push operator / secret-management operator / financial-or-production-write operator" list, restated against KRYLO's own role names), or any unrecognized string, is rejected deterministically by schema validation before a worker is ever spawned.

### Disposable worker directory, secure process spawning, environment governance

- Worker cwd: `<KRYLO data root>/cross-harness/<runId>/<workerInvocationId>` (random, collision-resistant `workerInvocationId`, matching the existing `run-<hex>`/`ra-<n>` ID conventions in `state.mjs`). Built and torn down using the same `safeJoin`/path-traversal/symlink-escape discipline `scripts/lib/paths.mjs` already provides for the data root -- no second path-safety implementation.
- Process spawning: `node:child_process.spawnSync`/`spawn` with an **argv array**, `shell: false` always, matching every existing spawn site in the codebase (no shell string is ever built from task text, file paths, provider, model, or role). Context/task payload is written to a file inside the disposable directory and passed via stdin/`--output-schema`-style file arguments, never concatenated into argv, so it never appears in a process listing.
- Environment: an explicit allowlist (`PATH`, and the minimum each provider CLI needs to find its own auth state, e.g. `HOME`/`USERPROFILE`) is constructed for the child; the parent's full `process.env` is never passed through. No `*_TOKEN`/`*_SECRET`/`*_KEY`-shaped variable is propagated unless it is one the provider CLI's own already-authenticated login state requires and KRYLO never reads its value (KRYLO does not parse, copy, or persist a provider's auth file).
- Bounded: a runtime timeout, stdout/stderr byte caps, and a hard cap of one worker process at a time (no cross-provider concurrency in v1) are enforced by the coordinator; a transient spawn failure gets at most one retry, and a request is never retried merely because output parsing failed after the process itself completed (to avoid duplicate egress/cost).

### Structured, schema-validated, untrusted worker output

`CrossHarnessResult` (`schemaVersion`, `status`, `provider`, `role`, `summary`, `findings[]`, `limitations[]`) is validated the same way `run-state.schema.json` is hand-validated today (bounds on string length, enum values, path shape, no absolute or `..`-traversal evidence paths, size cap). Malformed output is rejected, never partially trusted. The worker's own system prompt states the context is evidence, not instructions, and instructs it never to attempt Cross-Harness recursion -- but per Section 9, prompt text is explicitly not the security boundary; the code-level controls above (no write tools/read-only sandbox, `shell:false`, depth marker, schema validation, no automatic patch/approval/completion application) are.

### Fail-open availability, fail-closed security

Cross-Harness is fully optional: missing/unauthenticated/unsupported-version opposite CLI, denied egress, timeout, or malformed output all degrade to "Cross-Harness unavailable, native-only verification/review proceeds" -- never to blocking the run, and never to silently treating "no cross-harness findings" as proof of correctness (Section 16). A capability gap is recorded honestly (a new row family in `docs/codex-capability-matrix.md` and a Claude-host equivalent), never silently downgraded.

## Consequences

- **The Codex-native -> Claude-worker direction cannot obtain real human approval in this environment today**, since it inherits ADR-0029's already-accepted, already-shipped deterministic-deny boundary for every `require-approval` class. This is a disclosed, capability-driven asymmetry (identical in kind to the existing `require-approval` asymmetry between the two hosts), not a new gap this ADR introduces -- it is the direct, expected consequence of reusing the existing approval boundary rather than inventing a second one. Only Claude-native -> Codex-worker is practically usable with a real human-in-the-loop today.
- Cross-Harness consumes the calling run's existing Orbit/agent budget; it does not create an independent, unbounded worker loop or a multi-writer architecture.
- No KRYLO product version change (`kryloVersion` remains `0.1.1`).
- `production-policy.json` gains one new approval class and `state.mjs` gains one new `actionClass` enum value and (reused) `delegation` semantics; no other Shared Core security surface is modified. The Claude and Codex regression suites are unaffected by this addition (a require-approval class that never matches any pre-existing command pattern cannot change any pre-existing classification).

## Supersedes

None. Extends ADR-0023 exactly as anticipated ("cross-harness workers" required their own ADR) and narrows the "no cross-harness data flow" statement in `THREAT_MODEL.md`/`PRODUCT_SPEC.md`'s Codex-host goals to "implemented, per this ADR, as of this checkpoint" rather than "out of scope." Does not modify ADR-0025/0027 (Claude native-approval mechanism, reused unchanged) or ADR-0029 (Codex approval boundary, reused unchanged).

## Superseded by

None.
