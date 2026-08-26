// Category C: GitHub Actions pins (task Section 5.C).
// actions-security.yml's own pin-check job already CI-enforces "every
// `uses:` is a full commit SHA" (grep-based, already-shipped, PR-blocking).
// This module reuses that same acceptance shape as a cheap internal sanity
// check, then adds genuinely new value that job does not have: verifying,
// over the network, that each pinned SHA still resolves to the commit its
// own trailing `# vX.Y.Z` comment claims.

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
// Matches the ENTIRE rest of a `uses:` line (task Section 24's fresh
// independent Reviewer found the original single-token comment-capture
// regex silently dropped any pin with a multi-word trailing comment --
// e.g. `# v7.0.0 (pinned)` -- from extraction entirely, so the pin was
// never even considered by the checks below and the missing pin read as
// a clean pass). Splitting the ref@sha portion from an optional trailing
// comment is done separately in parseUsesLine() below, not by this regex
// alone, so a comment containing spaces is never a problem.
const USES_LINE_RE = /^\s*-?\s*uses:\s*(.+?)\s*$/gm;

// Exported for reuse by node-runtime.mjs (MEDIUM-6, Reviewer): that
// module previously hardcoded four workflow filenames, so it could never
// see a NEW workflow file (including this checkpoint's own
// ecosystem-maintenance.yml) -- a directory listing is the only way a
// drift checker can observe drift in itself.
export function listWorkflowFiles(repoRoot) {
  const dir = path.join(repoRoot, '.github', 'workflows');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => path.join('.github', 'workflows', f));
  } catch {
    return [];
  }
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse one `uses:` line's captured value into { refPath, sha, comment }, or
 * null if it does not contain an `@` at all (not an Action reference this
 * checker understands). Handles a YAML-quoted value (`uses: 'owner/repo@sha'`)
 * and a multi-word trailing `# comment` (task Section 24's HIGH-1/MEDIUM-8
 * fixes) -- a real independent Reviewer found the prior single-regex
 * approach missed both shapes, and reported the resulting empty extraction
 * as a silent pass rather than a parse failure.
 */
function parseUsesLine(rawValue) {
  const hashIdx = rawValue.indexOf('#');
  const beforeComment = (hashIdx === -1 ? rawValue : rawValue.slice(0, hashIdx)).trim();
  const comment = hashIdx === -1 ? null : rawValue.slice(hashIdx + 1).trim() || null;
  const unquoted = stripQuotes(beforeComment);
  const atIdx = unquoted.indexOf('@');
  if (atIdx === -1) return null;
  const refPath = unquoted.slice(0, atIdx);
  const sha = unquoted.slice(atIdx + 1);
  if (!refPath || !sha) return null;
  return { refPath, sha, comment };
}

/** Extract every `uses: <ref>@<sha> [# <comment...>]` occurrence across all workflow files. */
function extractActionPins(repoRoot, relPaths) {
  const pins = [];
  for (const relPath of relPaths) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch {
      continue;
    }
    let m;
    USES_LINE_RE.lastIndex = 0;
    while ((m = USES_LINE_RE.exec(text)) !== null) {
      const parsed = parseUsesLine(m[1]);
      if (!parsed) continue;
      const segments = parsed.refPath.split('/');
      const owner = segments[0];
      const repo = segments[1];
      pins.push({ file: relPath, refPath: parsed.refPath, owner, repo, sha: parsed.sha, comment: parsed.comment });
    }
  }
  return pins;
}

