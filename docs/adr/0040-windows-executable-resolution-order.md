# ADR-0040: Resolve Windows executables in the order Windows itself resolves them

## Status

Accepted

## Context

ADR-0034 established a Codex runtime compatibility contract: KRYLO probes the installed Codex version, matches it exactly against a reviewed allowlist, and refuses a full autonomous run on anything unreviewed. ADR-0038 added `0.154.0` to that allowlist. The control's entire value rests on one assumption that nothing had ever checked: that the binary KRYLO probes is the binary the host will run.

On a machine with two Codex installations, it was not.

`plugins/krylo/scripts/lib/spawn-platform.mjs` resolved a bare command name by running `where`, filtering the results to directories that `PATH` itself lists (a deliberate control against a planted decoy, added after two earlier security reviews, and untouched by this ADR), and then selecting:

```js
const cmdCandidate = candidates.find((c) => c.toLowerCase().endsWith('.cmd'));
const exeCandidate = candidates.find((c) => c.toLowerCase().endsWith('.exe'));
return cmdCandidate || exeCandidate || candidates[0] || null;
```

That prefers `.cmd` over `.exe` **unconditionally**, which inverts Windows' own precedence.

## What this produced, measured on a real machine

```
where codex
  C:\Users\...\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe     <- Windows runs this
  C:\Users\...\AppData\Roaming\npm\codex
  C:\Users\...\AppData\Roaming\npm\codex.cmd                          <- KRYLO resolved this

PATHEXT = .COM;.EXE;.BAT;.CMD        (.EXE precedes .CMD)
```

KRYLO followed the `.cmd` shim to the npm package and reported **that package's** version. At the moment of discovery the two installations held different versions — the standalone `codex.exe` was `0.153.4`, which is **not** in the contract, while the npm package was `0.154.0`, which is. `evaluateCodexRuntimeCompatibility` returned:

```json
{ "trusted": true, "status": "supported", "version": "0.154.0" }
```

So the gate verified one binary while the host would run another, and **failed open**: the unreviewed runtime was cleared for a full autonomous run because a different, reviewed runtime happened to be installed alongside it.

The same resolver serves the Cross-Harness advisory workers (ADR-0030) and the project-scoped hook launcher (ADR-0032), so the mismatch was not confined to version reporting: KRYLO would spawn one Codex while the user's own `codex` invocations — the ones its hooks run inside — used another.

### Why the symptom disappearing is not the defect being fixed

Both installations were subsequently updated to `0.154.0`, and the gate now returns the correct answer. It returns it **by coincidence**: the resolver still selects the wrong binary, which now happens to carry the right version. The two installations diverged once, through one auto-updating ahead of the other, and nothing prevents that recurring. A control that is correct only while two independent artefacts happen to agree is not a control.

## Decision

Resolution emulates the two nested orders Windows actually applies, and the code says which is which:

1. **PATH directory order.** The first directory containing any executable match wins outright, whatever later directories hold. Directory order is taken from `where`'s own output, which is PATH order.
2. **`PATHEXT` precedence within that directory.** A stem present as both `tool.exe` and `tool.cmd` in one directory resolves to the `.exe` under the default `.COM;.EXE;.BAT;.CMD`.

`PATHEXT` is read from the environment rather than hardcoded, falling back to the documented Windows default when it is absent or unusable. A name match with no runnable extension — npm ships an extensionless bash shim beside its `.cmd`, and `where` lists it — does not make its directory a match, because Windows would not execute it. No runnable candidate resolves to `null` rather than to a guess.

The PATH-membership filter that precedes this selection is unchanged. A decoy outside a PATH directory is already rejected before these candidates arrive, and that control's reasoning (recorded at length in the module) is independent of this one.

## Consequences

- The compatibility gate now verifies the binary the host will run. On the machine above it resolves `codex` to `...\Local\Programs\OpenAI\Codex\bin\codex.exe`, matching `where`'s first entry.
- `claude` resolution is unchanged: it is npm-installed with only a `.cmd`, which still resolves through its shim exactly as before. `node` and `git` are unchanged. `npm` was already unresolved before this change and still is — pre-existing and fail-closed, not a regression.
- A machine with a single Codex installation sees no behavioural change at all.
- Nine tests pin the ordering **rule** rather than today's outcome, including an end-to-end case that plants a real `.exe` and `.cmd` in two temporary PATH directories. Six of them fail against the previous rule, including the end-to-end one.
- No change to the contract in `codex-runtime-compatibility.json`, and no version added or removed. This ADR changes only which binary the existing contract is evaluated against.

## A note on how this was found

The mismatch surfaced while preparing an unrelated review, from a one-line discrepancy: `codex --version` printed `0.153.4` in the shell while KRYLO's own probe reported `0.154.0`. Two numbers that should have been the same. The generalisable point is that the compatibility gate had never been asked to prove it was looking at the right artefact — the contract, the allowlist, the exact-match rule and the refusal path were all correct and all downstream of an unverified assumption.

## Supersedes

None. Fixes an implementation defect in the resolver that ADR-0034's gate, ADR-0030's workers and ADR-0032's launcher all depend on.

## Superseded by

None.
