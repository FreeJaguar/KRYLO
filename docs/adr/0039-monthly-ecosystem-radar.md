# ADR-0039: Monthly Ecosystem Radar

## Status

Accepted

## Context

`docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 16 specifies a Monthly Ecosystem Radar as Phase 7 — the last feature in that document's phase plan that had never been implemented. ADR-0031 built a checker for KRYLO's own pinned dependencies; ADR-0036 built the Weekly Upstream Watch over integrations KRYLO has *already reviewed*. Neither looks outward at tools KRYLO does not yet know about, which is what Section 16 is for: *"The Radar looks for new tools that materially improve KRYLO instead of accumulating integrations for novelty."*

## The problem that shaped the whole design

Section 16.4 specifies a 100-point score. Its two largest dimensions — **Engineering value (20)** and **KRYLO architectural fit (15)** — are pure human judgement, and **Security and least privilege (15)** is at best half-measurable from metadata (negative signals are detectable; "least privilege" as a positive property is not). That is 50 of 100 points that no amount of repository metadata can honestly produce.

A checker that emitted a single 0-100 number would therefore be fabricating half of it, and presenting a triage verdict with an authority it had not earned. That is the exact failure mode this project rejects everywhere else, and it would be worse here than usual: the output's entire purpose is to tell a human where to spend scarce review attention.

### The resolution: a partial score that says so

Only dimensions genuinely derivable from metadata are computed — maintenance activity, testing/CI presence, host compatibility, license/provenance, dependency footprint (40 points). Every other dimension is emitted by name in `requiresHumanJudgement` **with its weight**, so the size of the gap is visible in the report rather than hidden inside a total. `scored` is never normalised to 100 and is always reported against `maxAvailable` — the sum of the maxima actually computed.

A dimension that could not be measured for a particular candidate is excluded from **both** the numerator and the denominator. An unknown and a zero are different things, and conflating them is how a triage tool starts lying.

### Risk penalties: detectable ones only, and the rest named

Section 16.4's penalty list mixes the detectable (`install-lifecycle-scripts`, `unclear-licensing`, `abandoned-maintenance`, `excessive-dependency-footprint`) with things that require reading a candidate's actual behaviour (`broad-secret-access`, `unexplained-source-code-egress`, `remote-code-execution-or-unsafe-downloads`, …). The Radar applies the first group and reports the second in an explicit `undetectable` list. **An undetectable penalty is never recorded as absent** — the difference between "we checked and it's clean" and "we never checked" is the whole point.

## Decision

### Sources are a reviewed policy, not ad-hoc queries

`plugins/krylo/catalog/radar-sources.json` holds the query set, each entry carrying an `id`, `category`, `query` and a written `rationale`, plus explicit bounds. Every query runs against GitHub's own public search API — the only discovery interface in scope that is public, stable, documented, and already inside `upstream-client.mjs`'s fixed domain allowlist. Blog posts, awesome-lists, social feeds, package-registry search and vendor directories without a documented stable API were considered and rejected as brittle or unreviewable, per Section 16.2's instruction to skip rather than scrape. A test asserts every shipped query declares its rationale, so the policy stays reviewable rather than accreting.

### Classification is conservative in both directions

`REJECT` is reserved for hard, individually sufficient disqualifiers metadata really does establish — an archived repository, or one with no license, is not a judgement call. `AUDIT_RECOMMENDED` means only **"a human should look at this"**, which is the strongest claim automated triage is entitled to make; it never means "adopt", and nothing in this subsystem can move a candidate into `catalog/tools.json`. `WATCH` is the honest default. A candidate already in the trust catalog is always `WATCH`: its upstream drift is the Weekly Upstream Watch's job, not the Radar's.

### A flaw found by running it, not by reasoning about it

The first live run surfaced a real defect in the scoring model: a candidate that did **not** get a deep-inspection slot scored `25/25` — a perfect ratio over three dimensions — and outranked a fully-inspected candidate at `32/40`. The ratio rewarded *knowing less*. A candidate without a deep inspection can now reach `WATCH` on metadata alone but never `AUDIT_RECOMMENDED`, because a partial look cannot justify spending a human audit slot. Regression-tested.

Two smaller defects were caught the same way: `hasCiWorkflows` was hardcoded `false` with a comment promising a caller would fill it in that never did — six of that dimension's ten points were unearnable and every candidate was silently marked down for a check that never ran — and the offline report carried no summary, so the renderer printed "0 sources unavailable" directly beneath a list of unavailable sources.

### Least-privilege scheduled workflow

`.github/workflows/ecosystem-radar.yml`: monthly cron plus `workflow_dispatch`, `permissions: contents: read` with exactly one permissions block, `persist-credentials: false`, actions pinned to full 40-hex SHAs, never `push`/`pull_request` triggered, exit 0 even when candidates are found. The job summary is written inside a fenced block because the report embeds third-party repository names and descriptions and the summary renders as Markdown — the same hardening ADR-0036 applies for the same reason.

Section 16.5's prohibitions are structural rather than promised: the module references no `child_process`/`exec*`/`spawn*` **and no filesystem write API at all** (`writeFileSync`, `appendFileSync`, `rmSync`, `mkdirSync`), asserted by test. A module that cannot spawn a process cannot install or execute a candidate, and one that cannot write cannot mutate the trust catalog.

## Verified live

Run against the real GitHub search API while building this: four reviewed queries returned 15 results each, deduplicated into ranked candidates with real licenses, maintenance signals, scores and rationales. The 16 unit tests are hermetic (injected client) and cover the scoring honesty properties, every classification branch, the deep-inspection guard, rate-limited and unreadable-source failures, control characters in attacker-authored text, and the structural no-write/no-exec properties.

## Consequences

- No new dependency, no new secret, no new network host beyond the GitHub API allowlist, no repository-write automation.
- KRYLO Core is untouched: purely additive read-only tooling with no runtime coupling to Orbit, the risk gate, or either host adapter.
- Phase 7 completes the phase plan in `MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md`. Section 17's manual deep-audit workflow remains explicitly out of scope, as that section itself anticipates ("may be added after the scheduled maintenance workflows are stable").
- The Radar's output will list candidates every month. None of them is adopted, trusted, or reviewed by this subsystem; converting one into a catalog entry stays a separate, human-initiated review.

## Supersedes

None. Implements design Section 16 / Phase 7.

## Superseded by

None.
