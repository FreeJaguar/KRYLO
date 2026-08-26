// Category E: package dependencies (task Section 5.E).
// KRYLO prefers minimal dependencies (CLAUDE.md); at the time this checker
// was written, package.json declares zero runtime/dev dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildCheckResult } from '../../lib/maintenance-schema.mjs';
import { platformSpawnTarget } from '../../lib/spawn-platform.mjs';

/**
 * Resolve an argv/command pair that runs `npm <args>` without ever going
 * through a `.cmd` shim. On Windows, `npm.cmd` is Node's own installer
 * bootstrap script (not an npm `cmd-shim`-generated file), which resolves
 * its real target through a SET-variable chain and a dynamic `FOR /F`
 * subprocess call -- genuinely different from, and not statically
 * parseable by, spawn-platform.mjs's `resolveWindowsShimTarget()` (which
 * correctly, safely fails closed on it rather than guessing). Node itself
 * always ships `npm-cli.js` colocated with the running `node.exe`
 * (`process.execPath`), so invoking that directly with `process.execPath`
 * sidesteps the shim question entirely -- the same "resolve and invoke the
 * REAL target directly" philosophy spawn-platform.mjs already uses,
 * specialized for npm's own actual bootstrap shape. Falls back to
 * `platformSpawnTarget('npm', ...)` (works on POSIX, and covers a Windows
 * environment where npm was installed by some other, cmd-shim-based means)
 * if the colocated npm-cli.js is not found.
 */
function resolveNpmInvocation(args) {
  const colocatedNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(colocatedNpmCli)) {
    return { command: process.execPath, args: [colocatedNpmCli, ...args] };
  }
  return platformSpawnTarget('npm', args);
}

function readJson(repoRoot, relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function countDeps(pkgJson) {
  if (!pkgJson) return null;
  const deps = pkgJson.dependencies && typeof pkgJson.dependencies === 'object' ? Object.keys(pkgJson.dependencies).length : 0;
  const devDeps = pkgJson.devDependencies && typeof pkgJson.devDependencies === 'object' ? Object.keys(pkgJson.devDependencies).length : 0;
  return { deps, devDeps, total: deps + devDeps };
}

export async function runDependenciesChecks({ repoRoot, offline }) {
  const results = [];

  const pkgJson = readJson(repoRoot, 'package.json');
  const lockJson = readJson(repoRoot, 'package-lock.json');
  const counts = countDeps(pkgJson);

  results.push(
    buildCheckResult({
      id: 'dependency-inventory',
      category: 'dependencies',
      status: counts === null ? 'blocked' : counts.total === 0 ? 'ok' : 'changed',
      severity: counts === null ? 'medium' : counts.total === 0 ? 'info' : 'medium',
      current: '0',
      observed: counts !== null ? String(counts.total) : null,
      evidence: ['package.json'],
      recommendedAction: counts === null || counts.total === 0 ? 'none' : `KRYLO's dependency count changed from 0 to ${counts.total} -- review the addition against KRYLO's minimal-dependency principle.`,
      requiresHumanReview: counts !== null && counts.total > 0,
    }),
  );

  const nameMatch = pkgJson?.name === lockJson?.name;
  const versionMatch = pkgJson?.version === lockJson?.version;
  const lockConsistent = Boolean(pkgJson && lockJson && nameMatch && versionMatch);
  results.push(
    buildCheckResult({
      id: 'lockfile-consistency',
      category: 'dependencies',
      status: !pkgJson || !lockJson ? 'blocked' : lockConsistent ? 'ok' : 'changed',
      severity: !pkgJson || !lockJson ? 'medium' : lockConsistent ? 'info' : 'high',
      current: pkgJson ? `${pkgJson.name}@${pkgJson.version}` : null,
      observed: lockJson ? `${lockJson.name}@${lockJson.version}` : 'missing',
      evidence: ['package.json', 'package-lock.json'],
      recommendedAction: lockConsistent ? 'none' : 'package-lock.json name/version no longer matches package.json -- run `npm install`.',
      requiresHumanReview: !lockConsistent,
    }),
  );

  const scripts = pkgJson?.scripts && typeof pkgJson.scripts === 'object' ? pkgJson.scripts : {};
  const lifecycleScripts = Object.keys(scripts).filter((k) => k === 'postinstall' || k === 'preinstall' || k === 'install');
  results.push(
    buildCheckResult({
      id: 'no-lifecycle-scripts',
      category: 'dependencies',
      status: lifecycleScripts.length === 0 ? 'ok' : 'changed',
      severity: lifecycleScripts.length === 0 ? 'info' : 'critical',
      current: 'none',
      observed: lifecycleScripts.join(',') || 'none',
      evidence: ['package.json'],
      recommendedAction: lifecycleScripts.length === 0 ? 'none' : 'package.json declares a postinstall/preinstall/install lifecycle script -- KRYLO policy prohibits these; review immediately.',
      requiresHumanReview: lifecycleScripts.length > 0,
    }),
  );

  if (offline) {
    results.push(
      buildCheckResult({
        id: 'npm-audit',
        category: 'dependencies',
        status: 'unavailable',
        severity: 'info',
        current: null,
        observed: null,
        evidence: [],
        recommendedAction: 'Run in live mode to execute `npm audit`.',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  let auditResult;
  try {
    const target = resolveNpmInvocation(['audit', '--json']);
    if (!target) {
      auditResult = { ok: false };
    } else {
      const res = spawnSync(target.command, target.args, {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (res.error || typeof res.stdout !== 'string' || res.stdout.trim() === '') {
        auditResult = { ok: false };
      } else {
        auditResult = { ok: true, json: JSON.parse(res.stdout) };
      }
    }
  } catch {
    auditResult = { ok: false };
  }

  if (!auditResult.ok) {
    results.push(
      buildCheckResult({
        id: 'npm-audit',
        category: 'dependencies',
        status: 'unavailable',
        severity: 'info',
        current: null,
        observed: null,
        evidence: [],
        recommendedAction: '`npm audit` could not be run (no network access, or `npm` unavailable).',
        requiresHumanReview: false,
      }),
    );
    return results;
  }

  const vulnCounts = auditResult.json?.metadata?.vulnerabilities || {};
  const highOrCritical = (vulnCounts.high || 0) + (vulnCounts.critical || 0);
  results.push(
    buildCheckResult({
      id: 'npm-audit',
      category: 'dependencies',
      status: highOrCritical > 0 ? 'changed' : 'ok',
      severity: highOrCritical > 0 ? 'high' : 'info',
      current: '0 high/critical',
      observed: `low=${vulnCounts.low || 0} moderate=${vulnCounts.moderate || 0} high=${vulnCounts.high || 0} critical=${vulnCounts.critical || 0}`,
      evidence: ['npm audit --json'],
      recommendedAction: highOrCritical > 0 ? 'Review `npm audit` output and remediate before release.' : 'none',
      requiresHumanReview: highOrCritical > 0,
    }),
  );

  return results;
}
