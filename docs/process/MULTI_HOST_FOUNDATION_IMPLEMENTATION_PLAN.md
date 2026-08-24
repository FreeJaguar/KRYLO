# KRYLO Multi-Host Foundation Implementation Plan

**Goal:** Extract the host-neutral identity, runtime-environment, persisted-state, hook-resolution, and risk-policy foundations required for a future Codex host while preserving the existing Claude Code `/krylo:run` behavior and security guarantees.

**Architecture:** Keep every existing Claude-facing entrypoint and Skill path stable, but move host-specific normalization into a thin Claude adapter. Shared runtime modules consume normalized KRYLO fields only. Persisted run state moves from a Claude-named `sessionId` field to an explicit host identity, with a validated and backed-up schema migration. Risk/completion policy remains shared; Claude hook JSON stays in a Claude transport adapter.

**Tech stack:** Portable Node.js ESM on Node.js >=22, Node built-ins only, `node:test`, JSON Schema draft 2020-12, Claude Code plugin Skills and lifecycle hooks.

**Design:** `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md`

**Historical plan:** Preserve `docs/process/IMPLEMENTATION_PLAN.md` unchanged as the KRYLO v0.1.0 implementation record.

**Baseline:** `main` at `be76b9ff8302c428598e97f7e289734d08340fd1`, KRYLO `0.1.1`.

**Scope:** This plan implements only the approved architecture/ADR foundation and host-neutral Core extraction. It does not add Codex packaging, Codex Skills/Hooks/agents, cross-harness workers, ecosystem maintenance workflows, macOS CI, or the `0.2.0` version bump.

## Global constraints

- Re-verify `main`, HEAD, worktree status, current Claude Code docs, and the pinned Claude Code compatibility floor before edits.
- Work on a feature branch. Never use `git reset --hard`, silently stash unrelated changes, or rewrite published history.
- Keep `/krylo:run <task>` and the optional `/krylo` Claude wrapper backward compatible.
- Keep Claude runtime Hooks Skill-scoped. Do not add plugin-wide runtime hooks.
- Keep `plugins/krylo/hooks/hooks.json` empty unless a separately approved ADR supersedes ADR-0021.
- Do not depend on Hook execution order. Current Claude Code runs all matching hooks in parallel.
- Keep one normal application-code writer per worktree and independent verification/review.
- Keep runtime code portable Node.js ESM with zero new runtime dependencies in this phase.
- Do not move Claude users' existing runtime data to a new directory silently.
- Do not weaken risk approval scope, expiry, atomicity, single-use consumption, sensitive-path protection, or MCP gating.
- Do not persist raw prompts, source code, secrets, raw commands, database values, stack traces, or sensitive tool output.
- Do not hard-code Codex model slugs or create Codex files in this plan.
- Do not bump KRYLO to `0.2.0` in this plan.
- Keep the entire 0.2 development line off `main` until the dedicated release plan aligns versions and release evidence. A schema-changing Foundation must not appear on `main` while marketplace metadata still advertises `0.1.1`.
- Run migration tests only against isolated temporary/copied fixtures, never against the user's live KRYLO data directory.
- Do not push, merge, tag, release, publish, deploy, alter marketplace state, access production, or perform another external write.

---

## File map

### New files

- `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` - approved architecture copied into its KRYLO-native repository location, with the obsolete `docs/superpowers/...` path corrected.
- `docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md` - this plan.
- `docs/adr/0023-multi-host-product-and-shared-core.md` - accepted architecture decision for two first-class hosts and one Shared Core.
- `plugins/krylo/scripts/lib/host-context.mjs` - host-neutral HostIdentity and HostContext validation/creation.
- `plugins/krylo/scripts/lib/state-migrations.mjs` - deterministic run-state migration from schema `1.0.0` to `1.1.0`.
- `plugins/krylo/scripts/host/claude/context.mjs` - all Claude-specific session, plugin-root, data-root, and plugin-option normalization.
- `plugins/krylo/scripts/host/claude/hook-transport.mjs` - Claude Hook input normalization and Claude-specific Hook output encoding.
- `plugins/krylo/scripts/security/risk-policy.mjs` - shared risk classification and scoped approval-consumption policy with no Claude Hook JSON output.
- `plugins/krylo/tests/unit/host-context.test.mjs` - neutral identity/context tests.
- `plugins/krylo/tests/unit/state-migrations.test.mjs` - state and pointer migration tests.
- `plugins/krylo/tests/unit/claude-context.test.mjs` - Claude adapter compatibility tests.
- `plugins/krylo/tests/unit/risk-policy.test.mjs` - direct shared-policy tests independent of Claude Hook transport.

### Existing files expected to change

- `CLAUDE.md`
- `PRODUCT_SPEC.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `THREAT_MODEL.md`
- `docs/02-runtime-state-machine.md`
- `docs/05-model-routing.md`
- `docs/07-hooks-and-observability.md`
- `docs/21-public-api-and-schemas.md`
- `docs/process/FILE_MANIFEST.md`
- `plugins/krylo/schemas/run-state.schema.json`
- `plugins/krylo/scripts/lib/paths.mjs`
- `plugins/krylo/scripts/lib/state.mjs`
- `plugins/krylo/scripts/lib/hook-utils.mjs`
- `plugins/krylo/scripts/lib/telemetry.mjs`
- `plugins/krylo/scripts/runtime/init-run.mjs`
- `plugins/krylo/scripts/runtime/read-state.mjs`
- `plugins/krylo/scripts/runtime/update-state.mjs`
- `plugins/krylo/scripts/runtime/cleanup.mjs`
- `plugins/krylo/scripts/runtime/posttool-telemetry.mjs`
- `plugins/krylo/scripts/security/question-gate.mjs`
- `plugins/krylo/scripts/security/risk-gate.mjs`
- `plugins/krylo/scripts/orbit/fingerprint.mjs`
- `plugins/krylo/scripts/orbit/stop-gate.mjs`
- `plugins/krylo/scripts/status/agent-events.mjs`
- `plugins/krylo/scripts/status/subagent-statusline.mjs`
- `plugins/krylo/scripts/setup/doctor.mjs`
- `plugins/krylo/skills/run/SKILL.md`
- `plugins/krylo/tests/hooks/helpers.mjs`
- `plugins/krylo/tests/hooks/risk-gate.test.mjs`
- `plugins/krylo/tests/hooks/risk-gate-approvals.test.mjs`
- `plugins/krylo/tests/hooks/risk-gate-mcp.test.mjs`
- `plugins/krylo/tests/hooks/question-gate.test.mjs`
- `plugins/krylo/tests/hooks/stop-gate.test.mjs`
- `plugins/krylo/tests/hooks/fingerprint.test.mjs`
- `plugins/krylo/tests/hooks/posttool.test.mjs`
- `plugins/krylo/tests/unit/state.test.mjs`
- `plugins/krylo/tests/unit/cli.test.mjs`
- `plugins/krylo/tests/unit/resume.test.mjs`
- `plugins/krylo/tests/unit/telemetry.test.mjs`
- `plugins/krylo/tests/unit/cleanup.test.mjs`
- `plugins/krylo/tests/platform/paths.test.mjs`
- `plugins/krylo/tests/platform/concurrency.test.mjs`
- `plugins/krylo/tests/status/agent-events.test.mjs`
- `plugins/krylo/tests/status/statusline.test.mjs`
- `plugins/krylo/tests/setup/doctor.test.mjs`
- `plugins/krylo/tests/governance/hook-scoping.test.mjs`
- `plugins/krylo/scripts/validation/validate-runtime.mjs`

Do not modify files merely because they appear in this map. Inspect each first and change only what is required by the interface changes below.

---

## Task 1: Preflight, baseline evidence, design placement, and ADR-0023

**Files:**
- Create: `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md`
- Create: `docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md`
- Create: `docs/adr/0023-multi-host-product-and-shared-core.md`
- Modify: `docs/process/FILE_MANIFEST.md`

**Produces:**
- An auditable implementation baseline.
- The approved design in the repository's existing `docs/process/` convention.
- The architectural authority required before host-neutral runtime code changes.

- [ ] **Step 1: Verify repository identity and working state before creating a branch**

Run:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git log -1 --oneline
```

Required observations before continuing:

```text
branch: main
HEAD: be76b9ff8302c428598e97f7e289734d08340fd1, or a newer commit that has been inspected first
working tree: no unrelated changes that would be overwritten or mixed into this work
```

If HEAD moved, inspect the new commits and re-evaluate every file path in this plan before editing. If the tree contains unrelated work, preserve it and stop rather than stashing or resetting it silently.

- [ ] **Step 2: Re-verify the current official Claude Code contracts that this phase touches**

Review the current official documentation for:

```text
https://code.claude.com/docs/en/hooks
https://code.claude.com/docs/en/plugins
https://code.claude.com/docs/en/plugins-reference
https://code.claude.com/docs/en/env-vars
```

Record in the implementation notes that the current docs still support all of these requirements before editing:

```text
- Skill-frontmatter hooks are scoped to the active component lifecycle.
- PreToolUse receives session_id and prompt_id in Hook JSON input on supported versions.
- PreToolUse uses hookSpecificOutput.permissionDecision and permissionDecisionReason.
- Stop continues to use its documented top-level decision/reason contract.
- All matching hooks run in parallel, so no KRYLO design may require hook sequencing.
- CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are documented Hook path/data placeholders.
```

Also explicitly check whether `CLAUDE_SESSION_ID` is documented for the current runtime. If it remains undocumented, treat the existing Skill use of `${CLAUDE_SESSION_ID}` as a Claude-host compatibility dependency to isolate, not as a Shared Core contract.

- [ ] **Step 3: Verify the pinned Claude compatibility floor before changing Hook syntax**

Inspect:

```bash
grep -n "@anthropic-ai/claude-code@" .github/workflows/validate-plugin.yml .github/workflows/release.yml
```

Do not convert existing Hook commands to a newer `command` + `args` form in this phase unless the pinned floor is proven to support it. Preserving the current validated Hook command form is preferred over an unrelated modernization.

