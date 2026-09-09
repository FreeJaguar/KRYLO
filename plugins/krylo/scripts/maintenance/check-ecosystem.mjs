#!/usr/bin/env node
// KRYLO Ecosystem Maintenance checker (task Plan 4). Read-only, detection/
// reporting only -- see docs/adr/0031-ecosystem-maintenance-drift-checker.md
// and docs/process/ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md. Never
// edits repository files, commits, pushes, or performs any remediation.
//
// Usage: node scripts/maintenance/check-ecosystem.mjs [--offline] [--json]
//
// Exit codes (task Section 23): 0 = no high/critical finding; 1 = a
// verified high/critical drift/contract-break; 2 = the checker itself
// failed to run (a bug/config problem, not a detected upstream condition).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMaintenanceReport, computeExitCode } from '../lib/maintenance-schema.mjs';
import {
  getLatestGithubRelease,
  getGithubTags,
  getGithubReleaseByTag,
  getGithubCommitForRef,
} from '../lib/upstream-client.mjs';

import { runClaudeCompatChecks } from './checks/claude-compat.mjs';
import { runCodexCompatChecks } from './checks/codex-compat.mjs';
import { runActionsPinsChecks } from './checks/actions-pins.mjs';
import { runNodeRuntimeChecks } from './checks/node-runtime.mjs';
import { runDependenciesChecks } from './checks/dependencies.mjs';
import { runInternalDriftChecks } from './checks/internal-drift.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const DEFAULT_UPSTREAM = { getLatestGithubRelease, getGithubTags, getGithubReleaseByTag, getGithubCommitForRef };

function readRepositoryVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Run every check category and build the final report. Exported so tests
 * can call it directly with an injected `upstream` fetcher (deterministic
 * fixtures, task Section 19) instead of spawning the CLI process.
 */
export async function runEcosystemMaintenance({ repoRoot = REPO_ROOT, offline = false, upstream = DEFAULT_UPSTREAM } = {}) {
  const args = { repoRoot, offline, upstream };
  const results = await Promise.all([
    runClaudeCompatChecks(args),
    runCodexCompatChecks(args),
    runActionsPinsChecks(args),
    runNodeRuntimeChecks(args),
    runDependenciesChecks(args),
    runInternalDriftChecks(args),
  ]);
  const checks = results.flat();
  const repositoryVersion = readRepositoryVersion(repoRoot);
  return buildMaintenanceReport({ repositoryVersion, mode: offline ? 'offline' : 'live', checks });
}

const STATUS_LABEL = { ok: 'OK', changed: 'ATTENTION', warning: 'ATTENTION', blocked: 'BLOCKED', unavailable: 'UNAVAILABLE' };

function formatHumanReadable(report) {
  const lines = ['KRYLO Ecosystem Maintenance', ''];
  for (const check of report.checks) {
    const label = (STATUS_LABEL[check.status] || check.status.toUpperCase()).padEnd(11);
    lines.push(`${label} ${check.id}`);
  }
  lines.push('', `Result: ${report.status === 'ok' ? 'OK' : report.status.toUpperCase()}`);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const jsonOutput = argv.includes('--json');

  let report;
  try {
    report = await runEcosystemMaintenance({ offline });
  } catch (err) {
    process.stderr.write(`Ecosystem Maintenance checker failed: ${String(err?.message || err)}\n`);
    process.exit(2);
    return;
  }

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${formatHumanReadable(report)}\n`);
  }
  process.exit(computeExitCode(report));
}

const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
