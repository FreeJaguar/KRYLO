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

/** A `const NAME = 'X.Y.Z';` version stamp declared in a setup script. */
function extractDeclaredVersion(scriptText, constName) {
  if (!scriptText) return null;
  const m = new RegExp(`const\\s+${constName}\\s*=\\s*['"](\\d+\\.\\d+\\.\\d+)['"]`).exec(scriptText);
  return m ? m[1] : null;
}

/** The launcher stamps its own version in a comment, not a constant. */
function extractHookLauncherVersion(scriptText) {
  if (!scriptText) return null;
  const m = /krylo-hook-launcher-version:\s*(\d+\.\d+\.\d+)/.exec(scriptText);
  return m ? m[1] : null;
}

export async function runInternalDriftChecks({ repoRoot }) {
  const results = [];

  const pkgJson = readJson(repoRoot, 'package.json');
  const claudePluginJson = readJson(repoRoot, 'plugins/krylo/.claude-plugin/plugin.json');
  const codexPluginJson = readJson(repoRoot, 'plugins/krylo/.codex-plugin/plugin.json');
  const marketplaceJson = readJson(repoRoot, '.claude-plugin/marketplace.json');
  const changelogText = readText(repoRoot, 'CHANGELOG.md');

  // Version stamps EMBEDDED in generated, user-facing artifacts. These are
  // not manifests -- they are constants the setup scripts write into files a
  // user ends up with on disk (an installed alias, a Codex rules file, a
  // project hook launcher), so a stale one is a false provenance claim in
  // something the user can read.
  //
  // They are checked here because leaving them out is exactly how they went
  // stale twice. RELEASE_READINESS.md records the first time: both were
  // found still hardcoded to 0.1.1 during the 0.2.0 checkpoint, caught only
  // by a full-suite test failure. That test asserts the stamp against a
  // hardcoded literal, so it catches a drift between the script and the
  // TEST, never a drift between the script and the real product version --
  // which is why the identical mistake recurred at 0.3.0 with every test
  // still green. Covering them here is the only form of this check that
  // cannot go quiet the same way a third time.
  const aliasScript = readText(repoRoot, 'plugins/krylo/scripts/setup/install-alias.mjs');
  const codexInstallScript = readText(repoRoot, 'plugins/krylo/scripts/setup/install-codex.mjs');
  const hookLauncherScript = readText(repoRoot, 'plugins/krylo/codex/project-hooks/codex-project-hook-launcher.mjs');

  const sources = [
    { label: 'package.json', value: pkgJson?.version ?? null },
    { label: 'plugins/krylo/.claude-plugin/plugin.json', value: claudePluginJson?.version ?? null },
    { label: 'plugins/krylo/.codex-plugin/plugin.json', value: codexPluginJson?.version ?? null },
    { label: '.claude-plugin/marketplace.json (plugins[0].version)', value: marketplaceJson?.plugins?.[0]?.version ?? null },
    { label: 'CHANGELOG.md (latest released heading)', value: extractLatestReleasedChangelogVersion(changelogText) },
    { label: 'install-alias.mjs (ALIAS_VERSION)', value: extractDeclaredVersion(aliasScript, 'ALIAS_VERSION') },
    { label: 'install-codex.mjs (RULES_VERSION)', value: extractDeclaredVersion(codexInstallScript, 'RULES_VERSION') },
    { label: 'install-codex.mjs (HOOKS_VERSION)', value: extractDeclaredVersion(codexInstallScript, 'HOOKS_VERSION') },
    { label: 'codex-project-hook-launcher.mjs (krylo-hook-launcher-version)', value: extractHookLauncherVersion(hookLauncherScript) },
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
