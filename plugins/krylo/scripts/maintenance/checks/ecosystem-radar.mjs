// Monthly Ecosystem Radar (docs/adr/0039-monthly-ecosystem-radar.md,
// docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 16).
//
// Looks for tools that might materially improve KRYLO, and produces a
// triage recommendation about WHICH ONES A HUMAN SHOULD LOOK AT. It never
// installs, executes, commits, opens a PR, or changes the trust catalog
// (Section 16.5), and it never adds anything to catalog/tools.json --
// discovery is not review, and this file cannot confer trust.
//
// THE HONESTY CONSTRAINT THIS MODULE IS BUILT AROUND
//
// Design Section 16.4 specifies a 100-point score whose two largest
// dimensions -- "Engineering value" (20) and "KRYLO architectural fit" (15)
// -- are pure human judgement. No amount of repository metadata can compute
// them. A checker that emitted a single 0-100 number would therefore be
// fabricating 35% of it, and presenting the result with an authority it has
// not earned, which is precisely what this project forbids everywhere else.
//
// So the score here is explicitly PARTIAL. Only dimensions that are
// genuinely derivable from metadata are computed; every other dimension is
// reported by name in `requiresHumanJudgement`, with its maximum, so the
// size of the gap is visible in the output rather than hidden inside a
// total. `scored` is never normalised to 100 and never compared against
// 100 -- it is always reported against `maxAvailable`, the sum of the
// maxima actually computed.
//
// Everything read from upstream is untrusted, attacker-authored content: a
// candidate repository's name, description, topics and package.json are
// written by whoever published it. They are bounded and redacted before
// reaching a report, and no candidate string ever reaches a command, a
// filesystem path, or a URL beyond the allowlisted GitHub API.

import fs from 'node:fs';
import path from 'node:path';

import { searchGithubRepositories, getGithubFileContent } from '../../lib/upstream-client.mjs';
import { redactText } from '../../lib/redact.mjs';

/** Design Section 16.5's classification set, exactly. */
export const RADAR_CLASSIFICATIONS = ['REJECT', 'WATCH', 'AUDIT_RECOMMENDED'];

/**
 * Dimensions from design Section 16.4 that metadata genuinely supports,
 * with the maximum each contributes. The remainder is declared in
 * HUMAN_JUDGEMENT_DIMENSIONS and never silently scored as zero -- a zero
 * and an unknown are different things, and conflating them is how a triage
 * tool starts lying.
 */
const MEASURABLE_DIMENSIONS = {
  'maintenance-activity': 10,
  // Design Section 16.4's "Testing and CI quality" (10) is split into its two
  // independently-observable halves. They come from DIFFERENT upstream calls,
  // and an independent Security Reviewer showed that treating them as one
  // dimension let a repository whose CI directory was read but whose
  // package.json was not score the CI half while the unread half was silently
  // counted as a zero. Split, each half can be known or unknown on its own.
  'ci-presence': 6,
  'declared-test-script': 4,
  'host-compatibility': 10,
  'license-and-provenance': 5,
  'dependency-footprint': 5,
};

