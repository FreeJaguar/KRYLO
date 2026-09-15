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
  'testing-and-ci-quality': 10,
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

function boundedText(value, max = 160) {
  return redactText(String(value ?? '')).replace(/[\u0000-\u001F\u007F]/g, '\uFFFD').slice(0, max);
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
 * Testing/CI: PRESENCE of CI configuration and a test directory. Named
 * honestly -- this measures whether testing exists, not whether it is any
 * good, which is why the dimension's own weight stays modest and the
 * quality half is left to the human reviewer.
 */
function scoreTesting(deep) {
  if (!deep.inspected) return { points: 0, signal: 'not inspected', unknown: true };
  let points = 0;
  const signals = [];
  if (deep.hasCiWorkflows) { points += 6; signals.push('CI workflows present'); }
  if (deep.hasTests) { points += 4; signals.push('test files present'); }
  if (points === 0) signals.push('no CI or tests detected');
  return { points, signal: signals.join(', ') };
}

/** Host compatibility: does it target the hosts KRYLO actually runs on? */
function scoreHostCompatibility(repo) {
  const topics = Array.isArray(repo.topics) ? repo.topics.map((t) => String(t).toLowerCase()) : [];
  let points = 0;
  const signals = [];
  const claude = topics.some((t) => t.includes('claude'));
  const codex = topics.some((t) => t.includes('codex'));
  if (claude) { points += 5; signals.push('Claude-targeted'); }
  if (codex) { points += 5; signals.push('Codex-targeted'); }
  if (points === 0) signals.push('no host affinity detected');
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
  if (!deep.inspected || deep.dependencyCount === null) {
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

  if (deep.inspected) {
    if (deep.hasInstallLifecycleScripts) applied.push('install-lifecycle-scripts');
    if (deep.dependencyCount !== null && deep.dependencyCount > 30) applied.push('excessive-dependency-footprint');
  } else {
    undetectable.push('install-lifecycle-scripts', 'excessive-dependency-footprint');
  }

  // Never claimed as absent from metadata alone -- each needs reading the
  // candidate's actual behaviour, which this Radar deliberately never does.
  undetectable.push(
    'automatic-user-config-mutation',
    'broad-secret-access',
    'unexplained-source-code-egress',
    'uncontrolled-external-writes',
    'unbounded-orchestration',
    'remote-code-execution-or-unsafe-downloads',
  );

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
export function classifyCandidate({ scored, maxAvailable, penalties, overlap, deepInspected = true }) {
  if (penalties.applied.includes('abandoned-maintenance')) {
    return { classification: 'REJECT', rationale: 'repository is archived; no maintenance signal can outweigh that' };
  }
  if (penalties.applied.includes('unclear-licensing')) {
    return { classification: 'REJECT', rationale: 'no clear license, so provenance and reuse terms cannot be established' };
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
    // the opposite of triage. A candidate that did not get a deep-inspection
    // slot can reach WATCH on metadata alone, never AUDIT_RECOMMENDED.
    if (!deepInspected) {
      return {
        classification: 'WATCH',
        rationale: `scores ${scored}/${maxAvailable}, but only on the dimensions available without a deep inspection; a partial look cannot justify spending a human audit slot, so this is held at WATCH rather than promoted on thinner evidence`,
      };
    }
    return { classification: 'AUDIT_RECOMMENDED', rationale: `scores ${scored}/${maxAvailable} on the measurable dimensions; worth a human look, which is the strongest claim this triage can make` };
  }
  return { classification: 'WATCH', rationale: `scores ${scored}/${maxAvailable} on the measurable dimensions; recorded but not worth a human audit slot yet` };
}

/** Fetch the one extra artefact the Radar reads: package.json METADATA. */
async function deepInspect(owner, repo, client) {
  const empty = {
    inspected: false,
    hasInstallLifecycleScripts: false,
    dependencyCount: null,
    hasCiWorkflows: false,
    hasTests: false,
  };

  // One extra call, only for candidates that get a deep-inspection slot:
  // whether .github/workflows exists at all. An earlier draft of this
  // module hardcoded `hasCiWorkflows: false` with a comment promising the
  // caller would fill it in, which nothing did -- six of this dimension's
  // ten points were therefore unearnable, and every candidate was silently
  // marked down for a check that never ran.
  const workflows = await client.getGithubFileContent(owner, repo, '.github/workflows');
  const hasCiWorkflows = workflows.ok && Array.isArray(workflows.json) && workflows.json.length > 0;

  const pkg = await client.getGithubFileContent(owner, repo, 'package.json');
  if (!pkg.ok || typeof pkg.json?.content !== 'string') {
    // No package.json is normal for a non-Node candidate; CI presence was
    // still established above, so report exactly that rather than nothing.
    return { ...empty, inspected: hasCiWorkflows, hasCiWorkflows };
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(pkg.json.content, pkg.json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
  } catch {
    return { ...empty, inspected: false };
  }

  const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : {};
  const deps = parsed && typeof parsed.dependencies === 'object' && parsed.dependencies !== null ? parsed.dependencies : {};

  return {
    inspected: true,
    hasInstallLifecycleScripts: ['preinstall', 'install', 'postinstall', 'prepare'].some((k) => typeof scripts[k] === 'string'),
    dependencyCount: Object.keys(deps).length,
    hasCiWorkflows,
    hasTests: typeof scripts.test === 'string' && scripts.test.trim() !== '',
  };
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
    'testing-and-ci-quality': scoreTesting(deep),
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
      : { inspected: false, hasInstallLifecycleScripts: false, dependencyCount: null, hasCiWorkflows: false, hasTests: false };

    const overlap = computeOverlap(repo, toolsRead.value);
    const penalties = detectRiskPenalties(repo, deep);
    const score = scoreCandidate(repo, deep);
    const { classification, rationale } = classifyCandidate({ ...score, penalties, overlap, deepInspected: deep.inspected });

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
      deepInspected: deep.inspected,
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
