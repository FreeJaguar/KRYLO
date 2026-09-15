// Weekly Upstream Watch (docs/adr/0036-weekly-upstream-watch.md,
// docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 15).
//
// Detects that a reviewed external integration has moved upstream since
// KRYLO reviewed it, and classifies HOW MUCH a human needs to care -- using
// only metadata and changed-file PATHS. It never executes anything from the
// candidate (Section 15.5), never promotes an observed ref into the trusted
// catalog (Section 15.3), and never writes to the repository.
//
// Two catalogs, two different roles, deliberately never merged:
//   catalog/tools.json         -- the TRUSTED record of what KRYLO reviewed.
//                                 Supplies every baseline ref. Read-only here.
//   catalog/upstream-watch.json -- WATCH CONFIGURATION only (which entries to
//                                 observe, what change classes matter).
//
// Everything this module reads from upstream -- file paths, statuses, ref
// names, commit counts -- is untrusted, attacker-influenceable content. It is
// bounded and redacted before it reaches a report, and no upstream string is
// ever interpolated into a command, a path KRYLO opens, or a URL beyond the
// allowlisted GitHub API that upstream-client.mjs already constrains.

import fs from 'node:fs';
import path from 'node:path';

import { getGithubCommitForRef, getGithubCompare, getLatestGithubRelease, getGithubTags } from '../../lib/upstream-client.mjs';
import { redactText } from '../../lib/redact.mjs';

/** Design Section 15.6's classification set, exactly -- no other value is ever emitted. */
export const DRIFT_CLASSIFICATIONS = [
  'NO_DRIFT',
  'DRIFT_LOW_RISK',
  'REVIEW_REQUIRED',
  'SECURITY_REVIEW_REQUIRED',
  'SOURCE_UNAVAILABLE',
];

/**
 * Changed-path patterns that escalate a drift to SECURITY_REVIEW_REQUIRED.
 * Each maps to one of design Section 15.4's analysis dimensions, and each is
 * a path-shape test only -- file CONTENT is never fetched, parsed, or run.
 */
const SECURITY_SENSITIVE_PATH_RULES = [
  { id: 'package-lifecycle', re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|[^/]*\.gemspec|composer\.(json|lock))$/i },
  { id: 'install-scripts', re: /(^|\/)(install|postinstall|preinstall|setup|bootstrap)[^/]*\.(sh|bash|zsh|ps1|cmd|bat|mjs|cjs|js|py)$/i },
  { id: 'hooks', re: /(^|\/)hooks?(\/|\.)|(^|\/)[^/]*hooks[^/]*\.(json|ya?ml|toml)$/i },
  { id: 'plugin-manifests', re: /(^|\/)(\.claude-plugin|\.codex-plugin)\/|(^|\/)plugin\.json$|(^|\/)marketplace\.json$/i },
  { id: 'mcp-inventory', re: /(^|\/)[^/]*mcp[^/]*\.(json|ya?ml|toml|mjs|cjs|js|ts)$/i },
  { id: 'license', re: /(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)([.-][^/]*)?$/i },
  { id: 'binaries', re: /\.(exe|dll|so|dylib|wasm|jar|bin|node|msi|deb|rpm|pkg|apk|pyc|class|a)(\.\d+)*$/i },
  { id: 'credentials-or-network-config', re: /(^|\/)(\.npmrc|\.netrc|\.yarnrc(\.ya?ml)?|\.pypirc|\.env[^/]*|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml|\.claude\/settings[^/]*\.json)$/i },
  // In this ecosystem a Markdown file is frequently not documentation at
  // all: SKILL.md, agent definitions and slash-command files are
  // INSTRUCTIONS AN AGENT EXECUTES, and a frontmatter change alone can grant
  // `allowed-tools: Bash`. An independent Security Reviewer pointed out that
  // the flagship watch entry, mattpocock/skills, is a repository made almost
  // entirely of such files -- so without this rule the single most
  // security-relevant change it can make classified as "documentation-only".
  { id: 'agent-instructions', re: /(^|\/)(SKILL|AGENTS?|CLAUDE|GEMINI)\.mdx?$|(^|\/)(skills|agents|commands|\.claude|\.codex|\.agents)\/[^/]*\.mdx?$/i },
];