export const HUMAN_JUDGEMENT_DIMENSIONS = {
  'engineering-value': 20,
  'krylo-architectural-fit': 15,
  'security-and-least-privilege': 15,
  'cross-platform-support': 10,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Risk penalties from design Section 16.4 that are undetectable for EVERY
 * candidate, because establishing them means reading a candidate's actual
 * runtime behaviour -- which this Radar deliberately never does, and which
 * is what an audit is for.
 *
 * They are still reported per candidate in the structured output, since a
 * consumer reading one candidate's record must see the complete picture.
 * The text renderer prints them once for the whole report instead: repeating
 * an identical six-item list under every candidate buried the penalties that
 * are undetectable for a SPECIFIC candidate -- the ones that actually carry
 * information about a failed probe -- in constant noise. Observed in a live
 * run, and the reason this constant is exported.
 */
export const BEHAVIOURAL_PENALTIES = Object.freeze([
  'automatic-user-config-mutation',
  'broad-secret-access',
  'unexplained-source-code-egress',
  'uncontrolled-external-writes',
  'unbounded-orchestration',
  'remote-code-execution-or-unsafe-downloads',
]);

/**
 * Bound and neutralise a string that came from a third-party repository --
 * a name, a description, a license label. Anyone can publish a repository,
 * so this text is attacker-authored in the only sense that matters, and it
 * is rendered into a terminal and into a GitHub job summary.
 *
 * The stripped set covers four families, because a review found the first
 * two insufficient twice over. C0 and DEL
 * are the familiar half; \u0080-\u009F (C1) carry terminal escape
 * semantics of their own, and \u2028/\u2029 are line terminators to a
 * JavaScript or JSON parser while staying invisible to a human reading the
 * report. The fourth family is the one that actually rewrites what a human
 * sees: bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069) reverse
 * display order in a terminal and in a Markdown job summary, and zero-width
 * characters (U+200B-U+200F, U+2060-U+2064, U+FEFF) hide inside a name. A
 * candidate can publish a repository whose description renders as a
 * different publisher than it is, and this report is the only input to a
 * human's decision about where to spend an audit slot.
 */
function boundedText(value, max = 160) {
  return redactText(String(value ?? ''))
    .replace(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g,
      '\uFFFD',
    )
    .slice(0, max);
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

function daysSince(iso) {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / MS_PER_DAY) : null;
}

/** Maintenance: recency of the last push, and whether the repo is archived. */
function scoreMaintenance(repo) {
  if (repo.archived) return { points: 0, signal: 'archived' };
  const age = daysSince(repo.pushed_at);
  if (age === null) return { points: 0, signal: 'unknown-last-push' };
  if (age <= 30) return { points: 10, signal: `pushed ${age}d ago` };
  if (age <= 90) return { points: 7, signal: `pushed ${age}d ago` };
  if (age <= 365) return { points: 3, signal: `pushed ${age}d ago` };
  return { points: 0, signal: `stale: pushed ${age}d ago` };
}

/**
 * PRESENCE of CI configuration. Named honestly -- this measures whether CI
 * exists, not whether it is any good; the quality half of design Section
 * 16.4's dimension stays with the human reviewer.
 */
function scoreCiPresence(deep) {
  if (!deep.ciInspected) return { points: 0, signal: 'not inspected', unknown: true };
  return deep.hasCiWorkflows
    ? { points: 6, signal: 'CI workflows present' }
    : { points: 0, signal: 'no CI workflows detected' };
}

/**
 * Whether the package declares a test script. Needs a READABLE root
 * package.json: a Python candidate with a full pytest suite would otherwise
 * be charged 0/4 on a dimension whose name does not say "npm", which is the
 * mirror image of crediting it for dependencies nobody read.
 */
function scoreDeclaredTestScript(deep) {
  if (!deep.packageInspected || !deep.packagePresent) {
    return { points: 0, signal: 'no root package.json to read', unknown: true };
  }
  return deep.hasTests
    ? { points: 4, signal: 'declares a test script' }
    : { points: 0, signal: 'declares no test script' };
}

/**
 * Host compatibility, measured from the repository's own GitHub topics.
 *
 * This is a SELF-DECLARED signal and the wording of its output says so. A
 * project sets its own topics, so this measures a claim of host affinity,
 * not verified compatibility -- a repository can tag itself `claude` without
 * working on the Claude host, and a genuinely compatible project can carry
 * no topics at all. Both directions of error are real, which is why the
 * absent case reports "declares no host affinity" rather than "incompatible":
 * silence is not a negative finding. The dimension stays in the measurable
 * set because a declared target IS evidence about intent and costs nothing
 * to read, but verifying the claim is human-review work and sits in the
 * declared `krylo-architectural-fit` weight instead.
 */
function scoreHostCompatibility(repo) {
  const topics = Array.isArray(repo.topics) ? repo.topics.map((t) => String(t).toLowerCase()) : [];
  let points = 0;
  const signals = [];
  if (topics.some((t) => t.includes('claude'))) { points += 5; signals.push('declares Claude as a target'); }
  if (topics.some((t) => t.includes('codex'))) { points += 5; signals.push('declares Codex as a target'); }
  if (points === 0) signals.push('declares no host affinity (silence, not a negative finding)');
  return { points, signal: signals.join(', ') };
}

function scoreLicense(repo) {
  const spdx = repo.license?.spdx_id;
  if (!spdx || spdx === 'NOASSERTION') return { points: 0, signal: 'no clear license' };
  const permissive = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];
  return permissive.includes(spdx)
    ? { points: 5, signal: `permissive (${spdx})` }
    : { points: 2, signal: `declared (${spdx})` };
}