- [ ] **Step 4: Capture baseline local validation without claiming success in advance**

Run, recording the real exit status and output summary for each command:

```bash
npm run syntax
npm run validate:runtime
npm test
claude plugin validate --strict plugins/krylo
claude plugin validate --strict .
```

A pre-existing failure is a baseline blocker to understand, not a reason to weaken a test. Do not attribute a failure to this change until the baseline proves it.

- [ ] **Step 5: Create the feature branch**

Run only after the baseline and worktree are understood:

```bash
git switch -c feat/multi-host-0.2
```

If that integration branch already exists, inspect it instead of overwriting it. Later plans continue from this reviewed integration branch; do not merge partial 0.2 phases to `main`.

- [ ] **Step 6: Place the approved design at the KRYLO-native path**

Copy the already approved design content into:

```text
docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md
```

Change only the stale metadata line:

```text
Intended repository path: docs/superpowers/specs/2026-08-20-multi-host-codex-maintenance-design.md
```

to:

```text
Intended repository path: docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md
```

Do not introduce a `docs/superpowers/` directory or any Superpowers dependency/reference into KRYLO.

- [ ] **Step 7: Add ADR-0023 before architecture-dependent code**

Create `docs/adr/0023-multi-host-product-and-shared-core.md` with this decision content:

```markdown
# ADR-0023: Multi-host product and shared KRYLO Core

## Status

Accepted

## Context

KRYLO 0.1.x is implemented and distributed as a Claude Code plugin. The product is now approved to support Claude Code and Codex as equal first-class execution hosts without duplicating Orbit, evidence, completion, approval, security, tool-governance, telemetry, or adapter policy.

Host session identifiers and host-specific Hook/model schemas are platform details. Treating them as Core identity would couple persisted state and policy to one host and would make a second implementation drift over time.

## Decision

- Claude Code and Codex are equal first-class KRYLO hosts.
- KRYLO has one Shared Core and thin host-specific adapters.
- KRYLO owns `runId`; host session and prompt/turn identifiers are metadata attached to a run.
- Shared Core owns run state, Orbit, evidence, completion, approvals, tool governance, data-egress policy, telemetry/privacy, external-adapter policy, and logical agent roles.
- Host adapters own invocation syntax, host Hook input/output translation, host session metadata, host agent configuration, model mapping, packaging, and setup mechanics.
- KRYLO remains explicit-only on every host and is not the default orchestrator for ordinary sessions.
- KRYLO maintains one product version across host surfaces.

## Supersession and scope

- This ADR supersedes the Claude-only product scope of ADR-0001 while preserving its GitHub-hosted Claude marketplace decision for the Claude host.
- ADR-0002 remains authoritative for the Claude `/krylo:run` command and optional `/krylo` wrapper; Codex receives its own explicit host invocation in a later ADR.
- ADR-0006 remains the Claude-host model-routing decision until host-neutral model routing is documented and Codex mapping is implemented.
- ADR-0009 is generalized: KRYLO is not the default orchestrator on either host.
- ADR-0021 remains authoritative for Claude Skill-scoped Hooks and is not superseded.

## Consequences

- Existing Claude behavior must be regression-proven before native Codex implementation begins.
- Shared runtime modules may not depend directly on Claude-only session, option, model, or Hook-output field names.
- Host-specific compatibility shims may remain in host adapters when a platform contract is undocumented or version-dependent, but they cannot become Core contracts.
- Architectural changes for Codex packaging, cross-harness workers, maintenance automation, and generalized compatibility policy require their own ADRs.
```

- [ ] **Step 8: Update the file manifest without rewriting historical v0.1.0 content**

Add the two new process documents and ADR-0023 to `docs/process/FILE_MANIFEST.md`. Keep `docs/process/IMPLEMENTATION_PLAN.md` identified as the historical v0.1.0 plan.

- [ ] **Step 9: Verify documentation-only diff and commit locally**

Run:

```bash
git diff --check
git diff -- docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md docs/adr/0023-multi-host-product-and-shared-core.md docs/process/FILE_MANIFEST.md
```

Then commit locally:

```bash
git add docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md docs/adr/0023-multi-host-product-and-shared-core.md docs/process/FILE_MANIFEST.md
git commit -m "docs: define multi-host KRYLO foundation"
```

Do not push.

---

## Task 2: Add host-neutral HostIdentity and HostContext contracts

**Files:**
- Create: `plugins/krylo/scripts/lib/host-context.mjs`
- Create: `plugins/krylo/tests/unit/host-context.test.mjs`
- Modify: `plugins/krylo/scripts/validation/validate-runtime.mjs`

**Interfaces:**
- Produces: `createHostIdentity(input)`, `bindRunId(identity, runId)`, `validateHostIdentity(value)`, `validateHostContext(value)`, `HOST_NAMES`.
- Consumed later by: Claude context adapter, state creation/migration, Hook active-run resolution, future Codex host.

The pre-run identity and bound run context are intentionally separate because KRYLO allocates `runId` during initialization.

- [ ] **Step 1: Write failing HostIdentity/HostContext tests**

Create `plugins/krylo/tests/unit/host-context.test.mjs` with tests equivalent to:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  HOST_NAMES,
  createHostIdentity,
  bindRunId,
  validateHostIdentity,
  validateHostContext,
} from '../../scripts/lib/host-context.mjs';

test('HOST_NAMES contains only approved first-class hosts', () => {
  assert.deepEqual(HOST_NAMES, ['claude', 'codex']);
});

test('createHostIdentity returns an immutable normalized identity', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-1',
    hostTurnId: 'prompt-1',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
    permissionMode: 'default',
  });

  assert.equal(identity.host, 'claude');
  assert.equal(identity.hostSessionId, 'session-1');
  assert.equal(path.isAbsolute(identity.projectRoot), true);
  assert.equal(path.isAbsolute(identity.pluginRoot), true);
  assert.equal(path.isAbsolute(identity.dataRoot), true);
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(validateHostIdentity(identity).valid, true);
});

test('bindRunId creates a validated immutable HostContext', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-2',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
  });
  const context = bindRunId(identity, 'run-abcdef123456');
  assert.equal(context.runId, 'run-abcdef123456');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(validateHostContext(context).valid, true);
});

test('invalid host and missing session are rejected', () => {
  assert.equal(validateHostIdentity({ host: 'other' }).valid, false);
  assert.throws(() => createHostIdentity({ host: 'claude', hostSessionId: '' }));
});

test('bindRunId rejects malformed run IDs', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-3',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
  });
  assert.throws(() => bindRunId(identity, '../escape'));
});
```

- [ ] **Step 2: Run the focused test and confirm the expected initial failure**

Run:

```bash
node --test plugins/krylo/tests/unit/host-context.test.mjs
```

Expected before implementation: module-not-found or missing export failure.

- [ ] **Step 3: Implement the host-neutral contract**

Create `plugins/krylo/scripts/lib/host-context.mjs` with these exact public semantics:

```js
import path from 'node:path';

export const HOST_NAMES = Object.freeze(['claude', 'codex']);

const RUN_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function optionalString(value, field, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} must be a non-empty string when present`);
  } else if (value.length > 256) {
    errors.push(`${field} must be at most 256 characters`);
  }
}

export function validateHostIdentity(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['host identity must be an object'] };
  }
  if (!HOST_NAMES.includes(value.host)) errors.push('host is not supported');
  if (typeof value.hostSessionId !== 'string' || value.hostSessionId.trim() === '') errors.push('hostSessionId must be a non-empty string');
  else if (value.hostSessionId.length > 256) errors.push('hostSessionId must be at most 256 characters');
  for (const field of ['projectRoot', 'pluginRoot', 'dataRoot']) {
    if (typeof value[field] !== 'string' || !path.isAbsolute(value[field])) errors.push(`${field} must be an absolute path`);
  }
  for (const field of ['hostTurnId', 'configuredModel', 'resolvedModel', 'permissionMode']) optionalString(value[field], field, errors);
  return { valid: errors.length === 0, errors };
}

export function createHostIdentity(input) {
  const identity = {
    host: input?.host,
    hostSessionId: typeof input?.hostSessionId === 'string' ? input.hostSessionId.trim() : input?.hostSessionId,
    projectRoot: typeof input?.projectRoot === 'string' ? path.resolve(input.projectRoot) : input?.projectRoot,
    pluginRoot: typeof input?.pluginRoot === 'string' ? path.resolve(input.pluginRoot) : input?.pluginRoot,
    dataRoot: typeof input?.dataRoot === 'string' ? path.resolve(input.dataRoot) : input?.dataRoot,
    ...(input?.hostTurnId ? { hostTurnId: String(input.hostTurnId) } : {}),
    ...(input?.configuredModel ? { configuredModel: String(input.configuredModel) } : {}),
    ...(input?.resolvedModel ? { resolvedModel: String(input.resolvedModel) } : {}),
    ...(input?.permissionMode ? { permissionMode: String(input.permissionMode) } : {}),
  };
  const result = validateHostIdentity(identity);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return Object.freeze(identity);
}

export function validateHostContext(value) {
  const identityResult = validateHostIdentity(value);
  const errors = [...identityResult.errors];
  if (typeof value?.runId !== 'string' || !RUN_ID_RE.test(value.runId)) errors.push('runId is invalid');
  return { valid: errors.length === 0, errors };
}

export function bindRunId(identity, runId) {
  const context = { ...identity, runId };
  const result = validateHostContext(context);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return Object.freeze(context);
}
```

If implementation reveals a required additional field, update the approved design and ADR before expanding this public internal contract.

- [ ] **Step 4: Add the new module to runtime syntax/self-validation discovery**

Inspect `plugins/krylo/scripts/validation/validate-runtime.mjs`. Ensure its script discovery validates the new file. If it already recursively discovers all `.mjs` files, add no special-case code and add only a test/assertion if necessary.

- [ ] **Step 5: Run focused and runtime validation**

Run:

```bash
node --test plugins/krylo/tests/unit/host-context.test.mjs
npm run syntax
npm run validate:runtime
```

Expected after implementation: exit 0 for all three commands.

- [ ] **Step 6: Commit locally**

