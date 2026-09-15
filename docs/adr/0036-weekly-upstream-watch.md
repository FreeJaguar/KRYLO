# ADR-0036: Weekly Upstream Watch

## Status

Accepted

## Context

`docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md` Section 15 specifies a Weekly Upstream Watch, listed as Phase 6 of that document's own phase plan. It has never been implemented. ADR-0031 built a narrower, different thing — a drift checker for KRYLO's *own* pinned platform dependencies (Claude Code, Codex, GitHub Action pins, Node, npm) — and said so explicitly: "a future Weekly Upstream Watch (design doc Section 15) or Monthly Ecosystem Radar (Section 16) remains separate, unimplemented, out-of-scope work."

The gap this closes is real and distinct: `plugins/krylo/catalog/tools.json` records what KRYLO *reviewed*, at an exact version or commit. Nothing noticed when those upstream projects moved on. A reviewed integration can gain an install script, a new MCP write capability, a changed license, or a new hook months after review, and KRYLO had no signal at all.

## Decision

### Watch configuration and trusted review data stay separate files, deliberately

`plugins/krylo/catalog/upstream-watch.json` holds watch configuration only: which reviewed integrations to observe, at what cadence, and which change classes matter for each. Every entry declares `reviewedRefSource: "tools.json"` and carries **no ref of its own** — the baseline is read from the trusted catalog at runtime, so the two can never disagree, and a reviewer editing `tools.json` never has to remember to edit a second file.

Nothing observed upstream is ever written back to either catalog. The scheduled run emits `observedLatestRef` to the job summary and an artifact, exactly as design Section 15.3 requires, because the alternative — scheduled automation committing an unreviewed upstream ref into repository state — would turn the trust catalog into a record of what upstream currently is rather than what KRYLO actually reviewed. A regression test asserts the watch policy carries no `observedLatestRef`/`reviewedVersion`/`reviewedCommit`/`latest` key, and another asserts a real run leaves both catalog files byte-identical.

### Delta analysis reads paths and metadata, never content, never execution

On drift, the checker fetches GitHub's compare endpoint and classifies from the changed-file **path list** alone. It consumes `files[].filename` and `total_commits`; it deliberately does not read the patch text or commit messages the same response carries, both of which are upstream-authored untrusted content.

Path rules map to design Section 15.4's analysis dimensions — `package-lifecycle`, `install-scripts`, `hooks`, `plugin-manifests`, `mcp-inventory`, `license`, `binaries`, `credentials-or-network-config`. Any hit escalates to `SECURITY_REVIEW_REQUIRED`. A delta that is exclusively documentation is `DRIFT_LOW_RISK`. Anything else is `REVIEW_REQUIRED`.

Section 15.5's prohibitions are enforced structurally rather than promised: the checker module references no `child_process`, `exec*`, or `spawn*` at all (asserted by test), and the workflow file is asserted to contain no `npm install`/`npm ci`/`npx`/`pip install`/`yarn add`/`pnpm add`/`git clone`/`curl`/`wget` in any executable line. A module that cannot spawn a process cannot run a candidate's install script, hook, MCP server, or build system.

### Failure never becomes a clean bill of health

Every transport failure — timeout, network error, rate limiting, HTTP error, malformed JSON — resolves to `SOURCE_UNAVAILABLE`, and `SOURCE_UNAVAILABLE` outranks `NO_DRIFT` when computing the run's headline verdict, so a run that could not see upstream never presents itself as healthy. Drift whose change list could not be read stays `REVIEW_REQUIRED` rather than being downgraded. An empty changed-file list is also `REVIEW_REQUIRED`, not low risk: the refs differ by definition at that point, so "no files" means the comparison did not explain the difference (GitHub truncates very large diffs), and treating an unexplained difference as safe is precisely the silent downgrade this subsystem exists to prevent.

### Exactly design Section 15.6's five classifications

