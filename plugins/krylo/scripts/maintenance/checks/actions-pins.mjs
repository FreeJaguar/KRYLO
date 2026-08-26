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
// Deliberately matches ANY ref shape after `@` (not just hex-looking ones)
// -- a mutable tag/branch/`latest` reference must still be EXTRACTED so the
// format check below can flag it, not silently skipped because it isn't a
// SHA. FULL_SHA_RE is what does the actual accept/reject classification.
const USES_LINE_RE = /uses:\s*([^\s@]+)@(\S+?)(?:\s*#\s*(\S+))?\s*$/gm;

function listWorkflowFiles(repoRoot) {
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

/** Extract every `uses: <ref>@<sha> # <comment>` occurrence across all workflow files. */
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
      const [, refPath, sha, comment] = m;
      const segments = refPath.split('/');
      const owner = segments[0];
      const repo = segments[1];
      pins.push({ file: relPath, refPath, owner, repo, sha, comment: comment || null });
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

  const notFullSha = pins.filter((p) => !FULL_SHA_RE.test(p.sha));
  results.push(
    buildCheckResult({
      id: 'actions-pins-format',
      category: 'actions-pins',
      status: notFullSha.length === 0 ? 'ok' : 'changed',
      severity: notFullSha.length === 0 ? 'info' : 'critical',
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

  const uniquePins = new Map();
  for (const p of pins) {
    if (!p.comment || !FULL_SHA_RE.test(p.sha) || !p.owner || !p.repo) continue;
    const key = `${p.owner}/${p.repo}@${p.comment}`;
    if (!uniquePins.has(key)) uniquePins.set(key, p);
  }

  const mismatches = [];
  const unresolved = [];
  let checkedCount = 0;
  for (const p of uniquePins.values()) {
    checkedCount += 1;
    const resolved = await upstream.getGithubCommitForRef(p.owner, p.repo, `tags/${p.comment}`);
    if (!resolved.ok) {
      unresolved.push(p);
      continue;
    }
    const resolvedSha = resolved.json?.sha;
    if (typeof resolvedSha === 'string' && resolvedSha.toLowerCase() !== p.sha.toLowerCase()) {
      mismatches.push({ ...p, resolvedSha });
    }
  }

  results.push(
    buildCheckResult({
      id: 'actions-pins-resolve-to-stated-release',
      category: 'actions-pins',
      status: mismatches.length > 0 ? 'changed' : unresolved.length > 0 ? 'warning' : 'ok',
      severity: mismatches.length > 0 ? 'high' : unresolved.length > 0 ? 'low' : 'info',
      current: `${checkedCount} unique action(s) checked`,
      observed: `${mismatches.length} mismatched, ${unresolved.length} unresolved`,
      evidence: mismatches.slice(0, 5).map((p) => `${p.file}: ${p.refPath}@${p.sha} (comment ${p.comment}) resolves to ${p.resolvedSha}`),
      recommendedAction: mismatches.length > 0
        ? 'A pinned Action SHA no longer matches the commit its own version comment claims -- verify the tag was not force-moved and the pin is still trustworthy before any release.'
        : 'none',
      requiresHumanReview: mismatches.length > 0,
    }),
  );

  return results;
}
