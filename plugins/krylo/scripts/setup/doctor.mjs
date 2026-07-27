#!/usr/bin/env node
// KRYLO doctor: read-only health, compatibility, and conflict diagnostics
// (docs/01-command-surface.md). Never installs, updates, deletes,
// authenticates, or modifies settings. The single write it performs is a
// create-and-remove probe inside KRYLO's own data directory.
//
// Usage: node doctor.mjs [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getDataRoot, ensureDir } from '../lib/paths.mjs';
import { readJson } from '../lib/atomic.mjs';
import { readActiveRunPointerForCwd, loadState } from '../lib/state.mjs';
import { redactText } from '../lib/redact.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

function homeDir() {
  return process.env.KRYLO_TEST_HOME && process.env.KRYLO_TEST_HOME.trim() !== ''
    ? process.env.KRYLO_TEST_HOME
    : os.homedir();
}

function detectCli(cmd, args = ['--version']) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 10000 });
    if (res.status === 0 && typeof res.stdout === 'string') {
      return { detected: true, version: res.stdout.trim().split('\n')[0].slice(0, 80) };
    }
    return { detected: false };
  } catch {
    return { detected: false };
  }
}

function checkComponents(problems) {
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).length
    : 0;
  const agents = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).length
    : 0;

  // Since docs/adr/0021-hook-scoping-to-run-skill.md, KRYLO's gate/telemetry
  // hooks live in the `run` skill's own frontmatter, not in hooks/hooks.json
  // (which now intentionally registers nothing plugin-wide). Checking
  // hooks.json here would always report "healthy" vacuously, even with every
  // hook script missing, so this reads the actual source of truth instead.
  let hooksHealthy = true;
  const missingHookScripts = [];
  try {
    const skillPath = path.join(PLUGIN_ROOT, 'skills', 'run', 'SKILL.md');
    const skillText = fs.readFileSync(skillPath, 'utf8');
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
    if (!frontmatterMatch) throw new Error('run skill has no frontmatter');
    const scriptRefs = frontmatterMatch[1].matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+\.mjs)/g);
    let sawAny = false;
    for (const match of scriptRefs) {
      sawAny = true;
      const scriptPath = path.join(PLUGIN_ROOT, ...match[1].split('/'));
      if (!fs.existsSync(scriptPath)) {
        hooksHealthy = false;
        missingHookScripts.push(match[1]);
      }
    }
    if (!sawAny) {
      hooksHealthy = false;
      missingHookScripts.push('run skill declares no hook scripts');
    }
  } catch {
    hooksHealthy = false;
    missingHookScripts.push('skills/run/SKILL.md unreadable');
  }
  if (!hooksHealthy) {
    problems.push({
      severity: 'critical',
      problem: `hook scripts missing or hooks.json unreadable: ${missingHookScripts.join(', ')}`,
      remediation: 'Reinstall the KRYLO plugin (claude plugin install krylo@krylo-marketplace).',
    });
  }
  return { skills, agents, hooksHealthy, missingHookScripts };
}

