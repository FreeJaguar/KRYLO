// Category A: Claude Code compatibility (task Section 5.A).
// Read-only: never raises the pinned floor, only detects drift.

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';
import { parseSemver, compareParsed } from '../../lib/version-compare.mjs';

// The small, KRYLO-owned normalized surface this checker depends on (task
// Section 13: snapshot only what KRYLO actually uses, never the full
// upstream schema). This is exactly the six Hook events
// plugins/krylo/skills/run/SKILL.md's own frontmatter declares -- NOT a
// full copy of Claude Code's entire documented event enum. Cross-confirmed
// current and present via https://code.claude.com/docs/en/hooks during
// this checkpoint's own research pass (docs/process/
// ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md); this is KRYLO's own
// expectation snapshot, not a claim about Claude Code's complete API.
const KNOWN_ACCEPTED_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

function readText(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** Extract the `vX.Y.Z` pinned floor from a workflow's GitHub-release download URL. */
function extractPinnedFloor(workflowText) {
  if (!workflowText) return null;
  const m = /releases\/download\/v(\d+\.\d+\.\d+)\//.exec(workflowText);
  return m ? m[1] : null;
}

function extractHookEventNames(skillFrontmatterText) {
  if (!skillFrontmatterText) return [];
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillFrontmatterText);
  const yamlText = frontmatterMatch ? frontmatterMatch[1] : skillFrontmatterText;
  const hooksIdx = yamlText.indexOf('\nhooks:');
  if (hooksIdx === -1) return [];
  const hooksBlock = yamlText.slice(hooksIdx);
  const eventNames = [];
  const lineRe = /^  (\w+):$/gm;
  let m;
  while ((m = lineRe.exec(hooksBlock)) !== null) {
    eventNames.push(m[1]);
  }
  return eventNames;
}