```bash
git add plugins/krylo/scripts/lib/host-context.mjs plugins/krylo/tests/unit/host-context.test.mjs plugins/krylo/scripts/validation/validate-runtime.mjs
git commit -m "feat: add host-neutral runtime context"
```

Do not push.

---

## Task 3: Isolate Claude runtime environment and preserve the existing Claude data root

**Files:**
- Create: `plugins/krylo/scripts/host/claude/context.mjs`
- Create: `plugins/krylo/tests/unit/claude-context.test.mjs`
- Modify: `plugins/krylo/scripts/lib/paths.mjs`
- Modify: `plugins/krylo/scripts/lib/telemetry.mjs`
- Modify: `plugins/krylo/scripts/runtime/cleanup.mjs`
- Modify: `plugins/krylo/scripts/status/subagent-statusline.mjs`
- Modify later in Tasks 5-8: every Claude-facing runtime/Hook entrypoint that needs Core state.

**Interfaces:**
- Produces: `resolveClaudeSessionId`, `resolveClaudeDataRoot`, `resolveClaudePluginRoot`, `createClaudeHostIdentity`, `bootstrapClaudeStorageEnvironment`, `applyClaudeRuntimeEnvironment`, `bootstrapClaudeRuntimeEnvironment`.
- Shared modules consume only `KRYLO_*` runtime variables or normalized arguments.

**Compatibility rule:** A Claude run with no explicit test override must continue to use the same physical data root as 0.1.1. No state is moved to `~/.krylo/data` for Claude.

- [ ] **Step 1: Write failing Claude adapter tests**

Create `plugins/krylo/tests/unit/claude-context.test.mjs` covering these cases:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  resolveClaudeSessionId,
  resolveClaudeDataRoot,
  createClaudeHostIdentity,
  applyClaudeRuntimeEnvironment,
  bootstrapClaudeStorageEnvironment,
} from '../../scripts/host/claude/context.mjs';

test('explicit Claude session wins over Hook and legacy environment values', () => {
  const session = resolveClaudeSessionId({
    explicitSessionId: 'explicit',
    hookPayload: { session_id: 'hook' },
    env: { CLAUDE_SESSION_ID: 'legacy-env' },
  });
  assert.equal(session, 'explicit');
});

test('Hook session_id wins over legacy environment fallback', () => {
  const session = resolveClaudeSessionId({
    hookPayload: { session_id: 'hook' },
    env: { CLAUDE_SESSION_ID: 'legacy-env' },
  });
  assert.equal(session, 'hook');
});

test('legacy CLAUDE_SESSION_ID is isolated as the final Claude-only fallback', () => {
  const session = resolveClaudeSessionId({ env: { CLAUDE_SESSION_ID: 'legacy-env' } });
  assert.equal(session, 'legacy-env');
});

test('Claude data root preserves the 0.1.1 fallback path', () => {
  assert.equal(
    resolveClaudeDataRoot({}),
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'krylo'),
  );
});

test('CLAUDE_PLUGIN_DATA is translated to KRYLO_DATA_ROOT even for sessionless storage utilities', () => {
  const env = { CLAUDE_PLUGIN_DATA: path.resolve('tmp-data') };
  bootstrapClaudeStorageEnvironment({ env });
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data'));
});

test('Claude run bootstrap also records normalized host session identity', () => {
  const env = { CLAUDE_PLUGIN_DATA: path.resolve('tmp-data') };
  const identity = createClaudeHostIdentity({
    explicitSessionId: 's1',
    projectRoot: '.',
    env,
  });
  applyClaudeRuntimeEnvironment(identity, env);
  assert.equal(env.KRYLO_DATA_ROOT, path.resolve('tmp-data'));
  assert.equal(env.KRYLO_HOST, 'claude');
  assert.equal(env.KRYLO_HOST_SESSION_ID, 's1');
});

