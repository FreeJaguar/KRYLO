# Codex Runtime Compatibility Gate -- Design

Companion to `docs/adr/0034-codex-runtime-compatibility-gate.md`, which carries the full research/evidence trail. This document is the decision-table/data-shape reference; read the ADR first for *why*.

## Contract file shape (`plugins/krylo/policies/codex-runtime-compatibility.json`)

```json
{
  "contractSchemaVersion": 1,
  "reviewedAt": "2026-09-02",
  "supported": [
    {
      "version": "0.120.0",
      "evidence": "...",
      "confirmedHookEvents": ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"],
      "notes": "..."
    }
  ],
  "blocked": [
    { "version": "0.0.0", "reason": "..." }
  ]
}
```

- `contractSchemaVersion`: integer. Exactly `1` is recognized this checkpoint. Any other value (including absent, non-integer, or a future higher version this code does not know about) is `contract-malformed`.
- `supported[].version` / `blocked[].version`: a bare `X.Y.Z` string, parsed with the existing `parseSemver`-shaped matcher in `scripts/lib/version-compare.mjs`'s `parseCodexVersion()` (already handles both `rust-vX.Y.Z` and `codex-cli X.Y.Z` input shapes; the contract itself stores the bare number). No ranges, no wildcards -- exact-match only.
- `supported[].confirmedHookEvents`: informational/audit only in this checkpoint (not re-verified by a live probe -- see ADR's rejected-secondary-probe section). Documents exactly what was reviewed, so a later checkpoint adding a live corroboration probe has real data to check against.
- `blocked[]` starts empty. A known-bad version is added only through a deliberate, reviewed edit (mirroring ADR-0022's Claude Code version-upgrade policy).
- Any version not found in `supported` or `blocked` is `unverified` -- this is the DEFAULT for every unlisted version, older or newer, per the task's own explicit requirement.

## Decision table (`evaluateCodexRuntimeCompatibility`)

| Condition | `status` | `trusted` |
|---|---|---|
| Contract file missing/unreadable | `contract-malformed` | `false` |
| Contract JSON parse failure | `contract-malformed` | `false` |
| `contractSchemaVersion` missing or not exactly `1` | `contract-malformed` | `false` |
| `supported`/`blocked` not arrays, or an entry missing `version` | `contract-malformed` | `false` |
| Codex executable cannot be resolved (`platformSpawnTarget` returns null) | `probe-failed` | `false` |
| `spawnSync` error, non-zero exit, or timeout | `probe-failed` | `false` |
| stdout does not match `codex-cli X.Y.Z` (via `parseCodexVersion`) | `probe-failed` | `false` |
| Parsed version exact-matches a `blocked[].version` | `blocked` | `false` |
| Parsed version exact-matches a `supported[].version` | `supported` | `true` |
| Parsed version matches neither list | `unverified` | `false` |

Every `trusted:false` row carries a `reason` string suitable for both the `additionalContext` hook output and a `findings[]` entry summary. `blocked` uses the contract's own `reason` field; `unverified`/`probe-failed`/`contract-malformed` use a fixed, precise message identifying which of these five conditions applied and (where known) the observed version string.

## Bootstrap integration (`user-prompt-submit-codex.mjs`)

Inserted immediately after `parseInvocation()` confirms an explicit `$krylo-run` and immediately before the existing idempotency/existing-run lookup (so an already-active, non-terminal run for this exact session is still reused first without re-probing -- the gate only matters for a genuinely NEW bootstrap attempt):

```
if not an explicit $krylo-run invocation -> allowSilently()   (unchanged)
if an active, non-terminal run already exists for this session -> reuse it (unchanged)
result = evaluateCodexRuntimeCompatibility({ cliPath: env.KRYLO_CODEX_CLI_PATH ?? 'codex', env })
if result.trusted:
    proceed with the existing bootstrap exactly as before this ADR
else:
    build initial state via createInitialState (same as before)
    push one finding: { severity: 'high', source: 'codex-runtime-compat', summary: result.reason }
    state.terminalState = 'SAFE_BLOCKED'; state.phase = 'BLOCKED'
    saveState(state)   -- no writeActiveRunPointer call at all
    emitAdditionalContext(`KRYLO Codex run <runId> could not start autonomously: <result.reason> ...`)
```

No other Codex hook (`risk-gate-codex.mjs`, `stop-gate-codex.mjs`, `session-start-codex.mjs`, `session-end-codex.mjs`, `posttool-telemetry-codex.mjs`) changes at all: `resolveActiveRun()`'s existing `terminalState !== null` check already makes a SAFE_BLOCKED-from-birth run inert to every one of them, and none of them ever had a pointer to find in the first place.

## Explicitly out of scope for this checkpoint

- Re-opening `codex-hooks.json`'s `SessionEnd` registration (ADR-0033) based on this checkpoint's own drift finding -- disclosed, not fixed here.
- A live, dynamic secondary capability probe (binary string-scan or `codex features list`) -- evaluated and rejected this checkpoint (see ADR).
- A network-backed hash/attestation lookup for the resolved executable -- forbidden as a mandatory Core dependency by the task itself.
- Extending this gate to Claude Code (ADR-0022 already covers Claude's own, differently-shaped compatibility policy at the CI/documentation level, not a runtime admission gate -- out of scope, not silently assumed equivalent).
- Any change to `require-approval` semantics, ADR-0029's approval boundary, or ADR-0032's project-hook ownership/merge design.

## Test strategy

- Pure-unit tests for `evaluateCodexRuntimeCompatibility()`/`loadCompatibilityContract()`/`probeCodexVersion()` against a fixture contract file and an injectable fake-CLI fixture (`tests/fixtures/codex-runtime-compat/`, mirroring the existing Cross-Harness `fake-worker` fixture's OS-wrapper-plus-`.mjs` shape) -- covers every row of the decision table above plus the minimum-coverage list from the task (missing Codex, malformed version, executable failure, timeout, malformed registry, unsupported registry schema, probe success, probe contradiction is N/A since no live corroboration probe exists this checkpoint).
- Integration tests through the real `user-prompt-submit-codex.mjs` subprocess (`tests/hooks/user-prompt-submit-codex.test.mjs`, extended) using `KRYLO_CODEX_CLI_PATH` pointed at the fake-CLI fixture -- proves the actual bootstrap-blocking behavior end to end: `$krylo-run` blocked for an unverified/blocked/probe-failed version reaches `SAFE_BLOCKED` with no active pointer; a supported version bootstraps exactly as before this ADR; an ordinary prompt and a same-session resume are both unaffected; the model cannot override the result via prompt content (a prompt containing fabricated compatibility claims has no effect, since the gate never reads `prompt` at all); Stop/SessionStart/SessionEnd/PreToolUse/PostToolUse behavior from ADR-0032/0033 is unaffected (existing test suites for those files re-run unmodified, expected to stay green).
- `tests/unit/risk-policy.test.mjs`: the new contract file and `runtime-compat.mjs` write protection (already covered by the existing `touchesPluginInstallation()` mechanism -- new regression cases naming both files explicitly; `runtime-compat.mjs` is deliberately NOT added to `HOOK_ENTRYPOINT_FILENAMES`, since unlike every entry already on that list it has no side-effecting `main()`/stdin consumer of its own to protect against direct invocation).
