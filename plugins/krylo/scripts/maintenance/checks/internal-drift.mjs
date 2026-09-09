// Category F: internal version/reference drift (task Section 5.F).
// Compares exact, structured version FIELDS only (package.json.version,
// plugin.json.version, CHANGELOG's top released heading) -- never scans
// free-form prose for "0.2"/"future" mentions, which would false-positive
// on PRODUCT_SPEC.md's deliberate forward-looking "Goals for 0.2" section
// and similar planning documents (task Section 5.F's own explicit warning
// against exactly that false positive).

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';

function readJson(repoRoot, relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function readText(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** The first `## [X.Y.Z]` heading that is not literally `[Unreleased]`. */
function extractLatestReleasedChangelogVersion(changelogText) {
  if (!changelogText) return null;
  const re = /^## \[([^\]]+)\]/gm;
  let m;
  while ((m = re.exec(changelogText)) !== null) {
    if (m[1] !== 'Unreleased' && /^\d+\.\d+\.\d+$/.test(m[1])) return m[1];
  }
  return null;
}

export async function runInternalDriftChecks({ repoRoot }) {
  const results = [];

  const pkgJson = readJson(repoRoot, 'package.json');
  const claudePluginJson = readJson(repoRoot, 'plugins/krylo/.claude-plugin/plugin.json');
  const codexPluginJson = readJson(repoRoot, 'plugins/krylo/.codex-plugin/plugin.json');
  const marketplaceJson = readJson(repoRoot, '.claude-plugin/marketplace.json');
  const changelogText = readText(repoRoot, 'CHANGELOG.md');

  const sources = [
    { label: 'package.json', value: pkgJson?.version ?? null },
    { label: 'plugins/krylo/.claude-plugin/plugin.json', value: claudePluginJson?.version ?? null },
    { label: 'plugins/krylo/.codex-plugin/plugin.json', value: codexPluginJson?.version ?? null },
    { label: '.claude-plugin/marketplace.json (plugins[0].version)', value: marketplaceJson?.plugins?.[0]?.version ?? null },
    { label: 'CHANGELOG.md (latest released heading)', value: extractLatestReleasedChangelogVersion(changelogText) },
  ];

  const presentValues = sources.map((s) => s.value).filter((v) => v !== null);
  const allAgree = presentValues.length > 0 && presentValues.every((v) => v === presentValues[0]);
  const missing = sources.filter((s) => s.value === null);

  // A fresh independent Reviewer found and reproduced that evaluating
  // `missing.length > 0` BEFORE `allAgree` let a missing source MASK a
  // genuine, simultaneous version disagreement among the sources that
  // WERE present: the combined case (one source missing, and the
  // remaining sources disagree with each other) previously downgraded to
  // 'blocked'/'medium' -- dropping computeExitCode's exit 1 -- instead of
  // the 'changed'/'high' a real disagreement deserves. Disagreement among
  // present values is now evaluated independently and takes priority; a
  // missing source alone (with the rest agreeing) still reports
  // 'blocked'/'medium', never silently "ok".
  const disagreement = presentValues.length > 0 && !allAgree;
  results.push(
    buildCheckResult({
      id: 'product-version-agreement',
      category: 'internal-drift',
      status: disagreement ? 'changed' : missing.length > 0 ? 'blocked' : 'ok',
      severity: disagreement ? 'high' : missing.length > 0 ? 'medium' : 'info',
      current: presentValues[0] ?? null,
      observed: sources.map((s) => `${s.label}=${s.value ?? 'missing'}`).join('; '),
      evidence: sources.map((s) => s.label),
      recommendedAction: disagreement || missing.length > 0 ? 'Reconcile the KRYLO product version across all listed sources.' : 'none',
      requiresHumanReview: disagreement || missing.length > 0,
    }),
  );

  const engines = pkgJson?.engines?.node;
  const enginesFormatOk = typeof engines === 'string' && /^>=\d+\.\d+\.\d+$/.test(engines.trim());
  results.push(
    buildCheckResult({
      id: 'package-json-engines-well-formed',
      category: 'internal-drift',
      status: enginesFormatOk ? 'ok' : 'changed',
      severity: enginesFormatOk ? 'info' : 'medium',
      current: '>=X.Y.Z',
      observed: typeof engines === 'string' ? engines : 'missing',
      evidence: ['package.json'],
      recommendedAction: enginesFormatOk ? 'none' : 'package.json engines.node is missing or not a well-formed ">=X.Y.Z" range.',
      requiresHumanReview: !enginesFormatOk,
    }),
  );

  return results;
}
