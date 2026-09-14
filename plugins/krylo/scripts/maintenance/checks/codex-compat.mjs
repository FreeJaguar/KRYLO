// Category B: Codex compatibility (task Section 5.B).
// Codex Host is implemented but not yet published (ADR-0029); there is no
// formal "minimum supported" floor yet, only a "verified/tested against"
// version. This checker never silently treats the latest Codex release as
// automatically compatible (task Section 5.B's explicit warning).

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';
import { parseCodexVersion, compareParsed } from '../../lib/version-compare.mjs';

// The confirmed-accepted Codex Hook event enum, sourced from ADR-0029's own
// direct byte inspection of the real installed codex-cli 0.120.0 binary's
// embedded HookEventNameWire schema (not a web-fetched summary, not
// memory) -- KRYLO's own small expectation snapshot (task Section 13),
// scoped to exactly what plugins/krylo/hooks/codex-hooks.json uses.
const KNOWN_ACCEPTED_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']);

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
  const unknownEvents = declaredEvents.filter((e) => !KNOWN_ACCEPTED_HOOK_EVENTS.has(e));
  results.push(
    buildCheckResult({
      id: 'codex-hook-event-names-recognized',
      category: 'codex-compat',
      status: declaredEvents.length === 0 ? 'blocked' : unknownEvents.length === 0 ? 'ok' : 'changed',
      severity: unknownEvents.length === 0 ? 'info' : 'high',
      current: [...KNOWN_ACCEPTED_HOOK_EVENTS].join(','),
      observed: declaredEvents.join(','),
      evidence: ['plugins/krylo/hooks/codex-hooks.json'],
      recommendedAction: unknownEvents.length === 0 ? 'none' : `Verify unrecognized Codex Hook event(s) against the real installed binary's schema before trusting: ${unknownEvents.join(', ')}`,
      requiresHumanReview: unknownEvents.length > 0,
    }),
  );

  if (offline || !testedVersion) {
    results.push(
      buildCheckResult({
        id: 'codex-tested-version-vs-latest-upstream',
        category: 'codex-compat',
        status: 'unavailable',
        severity: 'info',
        current: testedVersion,
        observed: null,
        evidence: [],
        recommendedAction: 'Run in live mode to verify against api.github.com.',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  const parsedTested = parseCodexVersion(`rust-v${testedVersion}`);
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
        current: `codex-cli ${testedVersion}`,
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
        current: testedVersion,
        observed: null,
        evidence: [],
        recommendedAction: 'none',
        requiresHumanReview: false,
      }),
    );
  }

  return results;
}
