# ADR-0038: `codex-cli 0.154.0` added to the reviewed compatibility contract

## Status

Accepted

## Context

ADR-0034 introduced the Codex Runtime Compatibility Gate and its contract, and set the rule that governs this decision: *"Adding a new supported (or blocked) version is a deliberate, reviewed, human-made edit to `plugins/krylo/policies/codex-runtime-compatibility.json` plus this ADR (or a superseding one) — never automatic, never CI-driven, never a side effect of an unrelated commit."*

Until now the contract listed `0.120.0` alone, so every current Codex build was `SAFE_BLOCKED`. That was correct while nothing about a newer runtime had been proven — but it also meant the Codex host was unusable on any machine running a current Codex, including the one this project is developed on. The gate was doing exactly its job and the honest fix was evidence, not a looser gate.

ADR-0037 produced that evidence.

## Decision

`0.154.0` is added to `supported`. `0.120.0` stays exactly as it was; the change is purely additive, and `blocked` remains empty.

### What the approval rests on — all observed, none inferred

Against a real authenticated `codex exec` session on `codex-cli 0.154.0`, in an isolated `CODEX_HOME` (full transcripts and method in ADR-0037):

- `UserPromptSubmit` bootstraps a run bound to the genuine host `session_id`.
- `PreToolUse` fires **and blocks** a real model-issued command, for a `require-approval` class and for a hard-deny (secret-path) class, surfacing KRYLO's own reason to the model — which acknowledged being blocked despite a prompt explicitly instructing it to proceed without asking.
- A benign command in the same configuration is **allowed and actually executes**, so the gate is not blanket-denying.
- `PostToolUse` fires, and the telemetry written carries counters only — no command text, prompt, path, or secret.
- The Orbit `Stop` gate decides correctly: `hook: Stop Blocked` while a run is active and non-terminal, `Completed` once terminal.
- `SessionEnd` fires (confirmed by its telemetry marker on an active run).

After the contract edit, a run with **no override of any kind** was re-verified live: `$krylo-run` on `0.154.0` now bootstraps a normal **active** run (`terminalState: null`) instead of `SAFE_BLOCKED`, which is the whole point of the change.

### What it does not rest on — the residuals this approval accepts

These are recorded in the contract entry's own `notes` field, not only here, so anyone reading the policy sees the limits of the approval without leaving the file:

- **The bootstrap-failure marker's own `PreToolUse` deny is still fixture-tested only.** Exercising it live needs the model to attempt a tool call on a `SAFE_BLOCKED` session, and it complied with the advisory every time — including when explicitly told to attempt the call anyway. KRYLO's stated principle is that enforcement must not depend on model cooperation; for this one path that property remains unproven live.
- **The enforcement boundary was not separately re-observed on the shipped-contract path.** It was observed twice on an equally-active run created through the sandbox contract. The compatibility gate runs only at `UserPromptSubmit` and the `PreToolUse` gate never reads the contract at all, so the enforcement code path is identical regardless of where the contract came from — but that is reasoning, and it is labelled as reasoning rather than counted as an observation.
- **Hook trust and project trust were bypassed or preconfigured** in the sandbox rather than exercised through their real review flows. On a real machine, hooks that are never trusted never run, and there is no KRYLO enforcement until they are.
- **`PermissionRequest`, `SubagentStart`/`SubagentStop`, `PreCompact`** are recognized by this build but remain unregistered and unexercised.
- **Version identity is per-binary, not per-machine.** This was verified against the npm-installed `codex.exe` that KRYLO's own `spawn-platform.mjs` resolution selects. A separate, natively-installed `0.153.4` exists on the same machine and was **not** verified. A human running `codex` interactively may therefore be on a different binary than the one the gate probes.

## Consequences

- KRYLO's Codex host becomes usable on current builds: `$krylo-run` bootstraps a real, enforced, active run on `0.154.0`.
- Nothing about the gate's design, the approval boundary, the risk classification, or any Claude-host behaviour changes. This is a data edit to a reviewed policy file, plus the ADR that justifies it.
- `0.153.4` remains unlisted and therefore still `SAFE_BLOCKED`. That is deliberate: it was never verified, and adding it on the assumption that a neighbouring patch version behaves identically is exactly the inference this contract exists to forbid.
- The two follow-ups ADR-0037 identified stand unchanged: `/krylo:doctor` should verify Codex plugin registration, and `permission-request-codex.mjs` may now be registrable.

## Supersedes

None. Applies ADR-0034's own amendment procedure for the first time. Does not modify ADR-0034's decision, gate design, or failure semantics.

## Superseded by

None.