export async function runActionsPinsChecks({ repoRoot, offline, upstream }) {
  const results = [];
  const workflowFiles = listWorkflowFiles(repoRoot);
  const pins = extractActionPins(repoRoot, workflowFiles);

  if (workflowFiles.length === 0) {
    results.push(
      buildCheckResult({
        id: 'actions-pins-format',
        category: 'actions-pins',
        status: 'unavailable',
        severity: 'info',
        current: null,
        observed: 'no-workflow-files-found',
        evidence: ['.github/workflows/'],
        recommendedAction: 'none',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  // A fresh independent Reviewer found the original code had NO guard for
  // "workflow files exist and are readable, but extraction found zero
  // pins" -- exactly the failure mode a parser bug (HIGH-1/MEDIUM-8)
  // produces -- so a total parse failure read as an "ok" empty pass. A
  // real repository's workflows always declare at least one `uses:`
  // (every job needs actions/checkout at minimum); zero extracted pins
  // over non-empty workflow files is therefore always a parser problem,
  // never a legitimate "no pins" state, and must fail loud, not silent.
  if (pins.length === 0) {
    results.push(
      buildCheckResult({
        id: 'actions-pins-format',
        category: 'actions-pins',
        status: 'blocked',
        severity: 'medium',
        current: null,
        observed: 'zero-pins-extracted-from-non-empty-workflows',
        evidence: workflowFiles.slice(0, 5),
        recommendedAction: 'No `uses:` reference could be parsed from any workflow file -- this checker\'s own extraction logic likely needs review, not a sign the repository has no Action pins.',
        requiresHumanReview: true,
      }),
    );
    return results;
  }

  const notFullSha = pins.filter((p) => !FULL_SHA_RE.test(p.sha));
  results.push(
    buildCheckResult({
      id: 'actions-pins-format',
      category: 'actions-pins',
      status: notFullSha.length === 0 ? 'ok' : 'changed',
      // A mutable-tag/branch/`latest` reference is a hardening gap
      // actions-security.yml's own CI job already blocks on -- 'high' per
      // the task's own severity ladder, not 'critical' (reserved for
      // compromised-publisher-shaped evidence), matching a Reviewer's
      // explicit note that 'critical' here overstated the ladder.
      severity: notFullSha.length === 0 ? 'info' : 'high',
      current: `${pins.length} total pins`,
      observed: `${notFullSha.length} not-full-SHA`,
      evidence: notFullSha.slice(0, 5).map((p) => `${p.file}: ${p.refPath}@${p.sha}`),
      recommendedAction: notFullSha.length === 0 ? 'none' : 'Pin every Action reference to a full 40-hex commit SHA (already CI-enforced by actions-security.yml; this indicates that check would also fail).',
      requiresHumanReview: notFullSha.length > 0,
    }),
  );

  const missingComment = pins.filter((p) => !p.comment);
  results.push(
    buildCheckResult({
      id: 'actions-pins-version-annotated',
      category: 'actions-pins',
      status: missingComment.length === 0 ? 'ok' : 'warning',
      severity: missingComment.length === 0 ? 'info' : 'low',
      current: `${pins.length} total pins`,
      observed: `${missingComment.length} missing a version comment`,
      evidence: missingComment.slice(0, 5).map((p) => `${p.file}: ${p.refPath}@${p.sha}`),
      recommendedAction: missingComment.length === 0 ? 'none' : 'Add a trailing `# vX.Y.Z` comment so a pinned SHA stays human-auditable.',
      requiresHumanReview: false,
    }),
  );

  if (offline) {
    results.push(
      buildCheckResult({
        id: 'actions-pins-resolve-to-stated-release',
        category: 'actions-pins',
        status: 'unavailable',
        severity: 'info',
        current: null,
        observed: null,
        evidence: [],
        recommendedAction: 'Run in live mode to verify pinned SHAs against api.github.com.',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  // Dedup key now includes the SHA itself (a fresh independent Reviewer
  // found and reproduced that keying on owner/repo@comment alone let two
  // workflows pinning the SAME action/version comment but DIFFERENT SHAs
  // collapse into one entry -- only the first-encountered SHA was ever
  // network-verified, silently hiding a genuinely wrong second pin, which
  // is exactly the "Action SHA no longer maps to its stated release"
  // condition this check exists to catch at high severity).
  const uniquePins = new Map();
  for (const p of pins) {
    if (!p.comment || !FULL_SHA_RE.test(p.sha) || !p.owner || !p.repo) continue;
    const key = `${p.owner}/${p.repo}@${p.comment}@${p.sha.toLowerCase()}`;
    if (!uniquePins.has(key)) uniquePins.set(key, p);
  }

  const mismatches = [];
  const unresolved = [];
  let checkedCount = 0;
  for (const p of uniquePins.values()) {
    checkedCount += 1;
    const resolved = await upstream.getGithubCommitForRef(p.owner, p.repo, `tags/${p.comment}`);
    if (!resolved.ok) {
      unresolved.push({ ...p, reason: resolved.reason || 'unknown' });
      continue;
    }
    const resolvedSha = resolved.json?.sha;
    if (typeof resolvedSha === 'string' && resolvedSha.toLowerCase() !== p.sha.toLowerCase()) {
      mismatches.push({ ...p, resolvedSha });
    }
  }

  // A fresh independent Reviewer found this check previously collapsed
  // every unresolved-lookup cause (rate-limited, not-found, timeout,
  // server-error) into a single undifferentiated 'warning'/'low' with
  // EMPTY evidence, contradicting this checker's own documented
  // "a transport failure becomes unavailable, never a fabricated pass"
  // guarantee (ADR-0031). If EVERY lookup failed for a transport reason
  // (never a genuine not-found), the whole check is 'unavailable', not a
  // pass or a soft warning; the specific reason is now always carried
  // into evidence so an operator can tell "rate-limited" from "the tag
  // was deleted upstream" rather than seeing only a bare count.
  const allUnresolvedAreTransportFailures = unresolved.length > 0 && unresolved.length === checkedCount
    && unresolved.every((u) => u.reason !== 'not-found');
  results.push(
    buildCheckResult({
      id: 'actions-pins-resolve-to-stated-release',
      category: 'actions-pins',
      status: mismatches.length > 0 ? 'changed' : allUnresolvedAreTransportFailures ? 'unavailable' : unresolved.length > 0 ? 'warning' : 'ok',
      severity: mismatches.length > 0 ? 'high' : 'info',
      current: `${checkedCount} unique action/version pair(s) checked (of ${pins.length} total pin declarations)`,
      observed: `${mismatches.length} mismatched, ${unresolved.length} unresolved`,
      evidence: mismatches.length > 0
        ? mismatches.slice(0, 5).map((p) => `${p.file}: ${p.refPath}@${p.sha} (comment ${p.comment}) resolves to ${p.resolvedSha}`)
        : unresolved.slice(0, 5).map((p) => `${p.file}: ${p.refPath}@${p.sha} (comment ${p.comment}) -- ${p.reason}`),
      recommendedAction: mismatches.length > 0
        ? 'A pinned Action SHA no longer matches the commit its own version comment claims -- verify the tag was not force-moved and the pin is still trustworthy before any release.'
        : 'none',
      requiresHumanReview: mismatches.length > 0,
    }),
  );

  return results;
}