function scoreDependencyFootprint(deep) {
  if (!deep.packageInspected || !deep.packagePresent || deep.dependencyCount === null) {
    return { points: 0, signal: 'not inspected', unknown: true };
  }
  const n = deep.dependencyCount;
  if (n === 0) return { points: 5, signal: 'zero runtime dependencies' };
  if (n <= 10) return { points: 4, signal: `${n} runtime dependencies` };
  if (n <= 30) return { points: 2, signal: `${n} runtime dependencies` };
  return { points: 0, signal: `${n} runtime dependencies` };
}

/**
 * Design Section 16.4's risk penalties, restricted to the ones that are
 * genuinely detectable. An UNDETECTABLE penalty is never recorded as
 * absent: when the deep inspection did not run, that is reported as
 * `undetectable` rather than as a clean bill.
 */
export function detectRiskPenalties(repo, deep) {
  const applied = [];
  const undetectable = [];

  if (repo.archived) applied.push('abandoned-maintenance');
  if (!repo.license?.spdx_id || repo.license.spdx_id === 'NOASSERTION') applied.push('unclear-licensing');

  // Both of these are derived ONLY from package.json. An independent
  // Security Reviewer reproduced the bug this replaces: the old single
  // `inspected` flag was set true when the CI probe succeeded even though
  // package.json had failed, so these two dropped out of `applied` AND out of
  // `undetectable` -- reading to a human as "checked, and clean". The
  // difference between "we checked" and "we never looked" is the entire
  // point of this function.
  if (deep.packageInspected && deep.packagePresent) {
    if (deep.hasInstallLifecycleScripts) applied.push('install-lifecycle-scripts');
    if (deep.dependencyCount !== null && deep.dependencyCount > 30) applied.push('excessive-dependency-footprint');
  } else {
    undetectable.push('install-lifecycle-scripts', 'excessive-dependency-footprint');
  }

  undetectable.push(...BEHAVIOURAL_PENALTIES);

  return { applied, undetectable };
}

/**
 * Classify. Deliberately conservative in both directions:
 *
 * REJECT is reserved for hard, individually sufficient disqualifiers that
 * metadata really does establish -- an archived repository or one with no
 * license is not a judgement call.
 *
 * AUDIT_RECOMMENDED means only "a human should look at this", which is the
 * strongest thing automated triage is entitled to say. It never means
 * "adopt", and nothing here can move a candidate into catalog/tools.json.
 *
 * WATCH is the honest default for everything else.
 */
export function classifyCandidate({ scored, maxAvailable, penalties, overlap, fullyInspected = false }) {
  // A hard disqualifier is checked BEFORE trust-catalog membership, and on
  // purpose: an already-reviewed tool that has since been archived or lost
  // its license is the most important thing this run could tell a human, and
  // suppressing it because the tool is already trusted would invert the
  // point. The rationale names the catalog membership so the verdict cannot
  // be misread as being about a fresh candidate.
  const catalogNote = overlap.alreadyInTrustCatalog
    ? ` NOTE: this is already in catalog/tools.json${overlap.catalogId ? ` as ${overlap.catalogId}` : ''}, so this concerns a tool KRYLO has already reviewed and warrants a look at that entry`
    : '';
  if (penalties.applied.includes('abandoned-maintenance')) {
    return { classification: 'REJECT', rationale: `repository is archived; no maintenance signal can outweigh that.${catalogNote}` };
  }
  if (penalties.applied.includes('unclear-licensing')) {
    return { classification: 'REJECT', rationale: `no clear license, so provenance and reuse terms cannot be established.${catalogNote}` };
  }
  if (overlap.alreadyInTrustCatalog) {
    return { classification: 'WATCH', rationale: 'already present in catalog/tools.json; upstream drift for it is the Weekly Upstream Watch\'s job, not the Radar\'s' };
  }
  if (penalties.applied.includes('install-lifecycle-scripts')) {
    return { classification: 'WATCH', rationale: 'declares install lifecycle scripts, which this project treats as a material supply-chain concern; not rejected outright, but not worth a human audit slot ahead of cleaner candidates' };
  }
  const ratio = maxAvailable > 0 ? scored / maxAvailable : 0;
  if (ratio >= 0.7) {
    // A ratio over FEWER dimensions is easier to max out, so without this
    // guard the un-inspected candidates outrank the inspected ones -- a
    // scoring model that rewards knowing less about a candidate, which is
    // the opposite of triage. A candidate whose inspection did not COMPLETE
    // -- including one where only half the probes succeeded -- can reach
    // WATCH on what was measured, never AUDIT_RECOMMENDED. The parameter
    // defaults to the restrictive value on purpose: this function is
    // exported, and a caller that forgets the field must not silently
    // disable the guard that exists to stop exactly this.
    if (!fullyInspected) {
      return {
        classification: 'WATCH',
        rationale: `scores ${scored}/${maxAvailable}, but only on the dimensions available without a deep inspection; a partial look cannot justify spending a human audit slot, so this is held at WATCH rather than promoted on thinner evidence`,
      };
    }
    return { classification: 'AUDIT_RECOMMENDED', rationale: `scores ${scored}/${maxAvailable} on the measurable dimensions; worth a human look, which is the strongest claim this triage can make` };
  }
  return { classification: 'WATCH', rationale: `scores ${scored}/${maxAvailable} on the measurable dimensions; recorded but not worth a human audit slot yet` };
}

