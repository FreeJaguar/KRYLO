# ADR-0037: Codex enforcement verified live, end to end

## Status

Accepted

## Context

`docs/adr/0035-codex-live-hook-verification.md` ran the first authenticated Codex session and proved hooks fire and that `$krylo-run` bootstraps a real run — but it could not reach a single event that fires *after* the model call, because every session ended at `ERROR: Your workspace is out of credits` before the model ran. That left the most important question in the entire Codex host still open: **does KRYLO's risk gate actually block anything on Codex, or does it merely run?**

Credits became available. This checkpoint answers that question with observed output.

## Method

Same isolation as ADR-0035: a temporary `CODEX_HOME` with only `auth.json` copied in, a throwaway `git init` project with no remote configured, an isolated `KRYLO_DATA_ROOT`, and the plugin installed from the current merged `main`. Sessions ran `codex exec` non-interactively against `codex-cli 0.154.0` (the binary KRYLO's own resolution selects).

Reaching the post-bootstrap code paths needs an *active* run, which the ADR-0034 compatibility gate correctly refuses for an unreviewed runtime. A **sandbox-only** contract listing `0.154.0` was supplied through the sanctioned `KRYLO_CODEX_COMPAT_TEST_MODE=1` + `KRYLO_CODEX_COMPAT_CONTRACT_PATH` override. **The shipped contract is unchanged and still lists `0.120.0` alone**; the override exists precisely so a test can reach these paths without editing reviewed policy.

## The enforcement boundary is real

### A `require-approval` action is blocked, live

```text
hook: PreToolUse
ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook:
  Git push requires explicit user approval unless the active task explicitly
  requested the exact action. ... Command: git push origin main
hook: PreToolUse Blocked
```

The model then reported: *"Automatic approval review rejected it via a `PreToolUse` hook ... Despite your explicit request, the hook blocked the command."* The prompt had explicitly instructed it to run the command without asking.

Note `hook: PreToolUse **Blocked**` — a distinct status from `Completed`, so a KRYLO denial is unambiguously distinguishable in the transcript from Codex's own rejections.

### A hard-deny classification is blocked, live

```text
hook: PreToolUse
ERROR ... error=Command blocked by PreToolUse hook: Secret files are off-limits
  to KRYLO. This command touches a protected secret path.. Command: cat .env
hook: PreToolUse Blocked
```

### The gate is not blanket-denying

A benign command inside the same kind of active run was allowed and **actually executed** — `git status --short` returned real output — with `hook: PreToolUse Completed`, then `hook: PostToolUse` / `Completed`. So `PostToolUse` fires live too, and the telemetry written for that run contains counters only:

```json
{"event":"risk-gate-codex","status":"allowed","category":"pass","ts":"..."}
{"event":"tool","toolName":"Bash","ts":"..."}
{"event":"stop-block","cycle":1,"ts":"..."}
```

No command text, no prompt, no path, no secret — matching `docs/22-privacy-and-telemetry.md`.

### The Orbit Stop gate holds a session open, live

`hook: Stop Blocked` was observed whenever an active, non-terminal run existed — the Codex Stop gate (ADR-0033) deciding, not merely firing. `hook: Stop Completed` appears instead once the run is terminal.

### The coordination layer works too

On a `SAFE_BLOCKED` session the model read the emitted `additionalContext` and refused the task on its own, reporting the exact reason and run id to the user. ADR-0035 had listed "whether the MODEL then observes the emitted `additionalContext`" as unverified; it does.

## Two environment findings that matter operationally

### Overwriting `config.toml` silently uninstalls the plugin

`codex plugin add` records the registry **inside `config.toml`**:

```toml
[marketplaces.krylo-marketplace]
source_type = "local"
source = '\\?\C:\Projects\krylo'

[plugins."krylo@krylo-marketplace"]
enabled = true
```

Hand-writing that file to add an unrelated setting (here: a `[projects."…"] trust_level` entry) **erased the plugin registration**. Every KRYLO hook then stopped firing — with no error, no warning, and a session that looks completely normal. It was only caught because `codex plugin list` showed unrelated plugins where KRYLO should have been. Anyone editing their Codex config by hand, or any tool that rewrites it, can silently lose KRYLO's Codex enforcement. `/krylo:doctor` does not currently check Codex plugin registration; that is now a concrete follow-up rather than a hypothetical.

### Codex's own execpolicy blocks the shell before KRYLO's verdict can matter

Under default non-interactive settings, every command Codex issues on Windows is wrapped as `powershell.exe -Command …`, and Codex rejects that itself:

```text
CreateProcess { message: "Rejected(\"… powershell.exe -Command 'echo hello' ` rejected: blocked by policy\")" }
```

Confirmed as Codex's own behaviour, not KRYLO's, by a controlled run with the plugin removed — identical rejection. `--approve-for-me` (Codex's automatic approval review in the workspace-write sandbox) is what let commands actually execute. This does not weaken KRYLO's boundary; it means that in the strictest sandbox configuration, nothing executes regardless, so KRYLO's allow/deny is moot there.

## Hook-event recognition changed since 0.120.0

Direct byte-inspection of the installed `codex.exe` (285 MB, 0.154.0) finds **every** hook event name present: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `PreCompact`.

ADR-0029 and ADR-0034 recorded `SessionEnd` and `PermissionRequest` as **absent** from `0.120.0`'s embedded enum, which is why `codex-hooks.json` registers `SessionEnd` on source evidence alone and why `permission-request-codex.mjs` ships unregistered. Both facts were true for `0.120.0` and are **no longer true for `0.154.0`**. This resolves, for current builds, the standing contradiction an independent reviewer flagged between `codex-hooks.json`'s own comment and ADR-0034's finding.

String presence is weaker evidence than observed firing, and is reported as such.

## What remains unverified, stated plainly

- ~~**`SessionEnd` never fired**~~ **Corrected the same day (see the addendum below): it does fire.**
- **The bootstrap-failure marker's PreToolUse deny was not exercised live.** The marker is confirmed written to disk on a real `SAFE_BLOCKED` session, but the deny path needs the model to *attempt* a tool call, and the model complied with the advisory text every time — including when explicitly instructed to attempt the call anyway. That is a good result for the coordination layer and a gap in the evidence for the enforcement fallback, which remains covered by fixture tests only. KRYLO's own design says enforcement must not depend on model cooperation; that property is still unproven live.
- **`PermissionRequest`, `SubagentStart`/`SubagentStop`, `PreCompact`** are recognized by the build but unregistered and unexercised.
- Hook trust and project trust were bypassed/preconfigured for the sandbox rather than exercised through their real review flows.

## Consequences

- The Codex host's primary security boundary is no longer "implemented and fixture-tested" — it is **observed blocking real model-issued commands**, for both the `require-approval` and hard-deny classes, with KRYLO's own reason text reaching the model.
- **The compatibility contract is still unchanged.** This checkpoint now supplies genuine evidence that `0.154.0` behaves correctly under KRYLO on every path exercised above, which is the input a human decision to add it would need — but adding a supported version remains a reviewed, human-made edit per ADR-0034, and the `SessionEnd`/marker gaps above are part of what that decision should weigh.
- Two concrete follow-ups fall out: `/krylo:doctor` should verify Codex plugin registration (the `config.toml` hazard), and `permission-request-codex.mjs` may now be registrable on current builds.

## Supersedes

None. Extends `docs/adr/0035-codex-live-hook-verification.md`, closing the post-model-call gap that ADR disclosed. Does not modify ADR-0034's contract or decision.

## Superseded by

None.

## Addendum: the `SessionEnd` finding above was wrong, and is corrected here

While verifying the follow-on contract change (`docs/adr/0038-codex-0154-supported.md`), a run with a genuinely **active** KRYLO run wrote this telemetry line:

```json
{"event":"session-end","cycle":0,"ts":"..."}
```

Only `scripts/status/session-end-codex.mjs` emits that, so `SessionEnd` **does** fire on `codex-cli 0.154.0`.

The earlier conclusion was a misread of silence. That script's very first action is `if (!run.active) allowCodexSilently()` — by design it no-ops, with no output and no telemetry, whenever the run is terminal or absent. Every session in the original round above ended `SAFE_BLOCKED`, i.e. terminal, so the hook could fire and still leave no trace. Absence of evidence was recorded as evidence of absence; it was not.

Left standing as originally written: the marker-deny path is still unexercised live, and `PermissionRequest`/`SubagentStart`/`SubagentStop`/`PreCompact` remain unregistered.