/**
 * The ONLY delta that qualifies as low risk: every changed path carries an
 * inert extension. Deliberately an extension allowlist with no directory
 * arm. The previous version also treated anything under `docs/`/`examples/`
 * as documentation regardless of extension, which the same reviewer
 * reproduced as low-risk verdicts for `docs/build.sh`, `docs/tools/run.py`
 * and `examples/server.js` -- executable code behind a documentation prefix,
 * and in plugin repositories `examples/` routinely holds code users copy
 * verbatim. Markdown is NOT inert here (see agent-instructions above); it
 * reaches this rule only when the security rules did not already claim it.
 */
const INERT_EXTENSION_RULE = /\.(txt|rst|adoc|md|mdx)$/i;

/**
 * A changed path is upstream-authored text. It is used only for pattern
 * classification and for a bounded, redacted sample in the report -- never to
 * open a local file, build a command, or construct a URL.
 */
function summarizePath(p) {
  // Control characters are stripped BEFORE truncation. Git permits LF in a
  // path name and the API returns it verbatim, so an independent Security
  // Reviewer was able to craft a filename that reproduced this report's own
  // line format -- a fixed-width status label plus an id, after the
  // renderer's 12-space indent -- and inject a fabricated `NO DRIFT` entry
  // into the rendered report and the GitHub job summary. Redaction alone did
  // not stop it; neither did truncation.
  return redactText(String(p)).replace(/[\u0000-\u001F\u007F]/g, '\uFFFD').slice(0, 120);
}

