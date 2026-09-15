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

import {
  runEcosystemRadar,
  computeRadarExitCode,
  HUMAN_JUDGEMENT_DIMENSIONS,
  BEHAVIOURAL_PENALTIES,
} from './checks/ecosystem-radar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const LABEL = { AUDIT_RECOMMENDED: 'AUDIT  ', WATCH: 'WATCH  ', REJECT: 'REJECT ' };

// Exported for test. An independent review pointed out that this function
// had no test of any kind -- and it is the entire subject of the F2 fix,
// where a correctly-computed honesty signal was simply never printed. A
// renderer nobody asserts on is exactly where that defect returns in
// silence, so the report's honesty lines are now pinned by test.
export function renderText(report) {
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
    // Rendered right beside `risk:`, and deliberately so. The checker has
    // always computed `undetectable`, but an earlier version of this
    // renderer dropped it -- and this text report is the ONLY output the
    // scheduled workflow produces. A risk line with nothing under it then
    // read as "checked, and clean" for penalties nobody had checked,
    // which is the exact claim ADR-0039 exists to refuse. An absent line
    // and an absent risk must not look the same.
    // Only the penalties undetectable for THIS candidate. The behavioural
    // set is undetectable for every candidate and is stated once below;
    // repeating it here made the informative case -- a probe that failed on
    // this one repository -- invisible inside a constant list.
    const candidateSpecific = c.riskPenalties.undetectable.filter((x) => !BEHAVIOURAL_PENALTIES.includes(x));
    if (candidateSpecific.length) lines.push(`         not checked on this candidate: ${candidateSpecific.join(', ')}`);
    if (c.probeFailures?.length) {
      lines.push(`         inspection incomplete: ${c.probeFailures.map((f) => `${f.probe} (${f.reason})`).join(', ')}`);
    }
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
  lines.push('A "not checked on this candidate" line is not a clean bill of health: it');
  lines.push('names a penalty this run could not evaluate for that repository, which is');
  lines.push('different from one it evaluated and cleared. An unknown is never reported');
  lines.push('as an absence.');
  lines.push('');
  lines.push('These penalties are undetectable for EVERY candidate, because establishing');
  lines.push('them requires reading a candidate\'s actual runtime behaviour, which this');
  lines.push('Radar never does. No candidate above has been cleared of them:');
  for (const penalty of BEHAVIOURAL_PENALTIES) {
    lines.push(`  - ${penalty}`);
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
  // Set the code and let the process end on its own rather than calling
  // process.exit: when stdout is a pipe -- which is exactly how the
  // workflow runs this, redirecting into radar.txt -- process.exit can
  // terminate the process before a large buffered write has drained,
  // silently truncating the only artefact the run produces.
  process.exitCode = computeRadarExitCode(report);
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