`NO_DRIFT`, `DRIFT_LOW_RISK`, `REVIEW_REQUIRED`, `SECURITY_REVIEW_REQUIRED`, `SOURCE_UNAVAILABLE` — no sixth value is ever emitted, asserted by test. A changed upstream ref is never promoted into `tools.json`; a deep re-review remains a separate, human-initiated process against an exact source and exact ref.

### One narrow ref-spelling tolerance, disclosed in the report

Found live: `tools.json` records OmniRoute at `3.8.49` while the repository tags it `v3.8.49`, so the compare 404s and the entry would degrade to "unanalyzed" permanently. The checker retries once with the `v`-prefixed spelling — only when the recorded form returned `not-found`, only when the ref is otherwise an exact numeric-dotted version, and it records `comparedUsingRef` in the result so the report never implies the recorded ref resolved as written. Any other mismatch stays a failure rather than becoming a search for something plausible.

### Least-privilege scheduled workflow

`.github/workflows/upstream-watch.yml`: weekly cron plus `workflow_dispatch`, `permissions: contents: read` and exactly one permissions block, `persist-credentials: false`, every action pinned to a full 40-hex SHA (verified by the repository's own `actions-pins-resolve-to-stated-release` check), never triggered by `push`/`pull_request`, and exit 0 even when drift is found — drift is evidence for a human review, never a build failure that could block a PR or a release.

## Scope: what this watches today, and what it honestly cannot

Three entries are watchable now, because their `tools.json` records name a real GitHub source and a real reviewed ref: `mattpocock-skills`, `omniroute`, `code-review-graph`.

Design Section 15.2 also names Superpowers and the OpenWiki provider integration. Both are recorded with `source: "detected-locally"` and no reviewed ref — there is no exact upstream source to observe and no baseline to compare against, so watching them would mean inventing a source KRYLO never reviewed. They are listed in the policy's own `notWatchedYet` block so the gap is visible rather than silently absent, and become watchable the moment their catalog record names a real source and ref. The nine remaining `tools.json` entries are either non-GitHub vendor sources or still `pending-first-review`; an entry with no reviewed baseline reports `SOURCE_UNAVAILABLE` with that exact reason rather than being skipped.

## Verified live, not only by fixture

Run against the real upstream repositories while building this ADR, and all three entries produced substantive results: `mattpocock-skills` has moved from the reviewed commit to `v1.2.3` (99 files, 102 commits, touching `package-lifecycle` and `plugin-manifests`); `omniroute` from `3.8.49` to `v3.8.50` (300 files, touching `install-scripts`, `mcp-inventory`, `package-lifecycle`, `credentials-or-network-config`); `code-review-graph` from the reviewed commit to `v2.3.8` (174 files, `package-lifecycle`). All three classify `SECURITY_REVIEW_REQUIRED` — which is the correct, useful answer: every one of them has drifted materially since review, and nothing in the repository had noticed.

The 20 unit tests are fully hermetic (injected client), covering every classification, every transport-failure reason, offline mode, the ref-spelling fallback and its refusal to invent a different version, and bounded/redacted handling of hostile upstream paths.

## Consequences

- No new dependency, no new secret, no new repository-write automation, no new network host beyond the GitHub API allowlist `upstream-client.mjs` already enforces.
- KRYLO Core is unaffected: this is purely additive, read-only tooling with no runtime coupling to the Orbit loop, the risk gate, or either host adapter.
- The first scheduled run will report three `SECURITY_REVIEW_REQUIRED` entries. That is a true finding, not noise — but it means the watch starts "red", and the correct response is a human re-review of those three integrations, not a change to the checker.
- Section 16's Monthly Ecosystem Radar (Phase 7) remains unimplemented and out of scope here, as does Section 17's deep-audit workflow.

## Supersedes

None. Implements design Section 15 / Phase 6, which ADR-0031 explicitly left open.

## Superseded by

None.
