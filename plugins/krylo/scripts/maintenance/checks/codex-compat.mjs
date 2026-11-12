// Category B: Codex compatibility (task Section 5.B).
// Codex Host is implemented but not yet published (ADR-0029); there is no
// formal "minimum supported" floor yet, only a "verified/tested against"
// version. This checker never silently treats the latest Codex release as
// automatically compatible (task Section 5.B's explicit warning).

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';
import { parseCodexVersion, compareParsed } from '../../lib/version-compare.mjs';
import { loadCompatibilityContract } from '../../host/codex/runtime-compat.mjs';

// Which hook events each supported Codex build is confirmed to accept comes
// from the reviewed runtime contract, the same file the runtime gate trusts
// (docs/adr/0034-codex-runtime-compatibility-gate.md). This check previously
// carried its own snapshot of the 0.120.0 binary's event enum; it never
// learned that 0.154.0 confirms SessionEnd, so it reported SessionEnd as
// unknown in general instead of unconfirmed on 0.120.0 only.
const CONTRACT_REL_PATH = 'plugins/krylo/policies/codex-runtime-compatibility.json';

function compareVersionStrings(a, b) {
  return compareParsed(parseCodexVersion(`rust-v${a}`), parseCodexVersion(`rust-v${b}`));
}

/**
 * Supported entries with a usable confirmedHookEvents list, newest first, or
 * null when the contract cannot answer the question. Never a fallback list:
 * an unanswerable contract is reported as blocked, not as "nothing to check".
 */
function loadSupportedEventSets(repoRoot) {
  const loaded = loadCompatibilityContract({ contractPath: path.join(repoRoot, CONTRACT_REL_PATH) });
  if (!loaded.ok) return null;
  const supported = loaded.contract.supported;
  if (supported.length === 0) return null;
  if (supported.some((s) => !Array.isArray(s.confirmedHookEvents) || !parseCodexVersion(`rust-v${s.version}`).ok)) return null;
  return [...supported].sort((a, b) => compareVersionStrings(b.version, a.version));
}