/**
 * The Radar's two extra reads for a candidate that gets a deep-inspection
 * slot: whether CI configuration exists, and package.json METADATA.
 *
 * The two probes are reported through SEPARATE flags, and this is the
 * finding that forced it. An earlier version returned one `inspected` flag
 * set from whichever probe happened to succeed, so a repository whose CI
 * directory was read but whose package.json was not came back as
 * "inspected" -- and the two package-derived risk penalties then fell out
 * of `applied` and out of `undetectable` both, which reads to a human as
 * "checked, and clean". Every Python or Go MCP server with CI and no root
 * package.json takes that path, and three of the four shipped queries can
 * return one.
 *
 * `not-found` is treated as an ANSWER, not a failure: a repository with no
 * `.github/workflows` genuinely has no GitHub Actions CI, and one with no
 * root `package.json` genuinely declares no npm test script. Any other
 * failure -- rate limit, timeout, server error, unparseable body -- means
 * the probe did not run, and the corresponding flag stays false so the
 * dimensions and penalties that depend on it are reported unknown rather
 * than scored as zero.
 */
async function deepInspect(owner, repo, client) {
  const result = {
    ciInspected: false,
    packageInspected: false,
    // Distinct from `packageInspected`: the probe can answer "there is no
    // root manifest", which is an answer about the REQUEST and not a
    // measurement of the candidate. See the not-found branch below.
    packagePresent: false,
    hasCiWorkflows: false,
    hasInstallLifecycleScripts: false,
    dependencyCount: null,
    hasTests: false,
    probeFailures: [],
  };

  const workflows = await client.getGithubFileContent(owner, repo, '.github/workflows');
  if (workflows.ok) {
    result.ciInspected = true;
    result.hasCiWorkflows = Array.isArray(workflows.json) && workflows.json.length > 0;
  } else if (workflows.reason === 'not-found') {
    result.ciInspected = true; // Answered: the directory does not exist.
  } else {
    result.probeFailures.push({ probe: '.github/workflows', reason: workflows.reason ?? 'unknown' });
  }

  const pkg = await client.getGithubFileContent(owner, repo, 'package.json');
  if (pkg.ok && typeof pkg.json?.content === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(pkg.json.content, pkg.json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
    } catch {
      // A package.json we cannot parse is not a package.json we have read.
      result.probeFailures.push({ probe: 'package.json', reason: 'unparseable' });
      return result;
    }
    const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : {};
    const deps = parsed && typeof parsed.dependencies === 'object' && parsed.dependencies !== null ? parsed.dependencies : {};
    result.packageInspected = true;
    result.packagePresent = true;
    result.hasInstallLifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'].some((k) => typeof scripts[k] === 'string');
    result.dependencyCount = Object.keys(deps).length;
    result.hasTests = typeof scripts.test === 'string' && scripts.test.trim() !== '';
  } else if (pkg.reason === 'not-found') {
    // The REQUEST was answered, but nothing about the candidate's
    // dependencies or install hooks was established by it, and an earlier
    // version of this branch claimed otherwise: it set `dependencyCount: 0`
    // and the footprint dimension then awarded a full 5/5 for "zero runtime
    // dependencies" to a repository whose dependencies had never been read,
    // while both package-derived penalties vanished from `applied` and
    // `undetectable` alike. That is the same over-claim this whole split
    // exists to prevent, reintroduced in a narrower and more confident form.
    //
    // A missing ROOT package.json is not a missing manifest: a monorepo
    // keeps it in `packages/<name>/`, and a Python or Go candidate keeps its
    // dependencies somewhere this Radar does not read at all. The `topic:
    // mcp-server` query -- one of the four shipped -- returns mostly such
    // repositories, so this is the ordinary path and not an edge case.
    //
    // So: the probe answered (`packageInspected`), and it answered that
    // there is nothing here to read (`packagePresent: false`). Everything
    // downstream of a manifest stays unknown. The candidate can still be
    // fully inspected and still reach AUDIT_RECOMMENDED on what WAS
    // measured; it simply earns nothing, and is charged nothing, for what
    // was not.
    result.packageInspected = true;
    result.packagePresent = false;
  } else {
    result.probeFailures.push({ probe: 'package.json', reason: pkg.reason ?? 'unknown' });
  }

  return result;
}

