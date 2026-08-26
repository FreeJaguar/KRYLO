// Category D: Node/runtime compatibility (task Section 5.D).
// Purely internal consistency -- task Section 5.D asks only whether
// repository-supported Node versions agree with EACH OTHER across
// package.json/workflows/docs, not whether Node's own upstream LTS
// schedule has moved (a live nodejs.org check was deliberately not added;
// see docs/process/ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md Section 7
// for why). Fully deterministic, works identically offline and live.

import fs from 'node:fs';
import path from 'node:path';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';
import { listWorkflowFiles } from './actions-pins.mjs';

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

function extractEnginesFloor(pkgJson) {
  const raw = pkgJson?.engines?.node;
  if (typeof raw !== 'string') return null;
  const m = /^>=\s*(\d+)/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

// A fresh independent Reviewer found and reproduced (MEDIUM-7) that the
// original regex required end-of-line immediately after the digits,
// missing the common `actions/setup-node` "NN.x" form (e.g.
// `node-version: "20.x"`) and any trailing YAML comment on the same
// line -- both silently extracted as "no version found" rather than the
// real value, which a downstream check then read as a clean pass. The
// major version number is captured; anything after a `.` (a minor/patch
// suffix like `.x`/`.17.0`) is intentionally ignored, since this
// checker's own floor comparison (extractEnginesFloor) only ever
// compares major versions too.
function extractWorkflowNodeVersions(text) {
  if (!text) return [];
  const versions = new Set();
  const singleRe = /node-version:\s*["']?(\d+)(?:\.\S*)?["']?/g;
  let m;
  while ((m = singleRe.exec(text)) !== null) versions.add(Number(m[1]));
  const matrixRe = /node:\s*\[([^\]]+)\]/.exec(text);
  if (matrixRe) {
    for (const part of matrixRe[1].split(',')) {
      const n = Number(part.trim().replace(/["']/g, '').split('.')[0]);
      if (Number.isFinite(n)) versions.add(n);
    }
  }
  return [...versions];
}

export async function runNodeRuntimeChecks({ repoRoot }) {
  const results = [];

  const pkgJson = readJson(repoRoot, 'package.json');
  const lockJson = readJson(repoRoot, 'package-lock.json');
  const floorFromPkg = extractEnginesFloor(pkgJson);
  const floorFromLock = extractEnginesFloor(lockJson?.packages?.['']);

  const pkgLockAgree = floorFromPkg !== null && floorFromPkg === floorFromLock;
  results.push(
    buildCheckResult({
      id: 'node-engines-floor-package-lock-consistency',
      category: 'node-runtime',
      status: floorFromPkg === null ? 'blocked' : pkgLockAgree ? 'ok' : 'changed',
      severity: floorFromPkg === null ? 'medium' : pkgLockAgree ? 'info' : 'medium',
      current: floorFromPkg !== null ? `>=${floorFromPkg}` : null,
      observed: floorFromLock !== null ? `>=${floorFromLock}` : 'missing',
      evidence: ['package.json', 'package-lock.json'],
      recommendedAction: pkgLockAgree ? 'none' : 'Run `npm install` to sync package-lock.json engines with package.json, or reconcile manually.',
      requiresHumanReview: !pkgLockAgree,
    }),
  );

  // A fresh independent Reviewer found (MEDIUM-6) that a hardcoded
  // four-file list meant this checker could never see a NEW workflow --
  // including its own ecosystem-maintenance.yml -- silently exempting it
  // from ever being checked. Enumerating the real directory (the same
  // approach actions-pins.mjs already uses) means every current and
  // future workflow file is covered automatically.
  const workflowFiles = listWorkflowFiles(repoRoot);
  const perWorkflow = workflowFiles.map((f) => ({ file: f, versions: extractWorkflowNodeVersions(readText(repoRoot, f)) }));
  const allVersionsUsed = [...new Set(perWorkflow.flatMap((w) => w.versions))].sort((a, b) => a - b);

  if (workflowFiles.length > 0 && allVersionsUsed.length === 0) {
    // Mirrors actions-pins.mjs's HIGH-2 fix: workflow files exist and are
    // readable, but zero Node versions were extracted from any of them --
    // every real KRYLO workflow declares Node somewhere, so this is a
    // parser problem, never a legitimate "nothing to check" state, and
    // must not read as a clean pass.
    results.push(
      buildCheckResult({
        id: 'node-workflow-versions-meet-engines-floor',
        category: 'node-runtime',
        status: 'blocked',
        severity: 'medium',
        current: floorFromPkg !== null ? `>=${floorFromPkg}` : null,
        observed: 'zero-node-versions-extracted-from-non-empty-workflows',
        evidence: workflowFiles.slice(0, 5),
        recommendedAction: 'No Node version could be parsed from any workflow file -- this checker\'s own extraction logic likely needs review.',
        requiresHumanReview: true,
      }),
    );
  } else {
    const belowFloor = floorFromPkg !== null ? allVersionsUsed.filter((v) => v < floorFromPkg) : [];
    results.push(
      buildCheckResult({
        id: 'node-workflow-versions-meet-engines-floor',
        category: 'node-runtime',
        status: belowFloor.length === 0 ? 'ok' : 'changed',
        severity: belowFloor.length === 0 ? 'info' : 'high',
        current: floorFromPkg !== null ? `>=${floorFromPkg}` : null,
        observed: allVersionsUsed.join(','),
        evidence: perWorkflow.map((w) => `${w.file}: ${w.versions.join(',') || 'none-found'}`),
        recommendedAction: belowFloor.length === 0 ? 'none' : `Workflow(s) use a Node version below the declared engines floor: ${belowFloor.join(',')}.`,
        requiresHumanReview: belowFloor.length > 0,
      }),
    );
  }

  const singleVersionWorkflows = perWorkflow.filter((w) => w.file !== '.github/workflows/test.yml' && w.versions.length === 1);
  const singleVersions = [...new Set(singleVersionWorkflows.map((w) => w.versions[0]))];
  const singlesAgree = singleVersions.length <= 1;
  results.push(
    buildCheckResult({
      id: 'node-non-matrix-workflows-agree',
      category: 'node-runtime',
      status: singlesAgree ? 'ok' : 'changed',
      severity: singlesAgree ? 'info' : 'low',
      current: singleVersions[0] !== undefined ? String(singleVersions[0]) : null,
      observed: singleVersionWorkflows.map((w) => `${w.file}=${w.versions[0]}`).join(', '),
      evidence: singleVersionWorkflows.map((w) => w.file),
      recommendedAction: singlesAgree ? 'none' : 'Reconcile the single Node version used by non-matrix workflows.',
      requiresHumanReview: !singlesAgree,
    }),
  );

  return results;
}