test('Claude plugin options map only into KRYLO internal option names', () => {
  const env = {
    CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: '2',
    CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'local-only',
    CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY: 'false',
    CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS: '7',
    CLAUDE_PLUGIN_OPTION_STATUS_DETAIL: 'detailed',
  };
  const identity = createClaudeHostIdentity({ explicitSessionId: 's2', projectRoot: '.', env });
  applyClaudeRuntimeEnvironment(identity, env);
  assert.equal(env.KRYLO_MAX_ORBIT_CYCLES, '2');
  assert.equal(env.KRYLO_SECURITY_PROFILE, 'local-only');
  assert.equal(env.KRYLO_LOCAL_TELEMETRY, 'false');
  assert.equal(env.KRYLO_TELEMETRY_RETENTION_DAYS, '7');
  assert.equal(env.KRYLO_STATUS_DETAIL, 'detailed');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails before implementation**

```bash
node --test plugins/krylo/tests/unit/claude-context.test.mjs
```

- [ ] **Step 3: Implement the Claude-only adapter**

Create `plugins/krylo/scripts/host/claude/context.mjs` with the following public behavior:

```js
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostIdentity } from '../../lib/host-context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_FROM_SOURCE = path.resolve(HERE, '..', '..', '..');

const OPTION_MAP = Object.freeze({
  CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES: 'KRYLO_MAX_ORBIT_CYCLES',
  CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE: 'KRYLO_SECURITY_PROFILE',
  CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY: 'KRYLO_LOCAL_TELEMETRY',
  CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS: 'KRYLO_TELEMETRY_RETENTION_DAYS',
  CLAUDE_PLUGIN_OPTION_STATUS_DETAIL: 'KRYLO_STATUS_DETAIL',
});

export function resolveClaudeSessionId({ explicitSessionId, hookPayload, env = process.env } = {}) {
  for (const value of [explicitSessionId, hookPayload?.session_id, env.CLAUDE_SESSION_ID]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

export function resolveClaudeDataRoot(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_DATA === 'string' && env.CLAUDE_PLUGIN_DATA.trim() !== '') {
    return path.resolve(env.CLAUDE_PLUGIN_DATA);
  }
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'krylo');
}

export function resolveClaudePluginRoot(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim() !== '') {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT);
  }
  return PLUGIN_ROOT_FROM_SOURCE;
}

export function createClaudeHostIdentity({ explicitSessionId, hookPayload, projectRoot = process.cwd(), env = process.env } = {}) {
  const hostSessionId = resolveClaudeSessionId({ explicitSessionId, hookPayload, env });
  if (!hostSessionId) throw new Error('Claude host session id is unavailable');
  return createHostIdentity({
    host: 'claude',
    hostSessionId,
    ...(typeof hookPayload?.prompt_id === 'string' && hookPayload.prompt_id.trim() !== '' ? { hostTurnId: hookPayload.prompt_id.trim() } : {}),
    projectRoot,
    pluginRoot: resolveClaudePluginRoot(env),
    dataRoot: resolveClaudeDataRoot(env),
    ...(typeof hookPayload?.permission_mode === 'string' && hookPayload.permission_mode.trim() !== '' ? { permissionMode: hookPayload.permission_mode.trim() } : {}),
  });
}

export function bootstrapClaudeStorageEnvironment({ env = process.env } = {}) {
  env.KRYLO_HOST = 'claude';
  env.KRYLO_DATA_ROOT = resolveClaudeDataRoot(env);
  for (const [source, target] of Object.entries(OPTION_MAP)) {
    if (typeof env[source] === 'string') env[target] = env[source];
  }
  return env;
}

export function applyClaudeRuntimeEnvironment(identity, env = process.env) {
  bootstrapClaudeStorageEnvironment({ env });
  env.KRYLO_HOST_SESSION_ID = identity.hostSessionId;
  return env;
}

export function bootstrapClaudeRuntimeEnvironment(options = {}) {
  const identity = createClaudeHostIdentity(options);
  applyClaudeRuntimeEnvironment(identity, options.env ?? process.env);
  return identity;
}
```

`hostTurnId` uses Claude `prompt_id` only as a host correlation identifier. Do not describe it as a numeric turn index.

- [ ] **Step 4: Make the shared data-root helper host-neutral**

Change `plugins/krylo/scripts/lib/paths.mjs::getDataRoot()` so it reads `KRYLO_DATA_ROOT`, not `CLAUDE_PLUGIN_DATA`:

```js
export function getDataRoot() {
  const envRoot = process.env.KRYLO_DATA_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') return path.resolve(envRoot);
  return path.join(os.homedir(), '.krylo', 'data');
}
```

The generic fallback is for future non-Claude standalone use. Claude-facing entrypoints must bootstrap `KRYLO_DATA_ROOT` first so current Claude users remain at the existing `.claude/plugins/data/krylo` path.

- [ ] **Step 5: Translate shared option reads to generic KRYLO names**

Change only shared runtime reads:

```text
CLAUDE_PLUGIN_OPTION_MAX_ORBIT_CYCLES      -> KRYLO_MAX_ORBIT_CYCLES
CLAUDE_PLUGIN_OPTION_SECURITY_PROFILE      -> KRYLO_SECURITY_PROFILE
CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY       -> KRYLO_LOCAL_TELEMETRY
CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS -> KRYLO_TELEMETRY_RETENTION_DAYS
CLAUDE_PLUGIN_OPTION_STATUS_DETAIL         -> KRYLO_STATUS_DETAIL
```

At minimum this affects:

```text
plugins/krylo/scripts/runtime/init-run.mjs
plugins/krylo/scripts/security/risk-gate.mjs, then risk-policy.mjs in Task 7
plugins/krylo/scripts/lib/telemetry.mjs
plugins/krylo/scripts/runtime/cleanup.mjs
plugins/krylo/scripts/status/subagent-statusline.mjs
```

Do not change Claude `userConfig` public keys. The Claude adapter performs translation.

- [ ] **Step 6: Update tests to distinguish host input variables from Core variables**

Test helpers that emulate a Claude host continue to set `CLAUDE_PLUGIN_DATA`, then execute a Claude-facing entrypoint that bootstraps it. Tests that call shared library functions directly set `KRYLO_DATA_ROOT` instead.

Do not leave unit tests passing merely because shared code still reads `CLAUDE_PLUGIN_DATA`.

- [ ] **Step 7: Add a static isolation assertion**

Add a governance or runtime validation assertion that scans shared runtime directories and fails if `CLAUDE_` appears outside the approved Claude host surface.

The allowed locations after Foundation are:

```text
plugins/krylo/scripts/host/claude/**
plugins/krylo/skills/run/SKILL.md
Claude-specific setup/reporting code that is explicitly documented as host UI, not Shared Core
```

The shared modules below must contain no `CLAUDE_` reads:

```text
plugins/krylo/scripts/lib/**
plugins/krylo/scripts/security/risk-policy.mjs
plugins/krylo/scripts/lib/state-migrations.mjs
```

- [ ] **Step 8: Run focused tests**

```bash
node --test plugins/krylo/tests/unit/claude-context.test.mjs
node --test plugins/krylo/tests/platform/paths.test.mjs
node --test plugins/krylo/tests/unit/telemetry.test.mjs
node --test plugins/krylo/tests/unit/cleanup.test.mjs
```

- [ ] **Step 9: Commit locally**

```bash
git add plugins/krylo/scripts/host/claude/context.mjs plugins/krylo/tests/unit/claude-context.test.mjs plugins/krylo/scripts/lib/paths.mjs plugins/krylo/scripts/lib/telemetry.mjs plugins/krylo/scripts/runtime/cleanup.mjs plugins/krylo/scripts/status/subagent-statusline.mjs plugins/krylo/scripts/validation/validate-runtime.mjs plugins/krylo/tests
git commit -m "refactor: isolate Claude runtime environment"
```

Do not push.

---

## Task 4: Migrate persisted run identity to schema 1.1.0 and host-scoped active-run pointers

**Files:**
- Create: `plugins/krylo/scripts/lib/state-migrations.mjs`
- Create: `plugins/krylo/tests/unit/state-migrations.test.mjs`
- Modify: `plugins/krylo/schemas/run-state.schema.json`
- Modify: `plugins/krylo/scripts/lib/state.mjs`
- Modify: `plugins/krylo/scripts/lib/paths.mjs`
- Modify: `plugins/krylo/tests/unit/state.test.mjs`
- Modify: `plugins/krylo/tests/unit/resume.test.mjs`
- Modify: `plugins/krylo/tests/platform/concurrency.test.mjs`
- Modify: `plugins/krylo/tests/platform/paths.test.mjs`
- Modify: `plugins/krylo/scripts/validation/validate-runtime.mjs`

**Interfaces:**
- State schema `1.1.0` replaces top-level `sessionId` with required `host` identity metadata and required `delegation` metadata.
- `writeActiveRunPointer({ runId, projectRootHash, host, hostSessionId })`.
- `readActiveRunPointer({ projectRootHash, host, hostSessionId })`.
- `clearActiveRunPointer({ projectRootHash, host, hostSessionId, runId })`.
- `migrateStateDocument(state)` upgrades only known prior schema `1.0.0`.

### Target persisted host object

```json
{
  "host": {
    "name": "claude",
    "sessionId": "session-1"
  },
  "delegation": {
    "externalWorker": false,
    "depth": 0
  }
}
```

Optional fields supported now for forward-compatible identity/delegation, but omitted unless known:

```json
{
  "host": { "turnId": "prompt-uuid" },
  "delegation": { "parentRunId": "run-parent" }
}
```

Keep delegation metadata separate from host identity: a host describes where the run executes; delegation describes how the run was reached.

Do not persist `permissionMode`, plugin root, data root, or raw project path in run state.

- [ ] **Step 1: Write failing schema/migration tests before changing state code**

Create tests that construct a real 1.0.0 fixture using the current field shape and assert migration to exactly 1.1.0:

```js
const legacy = {
  ...validLegacyFixture,
  schemaVersion: '1.0.0',
  sessionId: 'legacy-session',
  runId: 'run-legacy1234',
};

const result = migrateStateDocument(legacy);
assert.equal(result.ok, true);
assert.equal(result.migrated, true);
assert.equal(result.fromVersion, '1.0.0');
assert.equal(result.value.schemaVersion, '1.1.0');
assert.equal(result.value.host.name, 'claude');
assert.equal(result.value.host.sessionId, 'legacy-session');
assert.equal(result.value.delegation.externalWorker, false);
assert.equal(result.value.delegation.depth, 0);
assert.equal('sessionId' in result.value, false);
assert.equal(result.value.runId, legacy.runId);
```

Also test:

```text
- 1.1.0 returns unchanged with migrated=false.
- Unknown future/old schema is refused, not guessed.
- Migration does not mutate the input object.
- Secret/redaction fields are not added.
- Two concurrent loads of the same 1.0.0 fixture finish with one valid 1.1.0 state, at least one intact pre-migration backup, and no corrupted state.
```

- [ ] **Step 2: Run the new migration test and confirm it fails before implementation**

```bash
node --test plugins/krylo/tests/unit/state-migrations.test.mjs
```

- [ ] **Step 3: Implement `state-migrations.mjs`**

Use this exact public contract:

```js
export const CURRENT_STATE_SCHEMA_VERSION = '1.1.0';

export function migrateStateDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid-state-document' };
  }
  if (input.schemaVersion === CURRENT_STATE_SCHEMA_VERSION) {
    return { ok: true, migrated: false, value: structuredClone(input) };
  }
  if (input.schemaVersion !== '1.0.0') {
    return { ok: false, error: 'unsupported-schema-version', fromVersion: input.schemaVersion ?? null };
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    return { ok: false, error: 'legacy-session-id-missing', fromVersion: '1.0.0' };
  }

  const copy = structuredClone(input);
  const sessionId = copy.sessionId;
  delete copy.sessionId;
  copy.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
  copy.host = {
    name: 'claude',
    sessionId,
  };
  copy.delegation = {
    externalWorker: false,
    depth: 0,
  };
  return { ok: true, migrated: true, fromVersion: '1.0.0', value: copy };
}
```

- [ ] **Step 4: Update JSON Schema and hand-written validator together**

In `plugins/krylo/schemas/run-state.schema.json`:

```text
- Remove required top-level `sessionId`.
- Add required top-level `host`.
- Add required top-level `delegation`.
- Keep `runId` required and unchanged.
```

Define `host` exactly as:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "sessionId"],
  "properties": {
    "name": { "type": "string", "enum": ["claude", "codex"] },
    "sessionId": { "type": "string", "minLength": 1, "maxLength": 256 },
    "turnId": { "type": "string", "minLength": 1, "maxLength": 256 }
  }
}
```

Define required top-level `delegation` exactly as:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["externalWorker", "depth"],
  "properties": {
    "externalWorker": { "type": "boolean" },
    "depth": { "type": "integer", "minimum": 0, "maximum": 1 },
    "parentRunId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{4,64}$" }
  }
}
```

Update `REQUIRED_TOP_LEVEL`, `SCHEMA_VERSION`, `createInitialState`, and `validateState` in `state.mjs` to match exactly.

Change `createInitialState` from a `sessionId` parameter to a `hostIdentity` parameter:

```js
export function createInitialState({
  goalText,
  hostIdentity,
  projectDir,
  lane,
  risk,
  complexity,
  budget,
  kryloVersion,
  runId,
  git,
})
```

Persist:

```js
host: {
  name: hostIdentity.host,
  sessionId: hostIdentity.hostSessionId,
  ...(hostIdentity.hostTurnId ? { turnId: hostIdentity.hostTurnId } : {}),
},
delegation: {
  externalWorker: false,
  depth: 0,
},
```

Do not persist plugin/data roots.

- [ ] **Step 5: Make `loadState` version-aware and backup before migration write**

The order must be:

```text
read JSON
-> inspect schemaVersion
-> migrate known older version in memory
-> validate migrated document against current validator
-> copy original state.json to a unique pre-migration backup
-> atomically persist migrated state
-> return migrated state
```

Never validate a 1.0.0 file against only the 1.1.0 validator and incorrectly classify it as corruption.

Use backup names matching:

```text
state.pre-migration-1.0.0-<epoch>.json
```

If backup creation or migrated-state validation fails, leave the original `state.json` untouched and return a safe migration error. Do not delete the legacy file.

- [ ] **Step 6: Host-scope active-run pointer paths**

In `paths.mjs`, change from:

```text
active-runs/<projectRootHash>/<sessionSegment>.json
```

to:

```text
active-runs/<projectRootHash>/<host>/<sessionSegment>.json
```

Add exact helpers:

```js
export function activeRunsHostDir(projectRootHash, host) {
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, host);
}

export function activeRunPointerPath(projectRootHash, host, hostSessionId) {
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, host, `${safeSessionSegment(hostSessionId)}.json`);
}

export function legacyActiveRunPointerPath(projectRootHash, sessionId) {
  return safeJoin(getDataRoot(), 'active-runs', projectRootHash, `${safeSessionSegment(sessionId)}.json`);
}
```

Validate `host` against `HOST_NAMES` before using it as a path segment.

- [ ] **Step 7: Migrate current 0.1.1 pointer files lazily and safely**

For Claude only, when the new exact pointer is absent, check the old 0.1.1 path:

```text
active-runs/<projectRootHash>/<session>.json
```

If valid and matching the project:

```text
- write the new Claude host-scoped pointer atomically;
- remove the old pointer only after the new pointer exists;
- preserve runId and updatedAt where practical.
```

Keep the older `current-run.json` migration too. It also migrates into the `claude` host directory.

Pointer content becomes:

```json
{
  "runId": "run-...",
  "projectRootHash": "...",
  "host": "claude",
  "hostSessionId": "session-...",
  "updatedAt": "..."
}
```

- [ ] **Step 8: Update active-run APIs and terminal cleanup**

Use these signatures everywhere:

```js
writeActiveRunPointer({ runId, projectRootHash, host, hostSessionId })
readActiveRunPointer({ projectRootHash, host, hostSessionId })
clearActiveRunPointer({ projectRootHash, host, hostSessionId, runId })
```