/** True only when BOTH probes answered. See `deepInspect`. */
export function isFullyInspected(deep) {
  return Boolean(deep?.ciInspected && deep?.packageInspected);
}

/** Overlap with what KRYLO has already reviewed (design Section 16.5). */
export function computeOverlap(repo, toolsCatalog) {
  const full = String(repo.full_name ?? '').toLowerCase();
  const entry = (toolsCatalog?.tools ?? []).find((t) => String(t?.source ?? '').toLowerCase().includes(`/${full}`)
    || String(t?.source ?? '').toLowerCase().endsWith(full));
  return {
    alreadyInTrustCatalog: Boolean(entry),
    ...(entry ? { catalogId: entry.id, trustTier: entry.trustTier } : {}),
  };
}

/** Score one candidate. Pure and synchronous once its data is in hand. */
export function scoreCandidate(repo, deep) {
  const breakdown = {
    'maintenance-activity': scoreMaintenance(repo),
    'ci-presence': scoreCiPresence(deep),
    'declared-test-script': scoreDeclaredTestScript(deep),
    'host-compatibility': scoreHostCompatibility(repo),
    'license-and-provenance': scoreLicense(repo),
    'dependency-footprint': scoreDependencyFootprint(deep),
  };

  let scored = 0;
  let maxAvailable = 0;
  const unknownDimensions = [];
  for (const [dim, max] of Object.entries(MEASURABLE_DIMENSIONS)) {
    const result = breakdown[dim];
    if (result.unknown) {
      unknownDimensions.push(dim);
      continue; // excluded from BOTH numerator and denominator -- never scored as zero
    }
    scored += result.points;
    maxAvailable += max;
  }

  return { scored, maxAvailable, breakdown, unknownDimensions };
}