function parseGithubOwnerRepo(source) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(String(source ?? ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

/** The reviewed baseline for one id, taken ONLY from the trusted catalog. */
export function reviewedBaselineFor(toolsCatalog, id) {
  const entry = (toolsCatalog?.tools ?? []).find((t) => t?.id === id);
  if (!entry) return { ok: false, reason: 'not-in-trusted-catalog' };
  const ref = entry.reviewedCommit ?? entry.reviewedVersion;
  if (typeof ref !== 'string' || ref.trim() === '' || ref === 'pending-first-review') {
    return { ok: false, reason: 'no-reviewed-ref' };
  }
  return { ok: true, ref: ref.trim(), source: entry.source, trustTier: entry.trustTier };
}

/**
 * Classify a changed-file list. Pure, synchronous, and total: every input maps
 * to exactly one of three drift classifications (SOURCE_UNAVAILABLE and
 * NO_DRIFT are decided before this is ever reached).
 *
 * An EMPTY file list is deliberately REVIEW_REQUIRED, not DRIFT_LOW_RISK: the
 * refs genuinely differ (otherwise this is not called), so "no files" means
 * the comparison itself did not tell us what changed -- GitHub truncates the
 * `files` array on very large diffs -- and treating an unexplained difference
 * as low risk would be exactly the kind of silent downgrade this subsystem
 * exists to prevent.
 */
export function classifyChangedPaths(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { classification: 'REVIEW_REQUIRED', reasons: ['changed-file-list-unavailable-or-truncated'] };
  }
  const hits = new Set();
  for (const raw of changedPaths) {
    // Bounded before matching. Several rules carry two unbounded `[^/]*`
    // quantifiers around a literal, which an independent Security Reviewer
    // measured as quadratic (not catastrophic: ~327ms at 60k characters,
    // already capped by upstream-client.mjs's 2MB response limit). Truncating
    // removes even that, and a path this long cannot be legitimate -- it is
    // treated as security-sensitive rather than silently shortened into
    // something that might match an inert rule.
    if (typeof raw !== 'string') continue;
    if (raw.length > 512) {
      hits.add('implausible-path-length');
      continue;
    }
    for (const rule of SECURITY_SENSITIVE_PATH_RULES) {
      if (rule.re.test(raw)) hits.add(rule.id);
    }
  }
  if (hits.size > 0) {
    return { classification: 'SECURITY_REVIEW_REQUIRED', reasons: [...hits].sort() };
  }
  const allInert = changedPaths.every((p) => typeof p === 'string' && INERT_EXTENSION_RULE.test(p));
  if (allInert) return { classification: 'DRIFT_LOW_RISK', reasons: ['inert-prose-only'] };
  return { classification: 'REVIEW_REQUIRED', reasons: ['code-or-config-changed'] };
}

/** Resolve the observed upstream head ref for a GitHub repo, preferring a real release. */
async function observeUpstreamHead(owner, repo, client) {
  const release = await client.getLatestGithubRelease(owner, repo);
  if (release.ok && typeof release.json?.tag_name === 'string' && release.json.tag_name.trim() !== '') {
    return { ok: true, ref: release.json.tag_name.trim(), kind: 'release' };
  }
  const tags = await client.getGithubTags(owner, repo);
  if (tags.ok && Array.isArray(tags.json) && typeof tags.json[0]?.name === 'string') {
    return { ok: true, ref: tags.json[0].name.trim(), kind: 'tag' };
  }
  const head = await client.getGithubCommitForRef(owner, repo, 'HEAD');
  if (head.ok && typeof head.json?.sha === 'string') {
    return { ok: true, ref: head.json.sha, kind: 'commit' };
  }
  // Every route failed. Report the LAST transport reason rather than
  // inventing a drift verdict from an absence of data.
  return { ok: false, reason: head.reason ?? tags.reason ?? release.reason ?? 'unavailable' };
}

/**
 * Compare, tolerating the one naming difference that is genuinely the SAME
 * ref rather than a guess: `tools.json` may record a bare version
 * (`3.8.49`) while the repository tags it `v3.8.49`, or the reverse. Without
 * this, every such entry degrades to "change list unavailable" forever and
 * the watch silently stops doing its job -- observed live against OmniRoute.
 *
 * Deliberately narrow: only a `v` prefix is added or removed, only when the
 * ref is otherwise an exact numeric-dotted version, and only after the
 * recorded form itself returned `not-found`. Any other mismatch stays a
 * failure rather than becoming a search for something plausible.
 */
async function compareWithTagPrefixFallback(client, repo, baseRef, headRef) {
  const first = await client.getGithubCompare(repo.owner, repo.repo, baseRef, headRef);
  if (first.ok || first.reason !== 'not-found') return { result: first, baseRefUsed: baseRef };

  // At least two dots, and no case-insensitivity: an independent Security
  // Reviewer noted the looser form accepted a single-component ref, so a
  // recorded `3` would retry `v3` -- which in many repositories is a MOVING
  // alias tag, not the exact release KRYLO reviewed -- and that the `i` flag
  // let `V3.8.49` through as if it were the same spelling.
  const alternate = /^v\d+\.\d+\.\d+(?:\.\d+)*$/.test(baseRef)
    ? baseRef.slice(1)
    : (/^\d+\.\d+\.\d+(?:\.\d+)*$/.test(baseRef) ? `v${baseRef}` : null);
  if (!alternate) return { result: first, baseRefUsed: baseRef };

  const second = await client.getGithubCompare(repo.owner, repo.repo, alternate, headRef);
  return second.ok
    ? { result: second, baseRefUsed: alternate }
    : { result: first, baseRefUsed: baseRef };
}

/**
 * Watch one entry. Returns a plain, serializable result; never throws.
 * `client` is injectable so tests exercise every path deterministically
 * without a network (this repository's test suite must stay hermetic).
 */
export async function watchEntry({ entry, toolsCatalog, client, offline = false }) {
  const base = {
    id: String(entry?.id ?? 'unknown').slice(0, 80),
    riskClass: entry?.riskClass ?? 'unknown',
  };

  const baseline = reviewedBaselineFor(toolsCatalog, entry?.id);
  if (!baseline.ok) {
    return {
      ...base,
      classification: 'SOURCE_UNAVAILABLE',
      reviewedRef: null,
      observedRef: null,
      detail: baseline.reason === 'no-reviewed-ref'
        ? 'tools.json records no reviewed version or commit for this id (still pending-first-review), so there is no trusted baseline to compare against.'
        : 'this id is not present in the trusted catalog (catalog/tools.json) at all.',
    };
  }

  // WHICH repository gets observed is decided by the TRUSTED catalog, never
  // by the watch config. An independent Security Reviewer reproduced the
  // inversion this closes: the baseline ref came from tools.json while the
  // repository came from upstream-watch.json, with nothing asserting they
  // agree -- so a one-line edit to the "configuration-only, therefore
  // low-stakes" file (a typo, a fork URL, or a hostile PR) pointed the watch
  // at a different repository whose matching tag then reported an
  // affirmative NO_DRIFT, silencing that integration permanently. That is
  // the exact inversion of design Section 15.3: the separation exists to
  // keep low-trust data from acquiring authority.
  //
  // A disagreement is surfaced rather than silently resolved in either
  // direction: preferring the trusted source would hide a watch file that no
  // longer describes what it claims to.
  const trustedRepo = parseGithubOwnerRepo(baseline.source);
  const declaredRepo = parseGithubOwnerRepo(entry?.source);
  if (trustedRepo && declaredRepo && (trustedRepo.owner !== declaredRepo.owner || trustedRepo.repo !== declaredRepo.repo)) {
    return {
      ...base,
      classification: 'SOURCE_UNAVAILABLE',
      reviewedRef: baseline.ref,
      observedRef: null,
      detail: 'the watch policy names a different repository than the trusted catalog does for this id; refusing to observe either until they agree, since comparing a trusted ref against an untrusted repository can only produce a meaningless verdict.',
    };
  }

  const repo = trustedRepo;
  if (!repo) {
    return {
      ...base,
      classification: 'SOURCE_UNAVAILABLE',
      reviewedRef: baseline.ref,
      observedRef: null,
      detail: 'the trusted catalog records no parseable GitHub source for this id; only GitHub-hosted sources are observable by this checker.',
    };
  }

  if (offline) {
    return {
      ...base,
      classification: 'SOURCE_UNAVAILABLE',
      reviewedRef: baseline.ref,
      observedRef: null,
      detail: 'offline mode: upstream was never contacted, so no drift verdict is possible.',
    };
  }

  const observed = await observeUpstreamHead(repo.owner, repo.repo, client);
  if (!observed.ok) {
    return {
      ...base,
      classification: 'SOURCE_UNAVAILABLE',
      reviewedRef: baseline.ref,
      observedRef: null,
      detail: `upstream could not be read (${String(observed.reason).slice(0, 60)}); a transport failure is never reported as "no drift".`,
    };
  }

  if (observed.ref === baseline.ref) {
    return {
      ...base,
      classification: 'NO_DRIFT',
      reviewedRef: baseline.ref,
      observedRef: observed.ref,
      detail: `observed ${observed.kind} matches the reviewed ref exactly.`,
    };
  }

  const compared = await compareWithTagPrefixFallback(client, repo, baseline.ref, observed.ref);
  const compare = compared.result;
  if (!compare.ok) {
    return {
      ...base,
      classification: 'REVIEW_REQUIRED',
      reviewedRef: baseline.ref,
      observedRef: summarizePath(observed.ref),
      detail: `upstream moved, but the change list could not be read (${String(compare.reason).slice(0, 60)}), so the delta is unanalyzed and a human must look.`,
    };
  }

  // The refs differ as STRINGS but GitHub says they are the same commit --
  // the `3.8.49` vs `v3.8.49` spelling case the fallback above exists for.
  // Without this, such an entry reports REVIEW_REQUIRED every single week
  // with a reason ("change list unavailable or truncated") that is simply
  // untrue, which is the canonical way to train reviewers to stop reading
  // the report. Found by an independent Security Reviewer, who noted the
  // disambiguating data was already in hand and being discarded.
  const identical = compare.json?.status === 'identical'
    || (compare.json?.total_commits === 0 && compare.json?.ahead_by === 0 && compare.json?.behind_by === 0);
  if (identical) {
    return {
      ...base,
      classification: 'NO_DRIFT',
      reviewedRef: baseline.ref,
      ...(compared.baseRefUsed !== baseline.ref ? { comparedUsingRef: compared.baseRefUsed } : {}),
      observedRef: summarizePath(observed.ref),
      detail: `the observed ${observed.kind} is a different spelling of the reviewed ref, and upstream reports the two as the same commit.`,
    };
  }

  const changedPaths = Array.isArray(compare.json?.files)
    ? compare.json.files.map((f) => String(f?.filename ?? '')).filter(Boolean)
    : [];
  const { classification, reasons } = classifyChangedPaths(changedPaths);
  const commitCount = Number.isInteger(compare.json?.total_commits) ? compare.json.total_commits : null;

  return {
    ...base,
    classification,
    reviewedRef: baseline.ref,
    // Disclosed when the comparison had to use the `v`-prefixed spelling of
    // the SAME reviewed version, so the report never implies tools.json's
    // recorded ref resolved upstream as written.
    ...(compared.baseRefUsed !== baseline.ref ? { comparedUsingRef: compared.baseRefUsed } : {}),
    observedRef: summarizePath(observed.ref),
    changedFileCount: changedPaths.length,
    commitCount,
    reasons,
    // A bounded, redacted sample only: enough for a human to orient, never
    // the whole upstream-authored list, and never any file CONTENT.
    changedPathSample: changedPaths.slice(0, 10).map(summarizePath),
    detail: `upstream moved from the reviewed ref; classified ${classification} from changed paths alone (no candidate code was fetched or executed).`,
  };
}

/** Run the whole watch policy. Returns a serializable report; never throws. */
export async function runUpstreamWatch({ repoRoot, client, offline = false } = {}) {
  const defaultClient = { getLatestGithubRelease, getGithubTags, getGithubCommitForRef, getGithubCompare };
  const effectiveClient = client ?? defaultClient;

  const watchRead = readJsonFile(path.join(repoRoot, 'plugins', 'krylo', 'catalog', 'upstream-watch.json'));
  const toolsRead = readJsonFile(path.join(repoRoot, 'plugins', 'krylo', 'catalog', 'tools.json'));
  if (!watchRead.ok || !toolsRead.ok) {
    return {
      watchSchemaVersion: 1,
      mode: offline ? 'offline' : 'live',
      results: [],
      error: 'catalog-unreadable',
      overall: 'SOURCE_UNAVAILABLE',
    };
  }

  const entries = Array.isArray(watchRead.value?.entries) ? watchRead.value.entries : [];
  const results = [];
  for (const entry of entries) {
    // watchEntry's own contract is "never throws", which holds today only
    // because fetchUpstreamJson never rejects. An independent Security
    // Reviewer noted that an injected or future client that DOES throw would
    // otherwise produce an unhandled rejection and lose every other entry's
    // result with it. One failing entry must never blind the whole watch.
    try {
      results.push(await watchEntry({ entry, toolsCatalog: toolsRead.value, client: effectiveClient, offline }));
    } catch {
      results.push({
        id: String(entry?.id ?? 'unknown').slice(0, 80),
        riskClass: entry?.riskClass ?? 'unknown',
        classification: 'SOURCE_UNAVAILABLE',
        reviewedRef: null,
        observedRef: null,
        detail: 'the watch for this entry failed unexpectedly; reported unavailable rather than dropped, and the other entries were still evaluated.',
      });
    }
  }

  return {
    watchSchemaVersion: watchRead.value?.watchSchemaVersion ?? 1,
    mode: offline ? 'offline' : 'live',
    results,
    overall: worstClassification(results.map((r) => r.classification)),
  };
}

/**
 * The report's single headline verdict. SECURITY_REVIEW_REQUIRED outranks
 * everything; SOURCE_UNAVAILABLE deliberately outranks NO_DRIFT so a run that
 * could not see upstream never presents itself as a clean bill of health.
 */
export function worstClassification(classifications) {
  const order = ['NO_DRIFT', 'DRIFT_LOW_RISK', 'SOURCE_UNAVAILABLE', 'REVIEW_REQUIRED', 'SECURITY_REVIEW_REQUIRED'];
  let worst = 'NO_DRIFT';
  for (const c of classifications) {
    if (order.indexOf(c) > order.indexOf(worst)) worst = c;
  }
  return worst;
}

/**
 * Exit code contract, matching check-ecosystem.mjs's own convention: a watch
 * that merely found drift must NOT fail the scheduled job (design Section 21:
 * this workflow can never block a PR or a release), so only an internal
 * failure is nonzero.
 */
export function computeWatchExitCode(report) {
  return report?.error ? 2 : 0;
}