`host` is required for lookup. `hostSessionId` is optional only for status/diagnostic callers. When it is absent, `readActiveRunPointer` may select the most recently updated pointer **inside that host directory only**. It must never scan another host's pointers as a fallback.

Rename/refactor the current project-wide pointer lister into a host-scoped implementation such as:

```js
function listHostPointers(projectRootHash, host) {
  const dir = activeRunsHostDir(projectRootHash, host);
  // read only *.json files directly under this host directory
}
```

`clearActiveRunPointerForState(state)` derives identity from:

```js
state.host.name
state.host.sessionId
state.runId
```

Remove the Claude-specific environment fallback from `readActiveRunPointerForCwd`. Replace it with normalized arguments, for example:

```js
export function readActiveRunPointerForCwd(cwd = process.cwd(), { host, hostSessionId } = {}) {
  if (!host) return { ok: false, error: 'host-required' };
  return readActiveRunPointer({
    projectRootHash: computeProjectRootHash(cwd),
    host,
    hostSessionId,
  });
}
```

A caller that knows no host must not silently assume Claude inside Shared Core.

Update `pruneStaleActiveRunPointers()` for the nested layout. It must traverse:

```text
active-runs/<project>/<host>/*.json
```

without following symlinked directories, and it must safely handle/migrate or remove stale legacy flat `active-runs/<project>/*.json` entries. Add a cleanup regression test proving one host's stale-pointer pruning cannot remove another host's active pointer.

- [ ] **Step 9: Update runtime self-validation to exercise the host-neutral API**

`plugins/krylo/scripts/validation/validate-runtime.mjs` already discovers every `.mjs` recursively, so do not add a file list. Change only its full runtime smoke fixture:

```js
const prevDataRoot = process.env.KRYLO_DATA_ROOT;
process.env.KRYLO_DATA_ROOT = tempRoot;
try {
  const hostIdentity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'validate-session',
    projectRoot: tempRoot,
    pluginRoot: path.resolve(__dirname, '..', '..'),
    dataRoot: tempRoot,
  });
  const state = createInitialState({
    goalText: 'validation smoke test goal',
    hostIdentity,
    projectDir: tempRoot,
    lane: 'BUILD',
    risk: 'low',
    complexity: 'trivial',
    budget: 3,
    kryloVersion: '0.0.0-validate',
  });
  // existing validate/save/load assertions remain
} finally {
  if (prevDataRoot === undefined) delete process.env.KRYLO_DATA_ROOT;
  else process.env.KRYLO_DATA_ROOT = prevDataRoot;
}
```

Remove the direct `CLAUDE_PLUGIN_DATA` dependency from this Shared Core validator.

- [ ] **Step 10: Update state/resume/path/concurrency tests**

Required assertions include:

```text
- New state validates with schemaVersion 1.1.0.
- New state has host.name=claude and no top-level sessionId.
- Loading a real 1.0.0 fixture creates one pre-migration backup and returns valid 1.1.0 state.
- Re-loading migrated state does not create another backup.
- Unsupported schema version is rejected without destructive overwrite.
- Old 0.1.1 pointer path migrates to active-runs/<project>/claude/<session>.json.
- pre-0.1.1 current-run.json still migrates.
- concurrent sessions in one project still do not collide.
- concurrent migration of one legacy state remains valid and idempotent after the race.
- two host names with the same session string cannot collide.
- path traversal and symlink-escape tests remain effective.
```

Update any test that hard-coded:

```text
active-runs/<projectRootHash>/session-cli-3.json
```

to:

```text
active-runs/<projectRootHash>/claude/session-cli-3.json
```

- [ ] **Step 11: Run the state migration test set**

```bash
node --test plugins/krylo/tests/unit/state-migrations.test.mjs
node --test plugins/krylo/tests/unit/state.test.mjs
node --test plugins/krylo/tests/unit/resume.test.mjs
node --test plugins/krylo/tests/platform/paths.test.mjs
node --test plugins/krylo/tests/platform/concurrency.test.mjs
npm run validate:runtime
```

Expected after implementation: exit 0. Record real counts only after running.

- [ ] **Step 12: Commit locally**

```bash
git add plugins/krylo/scripts/lib/state-migrations.mjs plugins/krylo/scripts/lib/state.mjs plugins/krylo/scripts/lib/paths.mjs plugins/krylo/schemas/run-state.schema.json plugins/krylo/scripts/validation/validate-runtime.mjs plugins/krylo/tests/unit/state-migrations.test.mjs plugins/krylo/tests/unit/state.test.mjs plugins/krylo/tests/unit/resume.test.mjs plugins/krylo/tests/platform/paths.test.mjs plugins/krylo/tests/platform/concurrency.test.mjs
git commit -m "feat: make run identity host-aware"
```

Do not push.

---

## Task 5: Normalize existing runtime CLIs through the Claude adapter without changing their public usage

**Files:**
- Modify: `plugins/krylo/scripts/runtime/init-run.mjs`
- Modify: `plugins/krylo/scripts/runtime/read-state.mjs`
- Modify: `plugins/krylo/scripts/runtime/update-state.mjs`
- Modify: `plugins/krylo/tests/unit/cli.test.mjs`
- Modify: `plugins/krylo/tests/unit/resume.test.mjs`

**Compatibility contract:**
- Existing `--session <id>` remains accepted.
- Existing `--run <runId>` remains accepted.
- Existing stdout JSON keys used by tests remain stable unless the approved design explicitly requires an additive field.
- Claude Skill commands do not need a new host flag.

- [ ] **Step 1: Add failing CLI assertions for host-aware state**

Extend `cli.test.mjs` so `init-run.mjs` with the current arguments asserts:

```js
assert.equal(state.schemaVersion, '1.1.0');
assert.equal(state.host.name, 'claude');
assert.equal(state.host.sessionId, 'session-cli-1');
assert.equal(state.delegation.externalWorker, false);
assert.equal(state.delegation.depth, 0);
assert.equal('sessionId' in state, false);
```

Also test that `read-state.mjs` and `update-state.mjs` can resolve the current run through the existing `--session` argument after pointer migration.

- [ ] **Step 2: Run focused CLI tests and confirm failures before wiring the adapter**

```bash
node --test plugins/krylo/tests/unit/cli.test.mjs
node --test plugins/krylo/tests/unit/resume.test.mjs
```

- [ ] **Step 3: Wire `init-run.mjs` to the Claude host adapter**

Preserve `--session`, but normalize it:

```js
const hostIdentity = bootstrapClaudeRuntimeEnvironment({
  explicitSessionId: args.session,
  projectRoot: projectDir,
});
```

Then call:

```js
createInitialState({
  goalText: args.goal,
  hostIdentity,
  projectDir,
  lane,
  risk,
  complexity,
  budget,
  kryloVersion: process.env.KRYLO_VERSION || 'unknown',
  runId,
  git,
});
```

Write the pointer with:

```js
writeActiveRunPointer({
  runId,
  projectRootHash: state.project.rootHash,
  host: hostIdentity.host,
  hostSessionId: hostIdentity.hostSessionId,
});
```

`computeBudget` reads `KRYLO_MAX_ORBIT_CYCLES`, not a Claude option variable.

- [ ] **Step 4: Wire `read-state.mjs` and `update-state.mjs` to Claude session normalization**

Delete their local `resolveSessionId` implementations. Use `resolveClaudeSessionId` and bootstrap the Claude runtime environment before state/pointer access.

Pointer lookup becomes:

```js
readActiveRunPointer({
  projectRootHash,
  host: 'claude',
  hostSessionId,
});
```

If `--run` is supplied, loading by `runId` remains valid and does not require pointer lookup. The data root still must be bootstrapped first.

- [ ] **Step 5: Preserve approval behavior while switching the internal security-profile variable**

`update-state.mjs` must read:

```js
process.env.KRYLO_SECURITY_PROFILE
```

for approval environment binding after the Claude adapter maps the current userConfig option.

- [ ] **Step 6: Verify all current CLI behavior remains intact**

Run:

```bash
node --test plugins/krylo/tests/unit/cli.test.mjs
node --test plugins/krylo/tests/unit/resume.test.mjs
node --test plugins/krylo/tests/hooks/risk-gate-approvals.test.mjs
```

Do not remove existing assertions for completion, question budget, approval expiry/consumption, redaction, or pointer cleanup.

- [ ] **Step 7: Commit locally**

```bash
git add plugins/krylo/scripts/runtime/init-run.mjs plugins/krylo/scripts/runtime/read-state.mjs plugins/krylo/scripts/runtime/update-state.mjs plugins/krylo/tests/unit/cli.test.mjs plugins/krylo/tests/unit/resume.test.mjs
git commit -m "refactor: normalize Claude runtime identity"
```

Do not push.

---

## Task 6: Split normalized active-run resolution from Claude Hook transport

**Files:**
- Create: `plugins/krylo/scripts/host/claude/hook-transport.mjs`
- Modify: `plugins/krylo/scripts/lib/hook-utils.mjs`
- Modify: `plugins/krylo/tests/hooks/helpers.mjs`
- Modify: all current Claude hook entry scripts listed below.

**Claude Hook entry scripts:**

```text
plugins/krylo/scripts/security/question-gate.mjs
plugins/krylo/scripts/security/risk-gate.mjs
plugins/krylo/scripts/runtime/posttool-telemetry.mjs
plugins/krylo/scripts/orbit/fingerprint.mjs
plugins/krylo/scripts/orbit/stop-gate.mjs
plugins/krylo/scripts/status/agent-events.mjs
```

**Interfaces:**
- Shared `resolveActiveRun({ projectRoot, host, hostSessionId })` has no knowledge of Claude payload field names.
- Claude transport owns `session_id`, `prompt_id`, `permission_mode`, PreToolUse JSON output, Stop block JSON output, and silent exit.

- [ ] **Step 1: Write/extend tests that lock current Claude Hook output**

Before refactoring, ensure fixtures assert exact protocol keys:

```js
assert.deepEqual(Object.keys(res.json.hookSpecificOutput).sort(), [
  'hookEventName',
  'permissionDecision',
  'permissionDecisionReason',
].sort());
assert.equal(res.json.hookSpecificOutput.hookEventName, 'PreToolUse');
```