export async function runClaudeCompatChecks({ repoRoot, offline, upstream }) {
  const results = [];

  const validateWorkflow = readText(repoRoot, '.github/workflows/validate-plugin.yml');
  const releaseWorkflow = readText(repoRoot, '.github/workflows/release.yml');
  const adr0022 = readText(repoRoot, 'docs/adr/0022-claude-code-compatibility-policy.md');
  const releaseReadiness = readText(repoRoot, 'RELEASE_READINESS.md');

  const floorFromValidate = extractPinnedFloor(validateWorkflow);
  const floorFromRelease = extractPinnedFloor(releaseWorkflow);
  const sources = [
    { label: 'validate-plugin.yml', value: floorFromValidate },
    { label: 'release.yml', value: floorFromRelease },
  ];
  const knownFloors = sources.map((s) => s.value).filter(Boolean);
  const allAgree = knownFloors.length > 0 && knownFloors.every((v) => v === knownFloors[0]);

  results.push(
    buildCheckResult({
      id: 'claude-pinned-floor-internal-consistency',
      category: 'claude-compat',
      status: knownFloors.length === 0 ? 'blocked' : allAgree ? 'ok' : 'changed',
      severity: knownFloors.length === 0 ? 'high' : allAgree ? 'info' : 'high',
      current: knownFloors[0] || null,
      observed: sources.map((s) => `${s.label}=${s.value ?? 'missing'}`).join(', '),
      evidence: ['.github/workflows/validate-plugin.yml', '.github/workflows/release.yml'],
      recommendedAction: allAgree ? 'none' : 'Reconcile the pinned Claude Code floor across validate-plugin.yml and release.yml.',
      requiresHumanReview: !allAgree,
    }),
  );

  const floor = floorFromValidate;
  if (floor) {
    const floorMentionedInAdr = adr0022 ? adr0022.includes(floor) : false;
    const floorMentionedInReadiness = releaseReadiness ? releaseReadiness.includes(floor) : false;
    const docsAgree = floorMentionedInAdr && floorMentionedInReadiness;
    results.push(
      buildCheckResult({
        id: 'claude-pinned-floor-documented-consistently',
        category: 'claude-compat',
        status: docsAgree ? 'ok' : 'warning',
        severity: docsAgree ? 'info' : 'low',
        current: floor,
        observed: `ADR-0022 mentions it: ${floorMentionedInAdr}; RELEASE_READINESS.md mentions it: ${floorMentionedInReadiness}`,
        evidence: ['docs/adr/0022-claude-code-compatibility-policy.md', 'RELEASE_READINESS.md'],
        recommendedAction: docsAgree ? 'none' : 'Update documentation to state the current pinned floor.',
        requiresHumanReview: !docsAgree,
      }),
    );
  }

  const skillText = readText(repoRoot, 'plugins/krylo/skills/run/SKILL.md');
  const eventNames = extractHookEventNames(skillText);
  const unknownEvents = eventNames.filter((e) => !KNOWN_ACCEPTED_HOOK_EVENTS.has(e));
  results.push(
    buildCheckResult({
      id: 'claude-hook-event-names-recognized',
      category: 'claude-compat',
      status: eventNames.length === 0 ? 'blocked' : unknownEvents.length === 0 ? 'ok' : 'changed',
      severity: unknownEvents.length === 0 ? 'info' : 'medium',
      current: [...KNOWN_ACCEPTED_HOOK_EVENTS].join(','),
      observed: eventNames.join(','),
      evidence: ['plugins/krylo/skills/run/SKILL.md'],
      recommendedAction: unknownEvents.length === 0 ? 'none' : `Verify unrecognized Hook event(s) against current Claude Code docs: ${unknownEvents.join(', ')}`,
      requiresHumanReview: unknownEvents.length > 0,
    }),
  );

  if (offline || !floor) {
    results.push(
      buildCheckResult({
        id: 'claude-pinned-floor-still-available-upstream',
        category: 'claude-compat',
        status: 'unavailable',
        severity: 'info',
        current: floor,
        observed: null,
        evidence: [],
        recommendedAction: 'Run in live mode to verify against api.github.com.',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  const parsedFloor = parseSemver(floor);
  if (!parsedFloor.ok) {
    results.push(
      buildCheckResult({
        id: 'claude-pinned-floor-still-available-upstream',
        category: 'claude-compat',
        status: 'blocked',
        severity: 'high',
        current: floor,
        observed: 'malformed-version',
        evidence: ['.github/workflows/validate-plugin.yml'],
        recommendedAction: 'The pinned floor extracted from validate-plugin.yml is not a valid X.Y.Z version.',
        requiresHumanReview: true,
      }),
    );
    return results;
  }

  const floorRelease = await upstream.getGithubReleaseByTag('anthropics', 'claude-code', `v${floor}`);
  results.push(
    buildCheckResult({
      id: 'claude-pinned-floor-still-available-upstream',
      category: 'claude-compat',
      status: floorRelease.ok ? 'ok' : 'changed',
      severity: floorRelease.ok ? 'info' : 'high',
      current: floor,
      observed: floorRelease.ok ? 'available' : floorRelease.reason,
      evidence: [`https://api.github.com/repos/anthropics/claude-code/releases/tags/v${floor}`],
      recommendedAction: floorRelease.ok ? 'none' : 'The pinned minimum-supported Claude Code release is no longer available upstream.',
      requiresHumanReview: !floorRelease.ok,
    }),
  );

  const latestRelease = await upstream.getLatestGithubRelease('anthropics', 'claude-code');
  if (latestRelease.ok && typeof latestRelease.json?.tag_name === 'string') {
    const parsedLatest = parseSemver(latestRelease.json.tag_name);
    const isNewer = parsedLatest.ok && compareParsed(parsedLatest, parsedFloor) > 0;
    results.push(
      buildCheckResult({
        id: 'claude-newer-release-available',
        category: 'claude-compat',
        status: isNewer ? 'changed' : 'ok',
        severity: isNewer ? 'info' : 'info',
        current: floor,
        observed: latestRelease.json.tag_name,
        evidence: ['https://api.github.com/repos/anthropics/claude-code/releases/latest'],
        recommendedAction: isNewer ? 'A newer Claude Code release exists; the pinned floor remains supported and requires no action.' : 'none',
        requiresHumanReview: false,
      }),
    );
  } else {
    results.push(
      buildCheckResult({
        id: 'claude-newer-release-available',
        category: 'claude-compat',
        status: 'unavailable',
        severity: 'info',
        current: floor,
        observed: null,
        evidence: [],
        recommendedAction: 'none',
        requiresHumanReview: false,
      }),
    );
  }

  return results;
}
