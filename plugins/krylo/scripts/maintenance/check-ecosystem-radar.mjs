#!/usr/bin/env node
// Monthly Ecosystem Radar entrypoint (docs/adr/0039-monthly-ecosystem-radar.md).
//
// Read-only by construction: it reads two repository catalogs, performs
// unauthenticated GETs against the GitHub API allowlist upstream-client.mjs
// enforces, and prints a triage report. It never installs, executes,
// commits, opens a PR or an issue, and never changes catalog/tools.json.
//
// Exit 0 even when candidates are found -- a candidate is an input to human
// review, never a build failure. Only an internal failure exits nonzero.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEcosystemRadar, computeRadarExitCode, HUMAN_JUDGEMENT_DIMENSIONS } from './checks/ecosystem-radar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const LABEL = { AUDIT_RECOMMENDED: 'AUDIT  ', WATCH: 'WATCH  ', REJECT: 'REJECT ' };

function renderText(report) {
  const lines = ['KRYLO Monthly Ecosystem Radar', `mode: ${report.mode}`, ''];
  if (report.error) {
    lines.push(`internal failure: ${report.error}`);
    return lines.join('\n');
  }

  for (const s of report.sources ?? []) {
    lines.push(s.status === 'ok'
      ? `source ${s.id}: ${s.found} result(s)`
      : `source ${s.id}: ${s.status} -- ${s.detail}`);
  }
  lines.push('');

  for (const c of report.candidates ?? []) {
    lines.push(`${LABEL[c.classification] ?? c.classification} ${c.source}`);
    lines.push(`         publisher: ${c.publisher} (${c.publisherType})   license: ${c.license}   stars: ${c.stars ?? 'n/a'}`);
    lines.push(`         maintenance: ${c.maintenanceSignal}`);
    lines.push(`         score: ${c.score.scored}/${c.score.maxAvailable} on measurable dimensions${c.deepInspected ? '' : ' (not deep-inspected)'}`);
    if (c.score.unknownDimensions.length) lines.push(`         not measurable here: ${c.score.unknownDimensions.join(', ')}`);
    if (c.riskPenalties.applied.length) lines.push(`         risk: ${c.riskPenalties.applied.join(', ')}`);
    if (c.overlap.alreadyInTrustCatalog) lines.push(`         overlap: already reviewed as ${c.overlap.catalogId} (tier ${c.overlap.trustTier})`);
    if (c.description) lines.push(`         "${c.description}"`);
    lines.push(`         why: ${c.rationale}`);
    lines.push('');
  }

  const s = report.summary ?? {};
  lines.push(`summary: ${s.total ?? 0} candidate(s) -- ${s.auditRecommended ?? 0} audit-recommended, ${s.watch ?? 0} watch, ${s.rejected ?? 0} rejected, ${s.sourcesUnavailable ?? 0} source(s) unavailable`);
  lines.push('');
  lines.push('The score above is PARTIAL by design. These dimensions of the approved');
  lines.push('scoring model cannot be derived from repository metadata and are left to');
  lines.push('a human reviewer, never guessed:');
  for (const [dim, max] of Object.entries(HUMAN_JUDGEMENT_DIMENSIONS)) {
    lines.push(`  - ${dim} (${max} points)`);
  }
  lines.push('');
  lines.push('AUDIT_RECOMMENDED means only "a human should look at this". Nothing here');
  lines.push('adopts a tool, confers trust, or changes catalog/tools.json -- that remains');
  lines.push('a separate, human-initiated review (design Section 16.5).');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, offline: args.includes('--offline') });
  process.stdout.write(`${args.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report)}\n`);
  process.exit(computeRadarExitCode(report));
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