For Stop blocking, retain an assertion equivalent to:

```js
assert.equal(res.json.decision, 'block');
assert.equal(typeof res.json.reason, 'string');
```

Add a fixture with both `session_id` and `prompt_id` and verify it resolves the correct active run without persisting the prompt ID unless run initialization explicitly knew it.

- [ ] **Step 2: Run current Hook tests before the split**

```bash
npm run test:hooks
```

Record the real baseline result.

- [ ] **Step 3: Make `hook-utils.mjs` host-neutral**

Keep bounded stdin JSON parsing and event-name extraction if useful, but change active-run resolution to this contract:

```js
export function resolveActiveRun({ projectRoot, host, hostSessionId }) {
  try {
    const projectRootHash = computeProjectRootHash(projectRoot);
    if (!host || !hostSessionId) return { active: false };
    const pointer = readActiveRunPointer({ projectRootHash, host, hostSessionId });
    if (!pointer.ok || !pointer.value?.runId) return { active: false };
    if (pointer.value.projectRootHash && pointer.value.projectRootHash !== projectRootHash) return { active: false };
    const loaded = loadState(pointer.value.runId);
    if (!loaded.ok || loaded.value.terminalState !== null) return { active: false };
    if (loaded.value.host.name !== host || loaded.value.host.sessionId !== hostSessionId) return { active: false };
    return { active: true, state: loaded.value };
  } catch {
    return { active: false };
  }
}
```

Remove Claude `payload.session_id` parsing and Claude output JSON from this shared module.

- [ ] **Step 4: Implement Claude Hook transport**

Create `plugins/krylo/scripts/host/claude/hook-transport.mjs` with exact interfaces:

```js
import { bootstrapClaudeRuntimeEnvironment } from './context.mjs';

export function normalizeClaudeHookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'invalid-payload' };
  try {
    const identity = bootstrapClaudeRuntimeEnvironment({
      hookPayload: payload,
      projectRoot: typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd : process.cwd(),
    });
    return { ok: true, identity, payload };
  } catch {
    return { ok: false, error: 'missing-host-identity' };
  }
}

export function emitClaudePreToolDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

export function emitClaudeStopBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

export function allowClaudeSilently() {
  process.exit(0);
}
```

If `normalizeClaudeHookPayload` cannot obtain a session ID, return inactive/fail-open behavior rather than binding to another session's most-recent pointer.

- [ ] **Step 5: Update every current Hook entrypoint to normalize before Core resolution**

Use the same pattern:

```js
const input = await readStdinJson();
if (!input.ok) allowClaudeSilently();
const normalized = normalizeClaudeHookPayload(input.value);
if (!normalized.ok) allowClaudeSilently();
const run = resolveActiveRun({
  projectRoot: normalized.identity.projectRoot,
  host: normalized.identity.host,
  hostSessionId: normalized.identity.hostSessionId,
});
if (!run.active) allowClaudeSilently();
```

Preserve each Hook's existing fail mode:

```text
Question gate: fail open.
Risk gate: fail safe while an active run is known; otherwise silent pass-through.
PostTool telemetry: fail open.
Fingerprint: fail open.
Agent events: fail open.
Stop: fail safe for completion logic but never trap the user on an internal Hook failure.
```

- [ ] **Step 6: Update Hook test helpers to emulate the Claude host deliberately**

`runHook()` keeps providing `CLAUDE_PLUGIN_DATA` because it is emulating Claude. The Hook adapter must translate that into `KRYLO_DATA_ROOT` before shared state access.

`createActiveRun()` continues using the current `--session hook-session` interface.

- [ ] **Step 7: Run full Hook tests**

```bash
npm run test:hooks
```

Expected after implementation: existing protocol and policy assertions remain green with no weakened cases.

- [ ] **Step 8: Commit locally**

```bash
git add plugins/krylo/scripts/host/claude/hook-transport.mjs plugins/krylo/scripts/lib/hook-utils.mjs plugins/krylo/scripts/security/question-gate.mjs plugins/krylo/scripts/security/risk-gate.mjs plugins/krylo/scripts/runtime/posttool-telemetry.mjs plugins/krylo/scripts/orbit/fingerprint.mjs plugins/krylo/scripts/orbit/stop-gate.mjs plugins/krylo/scripts/status/agent-events.mjs plugins/krylo/tests/hooks
git commit -m "refactor: separate Claude hook transport"
```

Do not push.

---

## Task 7: Extract shared risk policy from the Claude PreToolUse entrypoint

**Files:**
- Create: `plugins/krylo/scripts/security/risk-policy.mjs`
- Create: `plugins/krylo/tests/unit/risk-policy.test.mjs`
- Modify: `plugins/krylo/scripts/security/risk-gate.mjs`
- Modify: `plugins/krylo/tests/hooks/risk-gate.test.mjs`
- Modify: `plugins/krylo/tests/hooks/risk-gate-approvals.test.mjs`
- Modify: `plugins/krylo/tests/hooks/risk-gate-mcp.test.mjs`

> **Superseded by ADR-0025 (native permission approval), security-hardening checkpoint.** `consumeMatchingApproval()` and the KRYLO-local approval-consumption design this section describes were deleted: a KRYLO-local approval record must never independently authorize execution, for any tool (ADR-0025's stated security requirement). A `require-approval` classification is instead translated into Claude Code's native `permissionDecision: "ask"` for the Bash tool's `git-push`/`git-force` classes only (outside `bypassPermissions` mode); every other tool/class/mode keeps a deterministic `deny`. Any future host adapter (Codex included) must follow `scripts/security/risk-gate.mjs`'s actual current design, not the interface and worked example below, which describe the mechanism this checkpoint removed. Left unedited beneath this note as an accurate historical record of the original extraction plan.

**Interfaces (historical; see note above):**
- `classifyRiskAction(input)` returns a host-neutral decision without process exit/stdout. (Still accurate — unchanged by ADR-0025.)
- ~~`consumeMatchingApproval(input)` performs the existing atomic, scoped, single-use approval consumption using generic KRYLO environment input.~~ Deleted; see note above.
- Claude `risk-gate.mjs` translates the shared decision to Claude PreToolUse output. (Still accurate — unchanged by ADR-0025.)

### Shared decision shape

```js
{ action: 'pass', category: 'pass' }
{ action: 'deny', category: 'sensitive-path', reason: '...' }
{ action: 'deny', category: 'data-root-protection', reason: '...' }
{ action: 'require-approval', category: 'git-push', actionClass: 'git-push', reason: '...' }
```

- [ ] **Step 1: Write failing direct policy tests**

Create direct tests that do not spawn a Hook process:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRiskAction } from '../../scripts/security/risk-policy.mjs';

test('shared risk policy classifies git push without Claude Hook JSON', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    cwd: process.cwd(),
    dataRoot: '/tmp/krylo-data',
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-push');
  assert.equal('hookSpecificOutput' in result, false);
});

test('shared risk policy passes npm test', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot: '/tmp/krylo-data',
  });
  assert.equal(result.action, 'pass');
});

test('shared risk policy denies a protected secret path', () => {
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: '.env' },
    cwd: process.cwd(),
    dataRoot: '/tmp/krylo-data',
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
});
```

Use platform-safe temporary directories in the real test instead of assuming `/tmp` on Windows.

- [ ] **Step 2: Confirm direct policy tests fail before extraction**

```bash
node --test plugins/krylo/tests/unit/risk-policy.test.mjs
```

- [ ] **Step 3: Move classification logic, not behavior**

Move these responsibilities from `risk-gate.mjs` into `risk-policy.mjs`:

```text
production policy loading
command/action-class matching
sensitive-path matching
KRYLO data-root integrity classification
MCP classification integration
fingerprint calculation
safe target-label calculation
approval usability checks
atomic approval consumption
```

Do not move:

```text
stdin parsing
Claude payload field extraction
Claude Hook stdout format
process.exit calls
Claude model-facing instruction wording that is transport-specific
```

Use `process.env.KRYLO_SECURITY_PROFILE` only at the shared policy boundary, or pass the security profile explicitly from the adapter. Do not read a `CLAUDE_` variable in `risk-policy.mjs`.

- [ ] **Step 4: Keep approval consumption atomic and exactly scoped**

The shared function must retain the current checks:

```text
actionClass exact match
status === approved
projectRootHash binding when present
runId binding when present
environment binding when present
expiry
exact fingerprint binding when present
exclusive per-run file lock
status -> consumed
consumedAt timestamp
single save under the lock
```

No transport may bypass these checks.

- [ ] **Step 5: Make Claude `risk-gate.mjs` a thin adapter**

Its main flow becomes conceptually:

```js
const decision = classifyRiskAction({ toolName, toolInput, cwd, dataRoot: identity.dataRoot });

if (decision.action === 'pass') {
  recordEvent(state.runId, { event: 'risk-gate', category: decision.category, status: 'allowed' });
  allowClaudeSilently();
}

if (decision.action === 'deny') {
  recordEvent(state.runId, { event: 'risk-gate', category: decision.category, status: 'denied' });
  emitClaudePreToolDecision('deny', decision.reason);
}