function checkStorage(problems) {
  const dataRoot = getDataRoot();
  const report = { dataRoot: redactText(dataRoot), writable: false, pointerValid: null, runCount: 0, telemetryFiles: 0 };
  try {
    const probeDir = ensureDir(path.join(dataRoot, '.doctor-probe'));
    const probeFile = path.join(probeDir, `probe-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.rmSync(probeFile);
    fs.rmdirSync(probeDir);
    report.writable = true;
  } catch {
    report.writable = false;
    problems.push({
      severity: 'critical',
      problem: 'KRYLO runtime storage is not writable',
      remediation: `Check permissions for ${redactText(dataRoot)} or set CLAUDE_PLUGIN_DATA to a writable directory.`,
    });
  }
  try {
    const runsDir = path.join(dataRoot, 'runs');
    report.runCount = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
    const telemetryDir = path.join(dataRoot, 'telemetry');
    report.telemetryFiles = fs.existsSync(telemetryDir) ? fs.readdirSync(telemetryDir).length : 0;
    const pointer = readActiveRunPointerForCwd();
    if (pointer.ok && pointer.value?.runId) {
      report.pointerValid = loadState(pointer.value.runId).ok;
    }
  } catch {
    // informational only
  }
  return report;
}

function checkAlias() {
  const aliasDir = path.join(homeDir(), '.claude', 'skills', 'krylo');
  const skillFile = path.join(aliasDir, 'SKILL.md');
  if (!fs.existsSync(aliasDir)) return { state: 'absent' };
  if (!fs.existsSync(skillFile)) return { state: 'foreign', detail: 'directory exists without SKILL.md' };
  const content = fs.readFileSync(skillFile, 'utf8');
  if (/krylo-alias-version:/.test(content)) {
    const version = /krylo-alias-version:\s*([\w.-]+)/.exec(content)?.[1] ?? 'unknown';
    return { state: 'krylo-owned', version };
  }
  return { state: 'foreign' };
}

function checkConflicts() {
  const skillsRoot = path.join(homeDir(), '.claude', 'skills');
  const suspects = /^(ralph|archon|ruflo|bmad)/i;
  try {
    if (!fs.existsSync(skillsRoot)) return [];
    return fs.readdirSync(skillsRoot).filter((name) => suspects.test(name));
  } catch {
    return [];
  }
}

function checkCatalog() {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'tools.json'), 'utf8'));
    const blocked = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'blocked-versions.json'), 'utf8'));
    const tiers = {};
    let pendingReview = 0;
    for (const tool of catalog.tools) {
      tiers[tool.trustTier] = (tiers[tool.trustTier] ?? 0) + 1;
      if (tool.reviewedVersion === 'pending-first-review') pendingReview += 1;
    }
    return { tools: catalog.tools.length, tiers, pendingReview, blockedEntries: blocked.blocked.length };
  } catch {
    return { error: 'catalog unreadable' };
  }
}

function userConfigReport() {
  const nonSensitive = [
    'LANGUAGE',
    'STATUS_DETAIL',
    'SECURITY_PROFILE',
    'AUTONOMY_LEVEL',
    'MAX_ORBIT_CYCLES',
    'LOCAL_TELEMETRY',
    'TELEMETRY_RETENTION_DAYS',
  ];
  const report = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE_PLUGIN_OPTION_')) continue;
    const short = key.slice('CLAUDE_PLUGIN_OPTION_'.length);
    report[short] = nonSensitive.includes(short) ? value : '(set)';
  }
  return report;
}

function main() {
  const problems = [];
  const pluginManifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));

  const report = {
    versions: {
      node: process.version,
      git: detectCli('git'),
      claude: detectCli('claude'),
      krylo: pluginManifest.ok ? pluginManifest.value.version : 'unreadable',
    },
    components: checkComponents(problems),
    storage: checkStorage(problems),
    userConfig: userConfigReport(),
    adapters: {
      git: detectCli('git'),
      gh: detectCli('gh'),
      supabase: detectCli('supabase'),
      vercel: detectCli('vercel'),
    },
    toolTrust: checkCatalog(),
    alias: checkAlias(),
    conflictingOrchestrators: checkConflicts(),
    problems,
  };

  const critical = problems.some((p) => p.severity === 'critical');

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ok: !critical, ...report }, null, 2));
  } else {
    const lines = [];
    lines.push(`KRYLO doctor ${report.versions.krylo} | node ${report.versions.node} | git ${report.versions.git.detected ? report.versions.git.version : 'not detected'} | claude ${report.versions.claude.detected ? report.versions.claude.version : 'not detected'}`);
    lines.push(`components: ${report.components.skills} skills, ${report.components.agents} agents, hooks ${report.components.hooksHealthy ? 'healthy' : 'BROKEN'}`);
    lines.push(`storage: ${report.storage.dataRoot} (${report.storage.writable ? 'writable' : 'NOT WRITABLE'}), ${report.storage.runCount} runs, pointer ${report.storage.pointerValid === null ? 'none' : report.storage.pointerValid ? 'valid' : 'INVALID'}`);
    lines.push(`alias: ${report.alias.state}${report.alias.version ? ` (v${report.alias.version})` : ''}`);
    lines.push(`adapters: ${Object.entries(report.adapters).map(([k, v]) => `${k}=${v.detected ? 'yes' : 'no'}`).join(' ')}`);
    lines.push(`tool trust: ${report.toolTrust.tools ?? '?'} records, ${report.toolTrust.pendingReview ?? '?'} pending review, ${report.toolTrust.blockedEntries ?? '?'} blocked`);
    if (report.conflictingOrchestrators.length > 0) {
      lines.push(`conflicting orchestrators detected (report-only): ${report.conflictingOrchestrators.join(', ')}`);
    }
    for (const p of problems) lines.push(`[${p.severity}] ${p.problem} -> ${p.remediation}`);
    if (problems.length === 0) lines.push('no problems detected');
    process.stdout.write(lines.join('\n'));
  }

  process.exit(critical ? 1 : 0);
}

main();