function readText(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

function extractTestedVersion(capabilityMatrixText) {
  if (!capabilityMatrixText) return null;
  const m = /Installed Codex CLI verified against:\s*`codex-cli (\d+\.\d+\.\d+)`/.exec(capabilityMatrixText);
  return m ? m[1] : null;
}

export async function runCodexCompatChecks({ repoRoot, offline, upstream }) {
  const results = [];

  const capabilityMatrix = readText(repoRoot, 'docs/codex-capability-matrix.md');
  const adr0029 = readText(repoRoot, 'docs/adr/0029-codex-host-packaging-and-approval-boundary.md');
  const testedVersion = extractTestedVersion(capabilityMatrix);

  results.push(
    buildCheckResult({
      id: 'codex-tested-version-documented',
      category: 'codex-compat',
      status: testedVersion ? 'ok' : 'blocked',
      severity: testedVersion ? 'info' : 'medium',
      current: testedVersion,
      observed: testedVersion ? `codex-cli ${testedVersion}` : 'not-found',
      evidence: ['docs/codex-capability-matrix.md'],
      recommendedAction: testedVersion ? 'none' : 'docs/codex-capability-matrix.md no longer states a verified Codex CLI version in the expected shape.',
      requiresHumanReview: !testedVersion,
    }),
  );

  const consistentWithAdr = testedVersion && adr0029 ? adr0029.includes(testedVersion) : false;
  results.push(
    buildCheckResult({
      id: 'codex-tested-version-consistent-with-adr',
      category: 'codex-compat',
      status: !testedVersion ? 'blocked' : consistentWithAdr ? 'ok' : 'warning',
      severity: !testedVersion ? 'medium' : consistentWithAdr ? 'info' : 'low',
      current: testedVersion,
      observed: consistentWithAdr,
      evidence: ['docs/adr/0029-codex-host-packaging-and-approval-boundary.md'],
      recommendedAction: consistentWithAdr ? 'none' : 'Reconcile the tested Codex version between the capability matrix and ADR-0029.',
      requiresHumanReview: !consistentWithAdr,
    }),
  );

  const codexHooksText = readText(repoRoot, 'plugins/krylo/hooks/codex-hooks.json');
  let declaredEvents = [];
  if (codexHooksText) {
    try {
      const parsed = JSON.parse(codexHooksText);
      // Events nest under a top-level `hooks` key -- the only shape current
      // Codex builds accept (docs/adr/0035-codex-live-hook-verification.md).
      // Reading the top level directly, as this check did before that ADR,
      // made it report the literal keys "description" and "hooks" as if they
      // were hook events: a permanent false `high`, AND -- far worse -- it
      // stopped looking at the real event names entirely, so the one thing
      // this check exists to catch (a registration for an event the build
      // does not recognize) would have passed unnoticed. Found by an
      // independent Security Reviewer.
      const eventMap = parsed?.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
        ? parsed.hooks
        : {};
      declaredEvents = Object.keys(eventMap);
    } catch {
      declaredEvents = [];
    }
  }
  const supportedEventSets = loadSupportedEventSets(repoRoot);
  const evidence = ['plugins/krylo/hooks/codex-hooks.json', CONTRACT_REL_PATH];
  if (!supportedEventSets) {
    results.push(
      buildCheckResult({
        id: 'codex-hook-event-names-recognized',
        category: 'codex-compat',
        status: 'blocked',
        severity: 'medium',
        current: null,
        observed: declaredEvents.join(','),
        evidence,
        recommendedAction: `${CONTRACT_REL_PATH} is missing, invalid, lists no supported version, or has a supported version without confirmedHookEvents; restore it before trusting any declared Codex hook event.`,
        requiresHumanReview: true,
      }),
    );
  } else {
    // Per supported version: declared events that version is not confirmed to accept.
    const gaps = supportedEventSets
      .map((s) => ({ version: s.version, missing: declaredEvents.filter((e) => !s.confirmedHookEvents.includes(e)) }))
      .filter((g) => g.missing.length > 0);
    const clean = declaredEvents.length > 0 && gaps.length === 0;
    results.push(
      buildCheckResult({
        id: 'codex-hook-event-names-recognized',
        category: 'codex-compat',
        status: declaredEvents.length === 0 ? 'blocked' : clean ? 'ok' : 'changed',
        severity: declaredEvents.length === 0 ? 'medium' : clean ? 'info' : 'high',
        current: supportedEventSets.map((s) => `${s.version}: ${s.confirmedHookEvents.join(',')}`).join(' | '),
        observed: declaredEvents.join(','),
        evidence,
        recommendedAction: clean || declaredEvents.length === 0
          ? 'none'
          : `Declared Codex Hook event(s) not confirmed on a supported runtime -- ${gaps.map((g) => `${g.missing.join(', ')} on ${g.version}`).join('; ')}. Verify against that exact binary, or retire the version from the contract.`,
        requiresHumanReview: !clean,
      }),
    );
  }

  // Upstream drift is measured from the newest version the contract supports
  // -- the runtime KRYLO actually trusts today -- not from the capability
  // matrix's historical anchor (testedVersion above), which stays 0.120.0
  // because ADR-0029 and the matrix's older rows are pinned to it.
  const newestSupported = supportedEventSets?.[0]?.version ?? null;
  if (offline || !newestSupported) {
    results.push(
      buildCheckResult({
        id: 'codex-tested-version-vs-latest-upstream',
        category: 'codex-compat',
        status: 'unavailable',
        severity: 'info',
        current: newestSupported,
        observed: null,
        evidence: [],
        recommendedAction: 'Run in live mode to verify against api.github.com.',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  const parsedTested = parseCodexVersion(`rust-v${newestSupported}`);
  const latestRelease = await upstream.getLatestGithubRelease('openai', 'codex');
  if (latestRelease.ok && typeof latestRelease.json?.tag_name === 'string' && parsedTested.ok) {
    const parsedLatest = parseCodexVersion(latestRelease.json.tag_name);
    const isBehind = parsedLatest.ok && compareParsed(parsedLatest, parsedTested) > 0;
    results.push(
      buildCheckResult({
        id: 'codex-tested-version-vs-latest-upstream',
        category: 'codex-compat',
        status: isBehind ? 'changed' : 'ok',
        severity: isBehind ? 'medium' : 'info',
        current: `codex-cli ${newestSupported}`,
        observed: latestRelease.json.tag_name,
        evidence: ['https://api.github.com/repos/openai/codex/releases/latest'],
        recommendedAction: isBehind
          ? 'Codex CLI has newer upstream releases than the version KRYLO is verified/tested against; consider re-verifying capability assumptions.'
          : 'none',
        requiresHumanReview: isBehind,
      }),
    );
  } else {
    results.push(
      buildCheckResult({
        id: 'codex-tested-version-vs-latest-upstream',
        category: 'codex-compat',
        status: 'unavailable',
        severity: 'info',
        current: newestSupported,
        observed: null,
        evidence: [],
        recommendedAction: 'none',
        requiresHumanReview: false,
      }),
    );
  }

  return results;
}