if (decision.action === 'require-approval') {
  const consumed = consumeMatchingApproval({
    runId: state.runId,
    actionClass: decision.actionClass,
    toolName,
    toolInput,
    projectRootHash: state.project.rootHash,
    securityProfile: process.env.KRYLO_SECURITY_PROFILE ?? null,
  });
  if (consumed.consumed) {
    emitClaudePreToolDecision('allow', `Action class ${decision.actionClass} was approved by the user (${consumed.approvalId}) and is now spent.`);
  }
  emitClaudePreToolDecision('deny', `${decision.reason} Record it with update-state.mjs --request-approval ${decision.actionClass} --summary "<safe summary>" and stop at RISK_APPROVAL_REQUIRED.`);
}
```

Keep failure semantics unchanged.

- [ ] **Step 6: Run direct policy tests and all existing risk Hook tests**

```bash
node --test plugins/krylo/tests/unit/risk-policy.test.mjs
node --test plugins/krylo/tests/hooks/risk-gate.test.mjs
node --test plugins/krylo/tests/hooks/risk-gate-approvals.test.mjs
node --test plugins/krylo/tests/hooks/risk-gate-mcp.test.mjs
npm run test:security
```

Existing denied-command cases, sensitive-path cases, exact-target approvals, replay prevention, concurrent consumption, MCP trust, and data-root protection must remain intact. Never delete a difficult assertion to make the split pass.

- [ ] **Step 7: Commit locally**

```bash
git add plugins/krylo/scripts/security/risk-policy.mjs plugins/krylo/scripts/security/risk-gate.mjs plugins/krylo/tests/unit/risk-policy.test.mjs plugins/krylo/tests/hooks/risk-gate.test.mjs plugins/krylo/tests/hooks/risk-gate-approvals.test.mjs plugins/krylo/tests/hooks/risk-gate-mcp.test.mjs
git commit -m "refactor: extract shared risk policy"
```

Do not push.

---

## Task 8: Finish Claude-context normalization across question, Orbit, telemetry, agent, status, cleanup, and doctor paths

**Files:**
- Modify: `plugins/krylo/scripts/security/question-gate.mjs`
- Modify: `plugins/krylo/scripts/orbit/fingerprint.mjs`
- Modify: `plugins/krylo/scripts/orbit/stop-gate.mjs`
- Modify: `plugins/krylo/scripts/runtime/posttool-telemetry.mjs`
- Modify: `plugins/krylo/scripts/status/agent-events.mjs`
- Modify: `plugins/krylo/scripts/status/subagent-statusline.mjs`
- Modify: `plugins/krylo/scripts/runtime/cleanup.mjs`
- Modify: `plugins/krylo/scripts/setup/doctor.mjs`
- Modify: associated tests under `hooks/`, `status/`, `unit/`, and `setup/`.

**Produces:**
- No Shared Core path/session/option dependency on Claude-specific names.
- Same Claude observable behavior.

- [ ] **Step 1: Add a regression test for every Claude-facing path that needs the legacy data root**

For each direct CLI/status/setup path above, execute it with a temporary `CLAUDE_PLUGIN_DATA` and no `KRYLO_DATA_ROOT`, then assert that all KRYLO-owned writes/reads stay under the provided Claude data root after adapter bootstrap.

This must cover at least:

```text
posttool telemetry
failure fingerprint
question token consumption
stop-gate state mutation
agent event state mutation
status rendering
cleanup
Doctor storage probe
```

- [ ] **Step 2: Normalize Hook scripts through the same identity path**

Every Hook uses:

```text
read bounded stdin
-> normalizeClaudeHookPayload
-> resolveActiveRun(normalized identity)
-> shared state/policy
-> Claude transport output
```

No Hook directly parses `session_id` outside `host/claude/` after this task.

- [ ] **Step 3: Normalize statusline and Doctor without changing their user-facing scope**

`subagent-statusline.mjs` is currently a Claude status surface. It must call `bootstrapClaudeStorageEnvironment()` before Core storage access, then use `resolveClaudeSessionId()` when a session identifier is available and pass normalized `{ host: 'claude', hostSessionId }` to Core pointer resolution. If the session ID is unavailable, it may fall back to the most recent active Claude pointer for the project only if the existing behavior requires that fallback and tests prove it cannot cross into another host.

`cleanup.mjs` and `doctor.mjs` are sessionless storage utilities in this phase. They must call `bootstrapClaudeStorageEnvironment()` rather than `bootstrapClaudeRuntimeEnvironment()`. `doctor.mjs` may report Claude userConfig keys, but shared storage access must use the bootstrapped `KRYLO_DATA_ROOT`. Update the remediation wording so the host-specific configuration instruction remains accurate while the Core itself stays host-neutral.

- [ ] **Step 4: Translate remaining generic option reads**

Shared behavior uses:

```text
KRYLO_LOCAL_TELEMETRY
KRYLO_TELEMETRY_RETENTION_DAYS
KRYLO_STATUS_DETAIL
KRYLO_SECURITY_PROFILE
KRYLO_MAX_ORBIT_CYCLES
```

The Claude adapter is the only place that maps current `CLAUDE_PLUGIN_OPTION_*` names into these values.

- [ ] **Step 5: Run focused suites**

```bash
npm run test:hooks
npm run test:status
npm run test:setup
npm run test:unit
npm run test:platform
```

- [ ] **Step 6: Run a static Claude-coupling scan**

Use a deterministic scan, for example:

```bash
grep -R -n "CLAUDE_" plugins/krylo/scripts/lib plugins/krylo/scripts/security/risk-policy.mjs plugins/krylo/scripts/lib/state-migrations.mjs || true
```

Expected after Foundation: no matches in these Shared Core modules.

Then inspect all remaining script matches:

```bash
grep -R -n "CLAUDE_" plugins/krylo/scripts || true
```

Every remaining match must be deliberately Claude-host-specific and documented. Do not accept a stray Core dependency as “temporary” without an explicit follow-up task and ADR consequence.

- [ ] **Step 7: Commit locally**

```bash
git add plugins/krylo/scripts plugins/krylo/tests
git commit -m "refactor: normalize Claude host runtime paths"
```

Do not push.

---

## Task 9: Preserve the Claude `/krylo:run` contract and Skill-scoped Hook isolation

**Files:**
- Modify only if needed: `plugins/krylo/skills/run/SKILL.md`
- Verify: `plugins/krylo/hooks/hooks.json`
- Modify: `plugins/krylo/tests/governance/hook-scoping.test.mjs`
- Modify: `plugins/krylo/scripts/setup/doctor.mjs` if Hook script reference parsing changes.

**Compatibility boundary:** The Skill itself is a Claude Host asset. It is allowed to reference Claude placeholders. Shared runtime code is not.

- [ ] **Step 1: Probe the existing session-variable behavior before changing the Skill**

The current Skill passes:

```text
--session "${CLAUDE_SESSION_ID}"
```

Current official Hook docs document Hook `session_id`, but the current environment-variable reference does not document a general `CLAUDE_SESSION_ID` variable. Before changing the Skill, perform a controlled local plugin fixture/probe against the pinned supported Claude Code CLI and the current CLI to determine what the Skill body receives in practice.

The probe must not touch production or user configuration. Use local `--plugin-dir` or another documented local-development path.

Decision rule:

```text
If current behavior is proven and required for backward compatibility:
  Keep `${CLAUDE_SESSION_ID}` in the Claude Skill shell for Foundation, with all interpretation isolated in host/claude/context.mjs.

If it is not actually available/reliable:
  Stop this task and design a documented Claude-host session handoff that preserves ADR-0021 before editing runtime security. Do not invent an environment variable and do not add plugin-wide Hooks merely to obtain session identity.
```

Do not implement a multi-Hook sequencing trick: current Claude docs say all matching Hooks run in parallel.

- [ ] **Step 2: Keep all runtime Hooks Skill-scoped**

`plugins/krylo/hooks/hooks.json` must remain equivalent to:

```json
{
  "hooks": {}
}
```

`plugins/krylo/skills/run/SKILL.md` must continue to own the existing six event groups:

```text
PreToolUse: question gate
PreToolUse: risk gate
PostToolUse: telemetry
PostToolUseFailure: fingerprint
SubagentStart/SubagentStop: agent events
Stop: stop gate
```

- [ ] **Step 3: Do not modernize Hook command syntax unless the pinned floor proves it**

Current docs prefer exec form for path placeholders, but KRYLO's pinned minimum is the compatibility floor. If `command` + `args` support is not proven at that floor, keep the existing quoted command strings in this phase.

- [ ] **Step 4: Extend governance tests**

`hook-scoping.test.mjs` must prove:

```text
- plugin-wide hooks are empty;
- only the `run` Skill declares KRYLO runtime Hooks;
- all referenced scripts exist;
- no Codex Hook files were added in Foundation;
- `/krylo:run` remains user-invocable and disable-model-invocation remains true.
```

- [ ] **Step 5: Run Claude plugin validation and governance checks**

```bash
npm run test:governance
claude plugin validate --strict plugins/krylo
claude plugin validate --strict .
```

- [ ] **Step 6: Commit locally if the Skill/governance files changed**

```bash
git add plugins/krylo/skills/run/SKILL.md plugins/krylo/hooks/hooks.json plugins/krylo/tests/governance/hook-scoping.test.mjs plugins/krylo/scripts/setup/doctor.mjs
git commit -m "test: preserve Claude run hook isolation"
```

If no content changed, do not create an empty commit.

---

## Task 10: Update authoritative documentation to describe the implemented Foundation accurately

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PRODUCT_SPEC.md`
- Modify: `ARCHITECTURE.md`
- Modify: `SECURITY.md`
- Modify: `THREAT_MODEL.md`
- Modify: `docs/02-runtime-state-machine.md`
- Modify: `docs/05-model-routing.md`
- Modify: `docs/07-hooks-and-observability.md`
- Modify: `docs/21-public-api-and-schemas.md`
- Modify: `docs/process/FILE_MANIFEST.md`

**Documentation rule:** Distinguish “implemented Foundation” from “planned native Codex host.” Do not claim Codex installation/runtime support before Plan 2 is implemented and verified.

- [ ] **Step 1: Update `CLAUDE.md` while keeping it <=130 physical lines**

Required changes:

```text
- Add `docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` and the new Foundation plan to the repository source index.
- Update decision authority to require current official Claude Code and Codex docs for host-specific contracts.
- Replace “KRYLO is a public Claude Code plugin” as the whole-product statement with the approved multi-host product decision, while stating that the currently implemented/released host remains Claude until Codex Plan 2 lands.
- Keep `/krylo:run <task>` identified as the Claude public command.
- Replace the Core storage statement tied to `${CLAUDE_PLUGIN_DATA}` with host-provided/host-adapter-resolved KRYLO-owned data storage.
- Preserve every existing security, one-writer, explicit invocation, optional-adapter, telemetry, and publication boundary.
```

Verify:

```bash
wc -l CLAUDE.md
```

Required: `<= 130` physical lines.

