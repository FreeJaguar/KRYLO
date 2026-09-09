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
import { bootstrapStorageEnvironment, detectHost } from '../lib/host-dispatch.mjs';
import { resolveClaudeDataRoot } from '../host/claude/context.mjs';
import { resolveCodexDataRoot } from '../host/codex/context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

function homeDir() {
  return process.env.KRYLO_TEST_HOME && process.env.KRYLO_TEST_HOME.trim() !== ''
    ? process.env.KRYLO_TEST_HOME
    : os.homedir();
}

function detectCli(cmd, args = ['--version']) {
  try {
    // shell:false so a malicious/odd executable name is never shell-interpreted;
    // timeout and maxBuffer bound a hanging process or oversized/malicious
    // stdout; only the first line, truncated, is ever kept.
    const res = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 64 * 1024 });
    if (res.status === 0 && typeof res.stdout === 'string') {
      return { detected: true, version: res.stdout.trim().split('\n')[0].slice(0, 80) };
    }
    return { detected: false };
  } catch {
    return { detected: false };
  }
}

/**
 * Read-only: does the current user's Claude Code settings.json list the
 * mattpocock/skills plugin as enabled? Never installs, enables, or invokes
 * anything; a missing/unreadable/malformed settings file is simply "not
 * detected" (fail-soft, matches the rest of doctor's read-only contract).
 */
