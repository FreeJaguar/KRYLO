#!/usr/bin/env node
// Initialize a new KRYLO run: create schema-valid state, persist it, and
// point current-run.json at it. Never uses shell interpolation for git
// detection; failures there are fail-soft (fields simply omitted).

import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { getDataRoot } from '../lib/paths.mjs';
import { createInitialState, saveState, writeActiveRunPointer } from '../lib/state.mjs';
import { redactText } from '../lib/redact.mjs';
import { bootstrapClaudeRuntimeEnvironment } from '../host/claude/context.mjs';

const RISK_BUDGETS = { low: 3, medium: 5, high: 7 };
const HARD_MAX_BUDGET = 10;

function parseArgs(argv) {
  const args = { projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--goal': args.goal = argv[++i]; break;
      case '--session': args.session = argv[++i]; break;
      case '--project-dir': args.projectDir = argv[++i]; break;
      case '--lane': args.lane = argv[++i]; break;
      case '--risk': args.risk = argv[++i]; break;
      case '--complexity': args.complexity = argv[++i]; break;
      default: break;
    }
  }
  return args;
}

function computeBudget(risk) {
  let budget = RISK_BUDGETS[risk] ?? RISK_BUDGETS.medium;
  const cap = process.env.KRYLO_MAX_ORBIT_CYCLES;
  if (cap !== undefined) {
    const n = Number(cap);
    if (Number.isInteger(n) && n >= 1 && n <= 10) {
      budget = Math.min(budget, n);
    }
  }
  return Math.min(budget, HARD_MAX_BUDGET);
}

function detectGit(projectDir) {
  const git = {};
  try {
    const branchRes = spawnSync('git', ['-C', projectDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (branchRes.status === 0 && branchRes.stdout) git.branch = branchRes.stdout.trim();

    const headRes = spawnSync('git', ['-C', projectDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    if (headRes.status === 0 && headRes.stdout) git.headShaShort = headRes.stdout.trim().slice(0, 16);

    const statusRes = spawnSync('git', ['-C', projectDir, 'status', '--porcelain'], { encoding: 'utf8' });
    if (statusRes.status === 0) git.dirtyAtStart = statusRes.stdout.trim().length > 0;
  } catch {
    // git absent or failed: omit fields, fail-soft.
  }
  return git;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.goal || !args.session) {
    console.log(JSON.stringify({ ok: false, error: 'missing required --goal or --session' }));
    process.exit(1);
    return;
  }

  const lane = args.lane || 'BUILD';
  const risk = args.risk || 'medium';
  const complexity = args.complexity;
  const projectDir = path.resolve(args.projectDir);

  // Normalizes CLAUDE_SESSION_ID / CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_OPTION_*
  // into the host-neutral identity and KRYLO_* runtime env vars before any
  // budget/state/pointer logic reads them.
  const hostIdentity = bootstrapClaudeRuntimeEnvironment({
    explicitSessionId: args.session,
    projectRoot: projectDir,
  });

  const budget = computeBudget(risk);
  const git = detectGit(projectDir);
  const runId = `run-${crypto.randomBytes(6).toString('hex')}`;

  const state = createInitialState({
    goalText: args.goal,
    hostIdentity,
    projectDir,
    lane,
    risk,
    complexity,
    budget,
    kryloVersion: process.env.KRYLO_VERSION || 'unknown',
    runId,
    git,
  });

  const saveResult = saveState(state);
  if (!saveResult.ok) {
    console.log(JSON.stringify({ ok: false, error: 'invalid-state', details: saveResult.errors }));
    process.exit(1);
    return;
  }

  writeActiveRunPointer({
    runId,
    projectRootHash: state.project.rootHash,
    host: hostIdentity.host,
    hostSessionId: hostIdentity.hostSessionId,
  });

  const statePath = path.join(getDataRoot(), 'runs', runId, 'state.json');
  console.log(JSON.stringify({
    ok: true,
    runId,
    lane,
    risk,
    budget,
    statePath: redactText(statePath),
  }));
  process.exit(0);
}

main();
