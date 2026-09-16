# ADR-0039: Monthly Ecosystem Radar

## Status

Accepted

## Context

`docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 16 specifies a Monthly Ecosystem Radar as Phase 7 — the last feature in that document's phase plan that had never been implemented. ADR-0031 built a checker for KRYLO's own pinned dependencies; ADR-0036 built the Weekly Upstream Watch over integrations KRYLO has *already reviewed*. Neither looks outward at tools KRYLO does not yet know about, which is what Section 16 is for: *"The Radar looks for new tools that materially improve KRYLO instead of accumulating integrations for novelty."*

## The problem that shaped the whole design

Section 16.4 specifies a 100-point score. Its two largest dimensions — **Engineering value (20)** and **KRYLO architectural fit (15)** — are pure human judgement, and **Security and least privilege (15)** is at best half-measurable from metadata (negative signals are detectable; "least privilege" as a positive property is not). That is 50 of 100 points that no amount of repository metadata can honestly produce.

A checker that emitted a single 0-100 number would therefore be fabricating half of it, and presenting a triage verdict with an authority it had not earned. That is the exact failure mode this project rejects everywhere else, and it would be worse here than usual: the output's entire purpose is to tell a human where to spend scarce review attention.

### The resolution: a partial score that says so

Only dimensions genuinely derivable from metadata are computed — maintenance activity (10), CI presence (6), declared test script (4), host compatibility (10), license/provenance (5), dependency footprint (5), totalling 40 points. Every other dimension is emitted by name in `requiresHumanJudgement` **with its weight**, so the size of the gap is visible in the report rather than hidden inside a total. `scored` is never normalised to 100 and is always reported against `maxAvailable` — the sum of the maxima actually computed.

A dimension that could not be measured for a particular candidate is excluded from **both** the numerator and the denominator. An unknown and a zero are different things, and conflating them is how a triage tool starts lying.

Section 16.4's single "Testing and CI quality" dimension (10) is deliberately carried here as **two** dimensions of 6 and 4. They are read by two different upstream calls that can succeed independently, and a scoring model whose unit of knowledge is coarser than its unit of measurement cannot express "I learned half of this" — which is exactly the defect recorded below. Host compatibility is scored from the repository's own GitHub topics and is therefore **self-declared**: it measures a claim of host affinity, not verified compatibility, and its absent case is reported as "declares no host affinity" rather than as incompatibility, because silence is not a negative finding.

### Risk penalties: detectable ones only, and the rest named

Section 16.4's penalty list mixes the detectable (`install-lifecycle-scripts`, `unclear-licensing`, `abandoned-maintenance`, `excessive-dependency-footprint`) with things that require reading a candidate's actual behaviour (`broad-secret-access`, `unexplained-source-code-egress`, `remote-code-execution-or-unsafe-downloads`, …). The Radar applies the first group and reports the second in an explicit `undetectable` list. **An undetectable penalty is never recorded as absent** — the difference between "we checked and it's clean" and "we never checked" is the whole point.

## Decision

### Sources are a reviewed policy, not ad-hoc queries

`plugins/krylo/catalog/radar-sources.json` holds the query set, each entry carrying an `id`, `category`, `query` and a written `rationale`, plus explicit bounds. Every query runs against GitHub's own public search API — the only discovery interface in scope that is public, stable, documented, and already inside `upstream-client.mjs`'s fixed domain allowlist. Blog posts, awesome-lists, social feeds, package-registry search and vendor directories without a documented stable API were considered and rejected as brittle or unreviewable, per Section 16.2's instruction to skip rather than scrape. A test asserts every shipped query declares its rationale, so the policy stays reviewable rather than accreting.

### Classification is conservative in both directions

`REJECT` is reserved for hard, individually sufficient disqualifiers metadata really does establish — an archived repository, or one with no license, is not a judgement call. `AUDIT_RECOMMENDED` means only **"a human should look at this"**, which is the strongest claim automated triage is entitled to make; it never means "adopt", and nothing in this subsystem can move a candidate into `catalog/tools.json`. `WATCH` is the honest default.

The precedence, in the order `classifyCandidate` actually applies it: hard disqualifiers first, then trust-catalog membership, then a detected install-lifecycle-script penalty, then the score ratio. So a candidate already in the trust catalog is `WATCH` — its upstream drift is the Weekly Upstream Watch's job, not the Radar's — **except** when a hard disqualifier applies, which is checked first on purpose. An already-reviewed tool that has since been archived or lost its license is the most useful thing a run can surface, and suppressing that because the tool is already trusted would invert the point; the rationale text names the catalog entry so the verdict cannot be misread as being about a fresh candidate. An earlier draft of this ADR claimed catalog membership was unconditional, which the shipped ordering contradicted; the ordering is the deliberate behaviour and this text now follows it.

### A flaw found by running it, not by reasoning about it

The first live run surfaced a real defect in the scoring model: a candidate that did **not** get a deep-inspection slot scored `25/25` — a perfect ratio over three dimensions — and outranked a fully-inspected candidate at `32/40`. The ratio rewarded *knowing less*. A candidate without a deep inspection can now reach `WATCH` on metadata alone but never `AUDIT_RECOMMENDED`, because a partial look cannot justify spending a human audit slot. Regression-tested.

### The defect an independent review found, and what it changed

A security review of the completed implementation found the central honesty claim broken in two places at once, both reproduced against the committed code:

`deepInspect` made two upstream calls — the CI directory and `package.json` — and reported the result through a **single** `inspected` flag set from whichever call happened to succeed. A repository with CI and no readable `package.json` therefore came back as "inspected", and the two package-derived risk penalties then fell out of `applied` **and** out of `undetectable`. The report showed a candidate with no risk line, which is indistinguishable from one that was checked and found clean — the precise claim this ADR exists to refuse, reached by every Python or Go candidate whose `package.json` request 404s or is rate-limited, from queries this Radar ships. A direct comparison against the committed module confirmed `deepInspected: true` with the penalty absent from both lists; after the fix the same input reports `deepInspected: false` with the penalty declared undetectable.

The fix is a split rather than a patched condition: `ciInspected` and `packageInspected` are tracked separately, each dimension and penalty keys on the probe it actually depends on, and `isFullyInspected` gates the audit recommendation. A `not-found` response is treated as an **answer** — a repository with no `.github/workflows` genuinely has no Actions CI — while a rate limit, timeout or unparseable body means the probe did not run.

A second review then caught that same over-claim reintroduced inside the fix itself, in a narrower and more confident form. Treating a 404 on `package.json` as an answer was extended one step too far: the branch set `dependencyCount: 0`, so the footprint dimension awarded a full 5/5 for "zero runtime dependencies" to a repository whose dependencies had never been read, both package-derived penalties again fell out of `applied` and `undetectable` alike, and the candidate was promoted to `AUDIT_RECOMMENDED` with no qualifying line anywhere in the report. A missing **root** `package.json` is not a missing manifest: a monorepo keeps one in `packages/<name>/`, and a Python or Go candidate keeps its dependencies where this Radar does not look — and `topic:mcp-server`, one of the four shipped queries, returns mostly such repositories, so this was the ordinary path rather than an edge case.

The distinction the code now carries is three-valued, because two values could not express it: `packageInspected` says the request was answered, `packagePresent` says there was something there to read. A candidate with no root manifest is still **fully inspected** and can still earn `AUDIT_RECOMMENDED` on what was genuinely measured — honesty must not collapse into refusing to rank anything — but it earns nothing and is charged nothing for what was not measured, so `dependency-footprint` and `declared-test-script` are both reported unknown rather than as a 5 and a 0 respectively. Those two errors point in opposite directions, which is worth recording: the same missing evidence produced a fabricated positive in one dimension and a fabricated negative in the other. That distinction is the whole difference between a measurement and a gap, and it now also holds at the client layer: GitHub reports an exhausted primary rate limit as `403` with `x-ratelimit-remaining: 0`, which previously surfaced as the catch-all `unexpected-status` and read like a broken endpoint rather than a probe that never happened.

Second, the `undetectable` list was computed correctly and then **never rendered**. The text report is the only output the scheduled workflow produces, so a correctly-computed honesty signal that no human ever sees is not a control. Undetectable penalties and incomplete probes are now printed beside the `risk:` line, with the report stating plainly that a "not checked" line is not a clean bill of health.

### The third review, and the root cause

A third review, run deliberately on a **different model family**, found the same family in five more places — none of which the first two had reached, and all of them outside the probe logic the first two had concentrated on:

- A `package.json` whose entire content is `null`, `false`, `[]`, or `{"dependencies": false, "scripts": 42}` **parses cleanly**. The old `typeof x === 'object'` guards then substituted `{}` and reported a confident 5/5 "zero runtime dependencies" and a measured "declares no test script". This one is directly publishable by any candidate.
- A workspace root (`{"private": true, "workspaces": ["packages/*"]}`) is a *valid* manifest describing the repository's layout, not its dependencies. It scored 5/5 while `packages/server` could declare a hundred dependencies and a `postinstall` hook that this Radar never fetches.
- `optionalDependencies` were excluded from the count, so 31 of them scored as dependency-free.
- An absent or unparseable `pushed_at` returned `{points: 0, signal: 'unknown-last-push'}` **without** the `unknown` flag: the honest-looking string sat on top of a fabricated denominator. Excluding the dimension actually measured moves such a candidate from 26/40 to 26/30, which *clears* the audit threshold — the error was suppressing candidates, not just mis-scoring them.
- `license: {spdx_id: {}}` earned 2/5 as `declared ([object Object])` **and** cleared the `unclear-licensing` penalty: points and a clean bill for a value that could not be read. Absent `topics` became a measured "declares no host affinity", and an absent `archived` flag cleared the abandonment penalty without establishing anything.
- A 200 response carrying the wrong shape was read as data: `{ok: true, json: {unexpected: true}}` from the CI probe became a measured *absence* of CI, and from search became a source that "found zero results" while `sourcesUnavailable` stayed at zero.

The root cause was structural rather than local, which is why patching each occurrence kept producing the next one: **there was no single place that answered "is this value usable as a measurement?"**. Every scorer improvised its own check, and every improvisation defaulted to a confident value. The fix introduces that one place — a small set of validators (`usableString`, `usableBoolean`, `usableArray`, `usableObject`) and a shared `unmeasured()` shape — and routes every dimension and every penalty through it. Risk penalties became genuinely three-state (applied / checked-and-absent / undetectable) and are now evaluated **per penalty** rather than behind one shared condition, after the review found a payload where the footprint *dimension* was unknown while the footprint *penalty* was silently cleared from the same data in the same run.

The rule these encode, stated once: **transport success is not data validity, a successful parse is not a schema check, and an absent field is not a zero.**

### The fourth review, and the guard that finally closes the family

A fourth review found the same family again, three of the occurrences **inside the fix for the third**:

- `scopeLimited` detected only npm's array form of `workspaces`. Yarn's object form, and pnpm and lerna (which declare workspaces in their own files, not in `package.json`), all still scored a perfect 5/5 "zero runtime dependencies" — and the candidate declares that shape itself. The fix detects `workspaces` in any shape and probes the two marker files; a marker that cannot be *read* leaves the scope unestablished rather than assumed absent.
- Making the metadata dimensions correctly unmeasurable reopened the ranking inversion through a new door: `isFullyInspected` checked only the two network probes, so a candidate with both probes green and three metadata dimensions missing scored a perfect **15/15** and outranked a fully-measured **39/40**.
- The renderer printed only the *names* of unmeasured dimensions. Every reason string the same commit had just created was computed, stored, and never shown: three different facts collapsed into one word, which is the same computed-but-never-rendered defect this ADR already records once.
- The candidate header still read `license: none` where the scorer had concluded `unavailable`, and `[object Object]` for a malformed value — the most prominent line for each candidate contradicting the dimension directly beneath it.

**The guard that closes the family rather than the instance.** `classifyCandidate` now keys `AUDIT_RECOMMENDED` on **measurement completeness** (`unknownDimensions.length === 0`), not on probe completion. It no longer matters *which* dimension becomes unmeasurable, now or in any future change: an unknown can never buy a promotion. The secondary ordering stays raw `scored` rather than the ratio, deliberately — a ratio tiebreak would restore the very inversion this guard closes, because a ratio over fewer dimensions is easier to max out.

**A position this ADR previously held twice, now resolved.** An earlier round argued a non-Node candidate "can still earn an audit", reasoning that honesty must not collapse into refusing to rank anything. The fourth review showed where that leads. The resolved position: a candidate with unmeasured dimensions is still fully ranked, scored and reported, and can never be promoted *above* candidates measured in full. `WATCH` here is not a refusal to rank; it is "recorded, but not worth a human audit slot ahead of candidates we actually measured."

**A defect found by the tests written for the review.** `encodeURIComponent('..')` returns `'..'` unchanged, because a dot is unreserved. A dot-only owner or repository name therefore survived encoding and the URL parser normalised it away, turning `/repos/{owner}/{repo}/contents/x` into `/contents/x`, a different API endpoint. The host allowlist held, so this was never an SSRF, but the request stopped asking what the caller asked. These names arrive from third-party search results and, for the Weekly Upstream Watch, from `uses:` text this project treats as untrusted. Every `/repos` endpoint builder now refuses a dot-only segment before any request leaves the process.

**Reachability, measured rather than assumed.** Across 40 live GitHub search results, `archived` was a boolean 40/40, `topics` an array 40/40, `pushed_at` parseable 40/40, and the `license` field was always present (`null` for unlicensed). The malformed-metadata branches are therefore defences against a hostile or changed upstream, not against normal GitHub behaviour — the client validates JSON syntax, never schema. Saying that plainly matters more than implying the branches fire routinely.

The general lesson is recorded because it recurred twelve times across four reviews, three of them inside the fixes for the previous occurrence: the failure was never a wrong number but a **wrong claim**, produced by a data structure too coarse to represent partial knowledge and by a renderer that dropped the part that qualified it. Each time, the tempting repair was to widen what counts as "measured" — and each time that is what produced the next over-claim. The reliable direction is the opposite one: add a value to the state, not a case to the condition. Regression tests now cover the half-completed inspection shape specifically, which no existing test had reached; the exported `classifyCandidate` guard also defaults to the restrictive value, so a caller that omits it cannot silently disable it.

Two smaller defects were caught by running it: `hasCiWorkflows` was hardcoded `false` with a comment promising a caller would fill it in that never did — six of that dimension's ten points were unearnable and every candidate was silently marked down for a check that never ran — and the offline report carried no summary, so the renderer printed "0 sources unavailable" directly beneath a list of unavailable sources.

### Least-privilege scheduled workflow

`.github/workflows/ecosystem-radar.yml`: monthly cron plus `workflow_dispatch`, `permissions: contents: read` with exactly one permissions block, `persist-credentials: false`, actions pinned to full 40-hex SHAs, never `push`/`pull_request` triggered, exit 0 even when candidates are found. The job summary is written inside a fenced block because the report embeds third-party repository names and descriptions and the summary renders as Markdown — the same hardening ADR-0036 applies for the same reason.

Section 16.5's prohibitions are structural rather than promised: the module references no `child_process`/`exec*`/`spawn*` **and no filesystem write API at all** (`writeFileSync`, `appendFileSync`, `rmSync`, `mkdirSync`), asserted by test. A module that cannot spawn a process cannot install or execute a candidate, and one that cannot write cannot mutate the trust catalog.

## Verified live

Run against the real GitHub search API while building this: four reviewed queries returned 15 results each, deduplicated into ranked candidates with real licenses, maintenance signals, scores and rationales. The 44 unit tests are hermetic (injected client) and cover the scoring honesty properties, every classification branch and its precedence, the full and half-completed inspection guards, the answer-versus-gap distinction between a 404 and a rate limit, unreadable-source failures, control characters from all four families in attacker-authored text — C0, C1, the U+2028/U+2029 line separators, and the bidi overrides, isolates and zero-width characters that rewrite what a human reads while the bytes say something else, the eight adversarial metadata and manifest shapes the third review reproduced, and the structural no-write/no-exec properties — the last widened from a list of exact names to the call families they belong to, since a structural guarantee is only as strong as the width of what it matches.

## Consequences

- No new dependency, no new secret, no new network host beyond the GitHub API allowlist, no repository-write automation.
- KRYLO Core is untouched: purely additive read-only tooling with no runtime coupling to Orbit, the risk gate, or either host adapter.
- Phase 7 completes the phase plan in `MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md`. Section 17's manual deep-audit workflow remains explicitly out of scope, as that section itself anticipates ("may be added after the scheduled maintenance workflows are stable").
- The Radar's output will list candidates every month. None of them is adopted, trusted, or reviewed by this subsystem; converting one into a catalog entry stays a separate, human-initiated review.

## Supersedes

None. Implements design Section 16 / Phase 7.

## Superseded by

None.