function detectMattpocockSkillsPlugin() {
  try {
    const settingsPath = path.join(homeDir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
    const hit = Object.keys(enabled).find((key) => key.toLowerCase().startsWith('mattpocock-skills@') && enabled[key] === true);
    return hit ? { detected: true, version: hit.slice(0, 80) } : { detected: false };
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

// A previous version of this function always bootstrapped and probed the
// Claude data root, regardless of which host doctor was actually invoked
// under -- a Codex-side run would be silently misreported as "no active
// run" because doctor was reading the wrong directory entirely. `host` is
// now the ACTUAL detected host for this invocation (host-dispatch.mjs's own
// detectHost(), the same function every other host-neutral entrypoint
// uses), and `dataRoot` must already reflect that host (getDataRoot() does,
// once bootstrapStorageEnvironment() has run in main()).
/**
 * Codex-side equivalent of checkComponents()'s hook-health check. Codex's
 * hook wiring has no Skill-scoped lifecycle (docs/adr/0029) -- it is
 * referenced directly from .codex-plugin/plugin.json's own "hooks" field,
 * pointing at hooks/codex-hooks.json. This checks the SAME package-integrity
 * question checkComponents() already checks for the Claude side (are the
 * hook scripts this manifest references actually present in this install?)
 * regardless of which host doctor happens to be invoked under -- both are
 * part of the one shipped plugin tree.
 */
function checkCodexComponents(problems) {
  let hooksHealthy = true;
  const missingHookScripts = [];
  try {
    const manifest = readJson(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'));
    if (!manifest.ok) throw new Error('plugin.json unreadable');
    const hooksField = manifest.value.hooks;
    if (typeof hooksField !== 'string' || hooksField.trim() === '') throw new Error('plugin.json has no hooks field');
    const hooksPath = path.join(PLUGIN_ROOT, ...hooksField.replace(/^\.\//, '').split('/'));
    const hooksManifest = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    let sawAny = false;
    for (const [key, matchers] of Object.entries(hooksManifest)) {
      if (key.startsWith('$') || !Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        for (const hook of matcher?.hooks ?? []) {
          const match = /\$\{PLUGIN_ROOT\}\/([^"'\s]+\.mjs)/.exec(hook?.command ?? '');
          if (!match) continue;
          sawAny = true;
          const scriptPath = path.join(PLUGIN_ROOT, ...match[1].split('/'));
          if (!fs.existsSync(scriptPath)) {
            hooksHealthy = false;
            missingHookScripts.push(match[1]);
          }
        }
      }
    }
    if (!sawAny) {
      hooksHealthy = false;
      missingHookScripts.push('codex-hooks.json declares no hook scripts');
    }
  } catch (err) {
    hooksHealthy = false;
    // redactText masks the home directory (and other sensitive fragments)
    // a raw fs error message embeds -- doctor output is exactly what users
    // paste into bug reports; every other path in this file already goes
    // through redactText for the same reason.
    missingHookScripts.push(`Codex hooks manifest unreadable: ${redactText(err.message)}`);
  }
  if (!hooksHealthy) {
    problems.push({
      severity: 'critical',
      problem: `Codex hook scripts missing or codex-hooks.json unreadable: ${missingHookScripts.join(', ')}`,
      remediation: 'Reinstall the KRYLO plugin (Codex host).',
    });
  }
  return { hooksHealthy, missingHookScripts };
}

function checkStorage(problems, host, dataRoot) {
  const report = { host, dataRoot: redactText(dataRoot), writable: false, pointerValid: null, runCount: 0, telemetryFiles: 0 };
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
      problem: `KRYLO runtime storage is not writable (${host} host)`,
      remediation: `Check permissions for ${redactText(dataRoot)} or set ${host === 'codex' ? 'PLUGIN_DATA' : 'CLAUDE_PLUGIN_DATA'}/KRYLO_DATA_ROOT to a writable directory.`,
    });
  }
  try {
    const runsDir = path.join(dataRoot, 'runs');
    report.runCount = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
    const telemetryDir = path.join(dataRoot, 'telemetry');
    report.telemetryFiles = fs.existsSync(telemetryDir) ? fs.readdirSync(telemetryDir).length : 0;
    // Doctor is a sessionless storage probe: it has no session identity to
    // offer, so this falls back to the most recently updated pointer inside
    // the DETECTED host's own directory for this project only (never
    // crosses into another host's directory) -- informational only, never
    // written to.
    const pointer = readActiveRunPointerForCwd(process.cwd(), { host });
    if (pointer.ok && pointer.value?.runId) {
      report.pointerValid = loadState(pointer.value.runId).ok;
    }
  } catch {
    // informational only
  }
  return report;
}

/**
 * Read-only, no write probe: reports where the OTHER (non-active) host's
 * data root would resolve to and whether it currently exists, without
 * touching it. Deliberately does not write-probe or scan run counts for the
 * inactive host -- doctor's own contract is exactly one write probe, in the
 * correctly-detected active host's own directory (checkStorage() above);
 * probing an inactive host's real directory too would be a second,
 * undisclosed write surface.
 */
function checkOtherHostStorage(activeHost) {
  const otherHost = activeHost === 'codex' ? 'claude' : 'codex';
  const dataRoot = otherHost === 'codex' ? resolveCodexDataRoot(process.env) : resolveClaudeDataRoot(process.env);
  return { host: otherHost, dataRoot: redactText(dataRoot), exists: fs.existsSync(dataRoot) };
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

/**
 * Read-only equivalent of checkAlias() for Codex's own installed Skill
 * (scripts/setup/install-codex.mjs's `--target skill`), using the same
 * ownership marker that installer stamps (`krylo-codex-skill-version:`).
 */
function checkCodexSkill() {
  const skillDir = path.join(homeDir(), '.agents', 'skills', 'krylo-run');
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillDir)) return { state: 'absent' };
  if (!fs.existsSync(skillFile)) return { state: 'foreign', detail: 'directory exists without SKILL.md' };
  const content = fs.readFileSync(skillFile, 'utf8');
  if (/krylo-codex-skill-version:/.test(content)) {
    const version = /krylo-codex-skill-version:\s*([\w.-]+)/.exec(content)?.[1] ?? 'unknown';
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

// Still Claude-specific: only CLAUDE_PLUGIN_OPTION_* is reported here.
// Codex has no equivalent plugin-options mechanism wired yet (a disclosed,
// separate gap from the host-storage/hook-wiring/skill-install awareness
// added elsewhere in this file) -- not fixed here to stay focused.
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
  // doctor.mjs is a sessionless storage utility. `host` is the ACTUAL host
  // this invocation is running under (host-dispatch.mjs's own detectHost(),
  // the same detection every other host-neutral entrypoint uses) -- a
  // previous version of this file always bootstrapped and probed the Claude
  // data root regardless, so a Codex-side doctor run silently reported the
  // wrong directory's state. otherHostReport is computed BEFORE the
  // bootstrap call below: both resolveClaudeDataRoot()/resolveCodexDataRoot()
  // check the same shared KRYLO_DATA_ROOT override first, so computing it
  // after bootstrapStorageEnvironment() has already set that override for
  // the ACTIVE host would make the "other" host's report wrongly echo the
  // active host's own root.
  const host = detectHost();
  const otherHostReport = checkOtherHostStorage(host);
  bootstrapStorageEnvironment();

  const problems = [];
  const pluginManifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));

  const report = {
    host,
    versions: {
      node: process.version,
      git: detectCli('git'),
      claude: detectCli('claude'),
      codex: detectCli('codex'),
      krylo: pluginManifest.ok ? pluginManifest.value.version : 'unreadable',
    },
    components: checkComponents(problems),
    codexComponents: checkCodexComponents(problems),
    storage: checkStorage(problems, host, getDataRoot()),
    otherHostStorage: otherHostReport,
    userConfig: userConfigReport(),
    adapters: {
      git: detectCli('git'),
      gh: detectCli('gh'),
      supabase: detectCli('supabase'),
      vercel: detectCli('vercel'),
      omniroute: detectCli('omniroute'),
      'code-review-graph': detectCli('code-review-graph'),
      'mattpocock-skills': detectMattpocockSkillsPlugin(),
    },
    toolTrust: checkCatalog(),
    alias: checkAlias(),
    codexSkill: checkCodexSkill(),
    conflictingOrchestrators: checkConflicts(),
    problems,
  };

  const critical = problems.some((p) => p.severity === 'critical');

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ok: !critical, ...report }, null, 2));
  } else {
    const lines = [];
    lines.push(`KRYLO doctor ${report.versions.krylo} | node ${report.versions.node} | git ${report.versions.git.detected ? report.versions.git.version : 'not detected'} | claude ${report.versions.claude.detected ? report.versions.claude.version : 'not detected'} | codex ${report.versions.codex.detected ? report.versions.codex.version : 'not detected'}`);
    lines.push(`active host: ${report.host}`);
    lines.push(`components: ${report.components.skills} skills, ${report.components.agents} agents, Claude hooks ${report.components.hooksHealthy ? 'healthy' : 'BROKEN'}, Codex hooks ${report.codexComponents.hooksHealthy ? 'healthy' : 'BROKEN'}`);
    lines.push(`storage (${report.storage.host}): ${report.storage.dataRoot} (${report.storage.writable ? 'writable' : 'NOT WRITABLE'}), ${report.storage.runCount} runs, pointer ${report.storage.pointerValid === null ? 'none' : report.storage.pointerValid ? 'valid' : 'INVALID'}`);
    lines.push(`other host (${report.otherHostStorage.host}, informational): ${report.otherHostStorage.dataRoot} (${report.otherHostStorage.exists ? 'exists' : 'not present'})`);
    lines.push(`alias: ${report.alias.state}${report.alias.version ? ` (v${report.alias.version})` : ''}; codex skill: ${report.codexSkill.state}${report.codexSkill.version ? ` (v${report.codexSkill.version})` : ''}`);
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
