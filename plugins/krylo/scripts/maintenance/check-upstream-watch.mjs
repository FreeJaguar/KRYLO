#!/usr/bin/env node
// Weekly Upstream Watch entrypoint (docs/adr/0036-weekly-upstream-watch.md).
//
// Read-only by construction: it reads two repository catalogs, performs
// unauthenticated GETs against the GitHub API allowlist upstream-client.mjs
// enforces, and prints a report. It never writes a repository file, never
// promotes an observed ref into the trusted catalog, never opens a PR or an
// issue, and never executes anything belonging to a watched candidate.
//
// Exit code is 0 even when drift is found: this workflow must never be able
// to block a PR or a release. Only an internal failure (an unreadable
// catalog) exits nonzero.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUpstreamWatch, computeWatchExitCode } from './checks/upstream-watch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const CLASSIFICATION_LABEL = {
  NO_DRIFT: 'NO DRIFT   ',
  DRIFT_LOW_RISK: 'LOW RISK   ',
  REVIEW_REQUIRED: 'REVIEW     ',
  SECURITY_REVIEW_REQUIRED: 'SECURITY   ',
  SOURCE_UNAVAILABLE: 'UNAVAILABLE',
};

function renderText(report) {
  const lines = [];
  lines.push('KRYLO Weekly Upstream Watch');
  lines.push(`mode: ${report.mode}    overall: ${report.overall}`);
  lines.push('');
  if (report.error) {
    lines.push(`internal failure: ${report.error}`);
    return lines.join('\n');
  }
  for (const r of report.results) {
    lines.push(`${CLASSIFICATION_LABEL[r.classification] ?? r.classification} ${r.id}`);
    lines.push(`            reviewed: ${r.reviewedRef ?? '(none)'}`);
    lines.push(`            observed: ${r.observedRef ?? '(not observed)'}`);
    if (r.reasons?.length) lines.push(`            signals:  ${r.reasons.join(', ')}`);
    if (Number.isInteger(r.changedFileCount)) {
      lines.push(`            changed:  ${r.changedFileCount} file(s)${Number.isInteger(r.commitCount) ? `, ${r.commitCount} commit(s)` : ''}`);
    }
    if (r.changedPathSample?.length) lines.push(`            sample:   ${r.changedPathSample.join(', ')}`);
    lines.push(`            note:     ${r.detail}`);
    lines.push('');
  }
  lines.push('A changed upstream ref is NEVER promoted into catalog/tools.json by this');
  lines.push('workflow. A deep re-review is a separate, human-initiated process against an');
  lines.push('exact source and an exact version or commit (design Section 15.6).');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const asJson = args.includes('--json');

  const report = await runUpstreamWatch({ repoRoot: REPO_ROOT, offline });
  process.stdout.write(`${asJson ? JSON.stringify(report, null, 2) : renderText(report)}\n`);
  process.exit(computeWatchExitCode(report));
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