- [ ] **Step 2: Update `PRODUCT_SPEC.md` without falsely claiming shipped Codex support**

Use wording equivalent to:

```text
KRYLO is an evidence-driven software-development orchestration product with Claude Code and Codex as approved first-class hosts. The 0.1.x shipped surface is the Claude Code plugin; KRYLO 0.2 adds the Codex host through the approved multi-host roadmap.
```

Preserve the existing Claude command and current-release success criteria as historical/current implementation facts. Add 0.2 goals rather than rewriting v0.1 history.

- [ ] **Step 3: Generalize `ARCHITECTURE.md` Core boundaries**

Document:

```text
Shared Core
Claude Host
Codex Host (planned until Plan 2)
HostContext/HostIdentity
KRYLO-owned runId
host-specific Hook transport
host-provided persistent data roots
```

Replace statements that imply the raw Claude session ID is the KRYLO run identity.

- [ ] **Step 4: Update runtime/schema docs**

`docs/02-runtime-state-machine.md` must describe schema `1.1.0` host identity and migration/backup behavior.

`docs/21-public-api-and-schemas.md` must describe:

```text
runId
host.name
host.sessionId
optional host.turnId
delegation.externalWorker
delegation.depth
delegation.parentRunId
```

It must also state that host roots and raw project paths are not persisted.

- [ ] **Step 5: Update Hooks/model docs only to the extent Foundation implements**

`docs/07-hooks-and-observability.md`:

```text
- Shared policy is host-neutral.
- Claude Hook transport remains Skill-scoped and uses current Claude schemas.
- Codex transport is not implemented in Foundation.
```

`docs/05-model-routing.md`:

```text
- Logical agent roles/capability requirements belong to KRYLO Core.
- Haiku/Sonnet/Opus/Fable mapping remains the Claude Host mapping.
- No Codex model names are selected in Foundation.
```

- [ ] **Step 6: Update security/threat model where the new trust boundary exists**

Add explicit host-adapter and cross-provider future boundaries without implying cross-harness is active yet. State that a host adapter may translate platform metadata but cannot redefine KRYLO risk/completion policy.

- [ ] **Step 7: Run documentation and plugin validation**

```bash
git diff --check
wc -l CLAUDE.md
npm run validate:runtime
claude plugin validate --strict plugins/krylo
claude plugin validate --strict .
```

- [ ] **Step 8: Commit locally**

```bash
git add CLAUDE.md PRODUCT_SPEC.md ARCHITECTURE.md SECURITY.md THREAT_MODEL.md docs/02-runtime-state-machine.md docs/05-model-routing.md docs/07-hooks-and-observability.md docs/21-public-api-and-schemas.md docs/process/FILE_MANIFEST.md
git commit -m "docs: document host-neutral KRYLO core"
```

Do not push.

---

## Task 11: Full Foundation verification, independent review, and hard stop before Codex implementation

**Files:**
- No planned feature code changes. Fix only confirmed Foundation defects found by verification/review.

**Exit criterion:** Claude behavior and security contracts are preserved, Shared Core no longer depends on Claude-specific identity/option/Hook-output names, state migration is safe, and the repository is ready for a separate Codex Host plan.

- [ ] **Step 1: Run syntax and runtime validation**

```bash
npm run syntax
npm run validate:runtime
```

Record the real exit code for each.

- [ ] **Step 2: Run targeted Foundation tests**

```bash
node --test plugins/krylo/tests/unit/host-context.test.mjs
node --test plugins/krylo/tests/unit/claude-context.test.mjs
node --test plugins/krylo/tests/unit/state-migrations.test.mjs
node --test plugins/krylo/tests/unit/risk-policy.test.mjs
node --test plugins/krylo/tests/unit/state.test.mjs
node --test plugins/krylo/tests/unit/cli.test.mjs
node --test plugins/krylo/tests/unit/resume.test.mjs
node --test plugins/krylo/tests/platform/paths.test.mjs
node --test plugins/krylo/tests/platform/concurrency.test.mjs
npm run test:hooks
npm run test:security
npm run test:status
npm run test:setup
npm run test:governance
```

Do not report counts until the commands actually run.

- [ ] **Step 3: Run the complete local suite**

```bash
npm test
```

Record real pass/fail/skip counts and exit status.

- [ ] **Step 4: Re-run strict Claude plugin/marketplace validation**

```bash
claude plugin validate --strict plugins/krylo
claude plugin validate --strict .
```

Also record the exact local Claude Code CLI version:

```bash
claude --version
```

If practical in the local environment, separately verify the pinned floor from ADR-0022 rather than assuming the installed current CLI proves floor compatibility.

- [ ] **Step 5: Enforce Shared Core Claude-coupling boundary**

Run:

```bash
grep -R -n "CLAUDE_" plugins/krylo/scripts/lib plugins/krylo/scripts/security/risk-policy.mjs plugins/krylo/scripts/lib/state-migrations.mjs || true
```

Required: no Claude-specific Core dependency.

Inspect all remaining matches:

```bash
grep -R -n "CLAUDE_" plugins/krylo/scripts plugins/krylo/skills/run/SKILL.md || true
```

Every remaining occurrence must belong to a documented Claude Host adapter/Skill/setup surface.

- [ ] **Step 6: Verify schema migration artifacts with a clean fixture**

Create an isolated temp data root containing a copied/synthetic valid schema-1.0.0 state and old pointer layout, then invoke the new read path. Never point this verification at the user's live plugin data directory. Verify:

```text
- original state gets a pre-migration backup;
- current state becomes 1.1.0;
- runId is unchanged;
- host.name is claude;
- host.sessionId equals the old sessionId;
- old top-level sessionId is gone;
- pointer migrates into the claude host directory;
- second read is idempotent;
- no file is written outside the temp KRYLO data root.
```

Keep this fixture in automated tests after proving it manually.

- [ ] **Step 7: Review security-sensitive diff independently**

The independent review must inspect at least:

```text
plugins/krylo/scripts/lib/host-context.mjs
plugins/krylo/scripts/lib/state-migrations.mjs
plugins/krylo/scripts/lib/paths.mjs
plugins/krylo/scripts/lib/state.mjs
plugins/krylo/scripts/host/claude/context.mjs
plugins/krylo/scripts/host/claude/hook-transport.mjs
plugins/krylo/scripts/security/risk-policy.mjs
plugins/krylo/scripts/security/risk-gate.mjs
plugins/krylo/schemas/run-state.schema.json
plugins/krylo/skills/run/SKILL.md
```

Review specifically for:

```text
approval replay or scope weakening
race conditions during state/pointer migration
schema migration data loss
path traversal or symlink escape
cross-session or future cross-host pointer collision
fail-open behavior accidentally introduced into risk/completion enforcement
Claude Hook output schema drift
telemetry leakage
silent data-root relocation
ordinary-session Hook overhead/regression
```

A reviewer who implemented the change is not sufficient as the only independent review evidence.

- [ ] **Step 8: Inspect final diff and repository status**

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Inspect the entire branch diff against the baseline:

```bash
git diff be76b9ff8302c428598e97f7e289734d08340fd1...HEAD --stat
git diff be76b9ff8302c428598e97f7e289734d08340fd1...HEAD
```

If `main` moved during implementation, compare against the actual branch point instead of blindly using the original SHA.

- [ ] **Step 9: Confirm Foundation exit conditions**

All must have evidence:

```text
- ADR-0023 exists and matches the approved design.
- Historical v0.1.0 IMPLEMENTATION_PLAN.md is unchanged.
- Claude `/krylo:run` remains the public Claude command.
- Claude runtime Hooks remain Skill-scoped; plugin-wide runtime hooks remain empty.
- Shared Core does not read Claude-specific session/option/Hook-output fields.
- KRYLO runId remains independent of host session ID.
- State schema 1.0.0 safely migrates to 1.1.0 with backup and validation.
- Active-run pointers are host-scoped and legacy Claude pointers migrate safely.
- Existing risk classifications and approval consumption remain behaviorally equivalent.
- Existing completion/Orbit/question/telemetry behavior remains regression-covered.
- No new runtime dependency was added.
- No Codex implementation was added prematurely.
- No version bump to 0.2.0 occurred.
- The partial 0.2 implementation remains off main and is not exposed as marketplace version 0.1.1.
```

- [ ] **Step 10: Stop before Plan 2**

Do not begin `CODEX_HOST_IMPLEMENTATION_PLAN.md` implementation until:

```text
- Foundation local verification is complete;
- independent review findings are resolved or explicitly accepted according to KRYLO policy;
- GitHub-hosted CI status is known after any later authorized push/PR;
- the user authorizes the next execution/repository-write boundary as applicable.
```

Do not push, merge to `main`, tag, release, publish to a Claude/OpenAI marketplace, deploy, access production, or perform another external write as part of this plan.

### Foundation rollback rule

Because this phase changes the run-state schema, it must remain an unreleased integration-branch change until the full 0.2 release plan is complete. Development verification uses only temporary/copied data roots. If Foundation must be abandoned before release, revert the Foundation commits on the feature branch rather than rewriting history. Do not restore a real user's `state.pre-migration-*` backup over newer state automatically; any real-data recovery requires explicit inspection and user approval. Downgrade behavior for a shipped 0.2 release belongs to `V0_2_RELEASE_IMPLEMENTATION_PLAN.md`.

---

## Foundation completion report format

When this plan is implemented, report in this exact structure:

```text
סיכום

ממצאים שאומתו

קבצים ששונו

החלטות ארכיטקטוניות

בדיקות ואימותים
- exact command
- exit status
- actual pass/fail/skip counts when available
- local vs GitHub-hosted distinction

ביקורת עצמאית

אבטחה ו-Supply Chain

Git וגרסה
- branch
- HEAD
- commits created
- KRYLO version
- CI state

פעולות שנותרו

פעולות שלא בוצעו
- push
- merge
- tag
- GitHub release
- Claude marketplace publication
- OpenAI plugin-directory publication
- deployment
- production access
- external writes
```

Do not claim any command, test, migration, validation, review, CI workflow, or compatibility check passed unless it was actually executed and its result observed.