/** Run the whole Radar. Returns a serializable report; never throws. */
export async function runEcosystemRadar({ repoRoot, client, offline = false } = {}) {
  const effectiveClient = client ?? { searchGithubRepositories, getGithubFileContent };

  const sourcesRead = readJsonFile(path.join(repoRoot, 'plugins', 'krylo', 'catalog', 'radar-sources.json'));
  const toolsRead = readJsonFile(path.join(repoRoot, 'plugins', 'krylo', 'catalog', 'tools.json'));
  if (!sourcesRead.ok || !toolsRead.ok) {
    return { radarSchemaVersion: 1, mode: offline ? 'offline' : 'live', candidates: [], sources: [], error: 'catalog-unreadable' };
  }

  const policy = sourcesRead.value;
  const limits = policy.limits ?? {};
  const maxResults = Number.isInteger(limits.maxResultsPerQuery) ? limits.maxResultsPerQuery : 15;
  const maxDeep = Number.isInteger(limits.maxDeepInspections) ? limits.maxDeepInspections : 12;

  if (offline) {
    const sources = (policy.queries ?? []).map((q) => ({ id: q.id, status: 'SOURCE_UNAVAILABLE', detail: 'offline mode: upstream was never contacted' }));
    return {
      radarSchemaVersion: policy.radarSchemaVersion ?? 1,
      mode: 'offline',
      candidates: [],
      sources,
      // Carries a summary like every other path. Without it the renderer
      // printed "0 sources unavailable" directly beneath a list of
      // unavailable sources -- a report that contradicted itself and read
      // as a clean radar when nothing had been looked at at all.
      summary: { total: 0, auditRecommended: 0, watch: 0, rejected: 0, sourcesUnavailable: sources.length },
    };
  }

  const sources = [];
  const seen = new Set();
  const rawCandidates = [];

  for (const q of policy.queries ?? []) {
    const res = await effectiveClient.searchGithubRepositories(q.query, { perPage: maxResults });
    if (!res.ok) {
      // An unreachable or rate-limited source is reported as such. It must
      // never collapse into "no candidates found", which reads identically
      // to a clean radar and is the failure mode this project cares about.
      sources.push({ id: q.id, status: 'SOURCE_UNAVAILABLE', detail: `search failed (${String(res.reason).slice(0, 40)})` });
      continue;
    }
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    sources.push({ id: q.id, status: 'ok', found: items.length });
    for (const repo of items) {
      const key = String(repo?.full_name ?? '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rawCandidates.push({ repo, category: q.category, sourceId: q.id });
    }
  }

  // Deep inspection is bounded: the most recently pushed candidates first,
  // so the budget goes where the signal is, and the rest are reported
  // explicitly as un-inspected rather than quietly scored as if they were.
  rawCandidates.sort((a, b) => Date.parse(b.repo.pushed_at ?? 0) - Date.parse(a.repo.pushed_at ?? 0));

  const candidates = [];
  for (const [index, { repo, category, sourceId }] of rawCandidates.entries()) {
    const owner = String(repo?.owner?.login ?? '');
    const name = String(repo?.name ?? '');
    const deep = (owner && name && index < maxDeep)
      ? await deepInspect(owner, name, effectiveClient)
      : { ciInspected: false, packageInspected: false, packagePresent: false, hasCiWorkflows: false, hasInstallLifecycleScripts: false, dependencyCount: null, hasTests: false, probeFailures: [] };

    const overlap = computeOverlap(repo, toolsRead.value);
    const penalties = detectRiskPenalties(repo, deep);
    const score = scoreCandidate(repo, deep);
    const { classification, rationale } = classifyCandidate({ ...score, penalties, overlap, fullyInspected: isFullyInspected(deep) });

    candidates.push({
      source: `https://github.com/${boundedText(repo.full_name, 120)}`,
      sourceQueryId: sourceId,
      category,
      publisher: boundedText(repo.owner?.login, 80),
      publisherType: boundedText(repo.owner?.type, 20),
      observedRef: boundedText(repo.default_branch, 60),
      license: boundedText(repo.license?.spdx_id ?? 'none', 40),
      description: boundedText(repo.description, 200),
      maintenanceSignal: score.breakdown['maintenance-activity'].signal,
      stars: Number.isInteger(repo.stargazers_count) ? repo.stargazers_count : null,
      overlap,
      deepInspected: isFullyInspected(deep),
      // Named probes that did not run, so a reader can tell a candidate
      // nobody looked at from one whose inspection was cut short.
      probeFailures: deep.probeFailures ?? [],
      score: { scored: score.scored, maxAvailable: score.maxAvailable, breakdown: score.breakdown, unknownDimensions: score.unknownDimensions },
      requiresHumanJudgement: HUMAN_JUDGEMENT_DIMENSIONS,
      riskPenalties: penalties,
      classification,
      rationale,
    });
  }

  candidates.sort((a, b) => RADAR_CLASSIFICATIONS.indexOf(b.classification) - RADAR_CLASSIFICATIONS.indexOf(a.classification)
    || (b.score.scored - a.score.scored));

  return {
    radarSchemaVersion: policy.radarSchemaVersion ?? 1,
    mode: 'live',
    sources,
    candidates,
    summary: {
      total: candidates.length,
      auditRecommended: candidates.filter((c) => c.classification === 'AUDIT_RECOMMENDED').length,
      watch: candidates.filter((c) => c.classification === 'WATCH').length,
      rejected: candidates.filter((c) => c.classification === 'REJECT').length,
      sourcesUnavailable: sources.filter((s) => s.status === 'SOURCE_UNAVAILABLE').length,
    },
  };
}

/**
 * Exit code: finding candidates is never a failure, so only an internal
 * failure is nonzero. Like the Upstream Watch, this workflow must never be
 * able to block a PR or a release.
 */
export function computeRadarExitCode(report) {
  return report?.error ? 2 : 0;
}
