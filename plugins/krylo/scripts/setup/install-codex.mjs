#!/usr/bin/env node
// Codex host setup (docs/adr/0029-codex-host-packaging-and-approval-boundary.md,
// docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md Tasks 6 and 9).
//
// DEFAULT IS DRY RUN: prints the exact plan and changes nothing. --apply
// performs the installation. Mirrors scripts/setup/install-alias.mjs's own
// established ownership/backup/rollback contract exactly: a foreign file is
// never overwritten in any mode, and a KRYLO-owned older version is backed
// up before being replaced.
//
// Two independent, separately-scoped targets (run one, or both, via
// --target skill|rules|all):
//
// --target skill: installs the krylo-run Skill (this repository's own
//   plugins/krylo/codex/skills/krylo-run/, verbatim -- never a second copy of
//   Core policy source) to the documented Codex user Skill location
//   ($HOME/.agents/skills/krylo-run/), for the VS Code / standalone bridge
//   (design doc Section 10.2). This alone gives explicit-invocation
//   discoverability; it does NOT by itself provide hook enforcement, since
//   the IDE extension does not support plugins -- see --target rules and
//   this script's own dry-run "enforcement" note.
//
// --target rules: generates a KRYLO-owned project-scoped Starlark .rules
//   file (<project>/.codex/rules/krylo.rules) covering the small,
//   deterministic shell-command set the Codex Host Implementation Plan
//   documents (git push, git push --force, npm publish, and the other
//   release/publish/deploy command families production-policy.json already
//   recognizes). This is explicitly INDEPENDENT of KRYLO's own PreToolUse
//   approval boundary (ADR-0029): it lets Codex's own native prompt fire
//   for an ordinary (non-KRYLO) session in this project, at the operator's
//   discretion -- KRYLO's gate denies require-approval actions regardless
//   of whether this file is installed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RULES_VERSION = '0.2.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function homeDir() {
  return process.env.KRYLO_TEST_HOME && process.env.KRYLO_TEST_HOME.trim() !== ''
    ? process.env.KRYLO_TEST_HOME
    : os.homedir();
}

function pluginRoot() {
  // scripts/setup/install-codex.mjs -> plugins/krylo
  return path.resolve(HERE, '..', '..');
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function classifySkillOwnership(skillFile) {
  if (!fs.existsSync(skillFile)) return 'absent';
  const content = fs.readFileSync(skillFile, 'utf8');
  return /krylo-codex-skill-version:/.test(content) ? 'krylo-owned' : 'foreign';
}

function planSkillInstall(apply) {
  const skillDestDir = path.join(homeDir(), '.agents', 'skills', 'krylo-run');
  const skillDestFile = path.join(skillDestDir, 'SKILL.md');
  const skillSrcDir = path.join(pluginRoot(), 'codex', 'skills', 'krylo-run');

  const existing = classifySkillOwnership(skillDestFile);
  if (existing === 'foreign') {
    return {
      ok: false,
      target: 'skill',
      error: 'foreign-skill',
      message: `A Skill named 'krylo-run' already exists at ${skillDestDir} and is not owned by KRYLO. It will NOT be overwritten. Rename or remove it manually first.`,
    };
  }

  const backupPath = existing === 'krylo-owned' ? `${skillDestDir}.backup-${Date.now()}` : null;
  const plan = {
    ok: true,
    target: 'skill',
    destination: skillDestDir,
    existing,
    backup: backupPath,
    enforcementNote: 'Installing the Skill alone makes $krylo-run discoverable/invocable (CLI and IDE), but provides NO hook enforcement on its own -- the Codex IDE extension does not support plugins. Full enforcement in VS Code additionally requires trusted project-scoped hooks, which this checkpoint does not yet automate (see the Codex capability matrix). Until then, a standalone-Skill-only session should be treated as read-only/diagnostic, not a fully enforced autonomous run.',
    rollback: backupPath
      ? `restore ${backupPath} over ${skillDestDir}, or remove ${skillDestDir} entirely`
      : `remove ${skillDestDir} entirely`,
    actions: [
      ...(backupPath ? [`copy ${skillDestDir} -> ${backupPath}`] : []),
      `copy ${skillSrcDir} -> ${skillDestDir}`,
    ],
  };

  if (apply) {
    fs.mkdirSync(path.dirname(skillDestDir), { recursive: true });
    if (backupPath) {
      copyDirRecursive(skillDestDir, backupPath);
      fs.rmSync(skillDestDir, { recursive: true, force: true });
    }
    copyDirRecursive(skillSrcDir, skillDestDir);
    // Stamp ownership onto the copy without mutating the repository's own
    // source file.
    const stamped = `${fs.readFileSync(skillDestFile, 'utf8')}\n<!-- krylo-codex-skill-version: ${RULES_VERSION} -->\n<!-- Installed by install-codex.mjs. Remove by deleting this directory. -->\n`;
    fs.writeFileSync(skillDestFile, stamped, 'utf8');
    plan.applied = true;
  }
  return plan;
}

// The small, deterministic shell-command-prefix set this checkpoint
// provisions rules for (docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md Task 6).
const RULE_DEFINITIONS = [
  { pattern: ['git', 'push'], actionClass: 'git-push', match: 'git push origin main', notMatch: 'git status' },
  { pattern: ['git', 'push', '--force'], actionClass: 'git-force', match: 'git push --force origin main', notMatch: 'git push origin main' },
  { pattern: ['npm', 'publish'], actionClass: 'package-publish', match: 'npm publish', notMatch: 'npm install' },
  { pattern: ['gh', 'release', 'create'], actionClass: 'release', match: 'gh release create v1.0.0', notMatch: 'gh release list' },
];

function renderRulesFile() {
  const header = `# KRYLO-owned Codex execpolicy rules (generated by install-codex.mjs).\n`
    + `# Independent of KRYLO's own PreToolUse approval boundary -- see\n`
    + `# docs/adr/0029-codex-host-packaging-and-approval-boundary.md. Prompts an\n`
    + `# ordinary (non-KRYLO) Codex session in this project for the listed\n`
    + `# command shapes; does not weaken or replace KRYLO's own deny.\n`
    + `# krylo-rules-version: ${RULES_VERSION}\n\n`;
  const body = RULE_DEFINITIONS.map((r) => (
    `prefix_rule(\n`
    + `    pattern = [${r.pattern.map((p) => JSON.stringify(p)).join(', ')}],\n`
    + `    decision = "prompt",\n`
    + `    justification = "KRYLO risk class: ${r.actionClass} (production-policy.json approvalClasses.${r.actionClass})",\n`
    + `    match = [${JSON.stringify(r.match)}],\n`
    + `    not_match = [${JSON.stringify(r.notMatch)}],\n`
    + `)\n`
  )).join('\n');
  return header + body;
}

function classifyRulesOwnership(rulesFile) {
  if (!fs.existsSync(rulesFile)) return 'absent';
  const content = fs.readFileSync(rulesFile, 'utf8');
  return /krylo-rules-version:/.test(content) ? 'krylo-owned' : 'foreign';
}

function validateRulesWithCodex(rulesFile, codexBinary) {
  if (!codexBinary) return { checked: false, reason: 'no codex binary specified' };
  const results = [];
  for (const r of RULE_DEFINITIONS) {
    try {
      const out = execFileSync(codexBinary, ['execpolicy', 'check', '--rules', rulesFile, '--', ...r.match.split(' ')], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      results.push({ actionClass: r.actionClass, command: r.match, decision: parsed.decision, ok: parsed.decision === 'prompt' });
    } catch (err) {
      results.push({ actionClass: r.actionClass, command: r.match, ok: false, error: String(err.message ?? err) });
    }
  }
  return { checked: true, results, allOk: results.every((r) => r.ok) };
}

function planRulesInstall(apply, projectDir, codexBinary) {
  const rulesDir = path.join(projectDir, '.codex', 'rules');
  const rulesFile = path.join(rulesDir, 'krylo.rules');
  const existing = classifyRulesOwnership(rulesFile);

  if (existing === 'foreign') {
    return {
      ok: false,
      target: 'rules',
      error: 'foreign-rules-file',
      message: `A rules file already exists at ${rulesFile} and is not owned by KRYLO. It will NOT be overwritten. Choose a different location or remove it manually first.`,
    };
  }

  const backupPath = existing === 'krylo-owned' ? `${rulesFile}.backup-${Date.now()}` : null;
  const content = renderRulesFile();
  const plan = {
    ok: true,
    target: 'rules',
    destination: rulesFile,
    existing,
    backup: backupPath,
    trustNote: `Project-local rules under ${path.join(projectDir, '.codex')} only take effect once Codex's own project-trust layer for this directory is trusted -- this script does not and cannot bypass that trust flow.`,
    rollback: backupPath ? `restore ${backupPath} over ${rulesFile}` : `remove ${rulesFile}`,
    actions: [
      ...(backupPath ? [`copy ${rulesFile} -> ${backupPath}`] : []),
      `write ${rulesFile}`,
    ],
  };

  if (apply) {
    fs.mkdirSync(rulesDir, { recursive: true });
    if (backupPath) fs.copyFileSync(rulesFile, backupPath);
    fs.writeFileSync(rulesFile, content, 'utf8');
    plan.applied = true;
    plan.validation = validateRulesWithCodex(rulesFile, codexBinary);
  }
  return plan;
}

function removeSkill(apply) {
  const skillDestDir = path.join(homeDir(), '.agents', 'skills', 'krylo-run');
  if (!fs.existsSync(skillDestDir)) return { ok: true, target: 'skill', state: 'absent', actions: [] };
  const skillDestFile = path.join(skillDestDir, 'SKILL.md');
  const owned = classifySkillOwnership(skillDestFile) === 'krylo-owned';
  if (!owned) {
    return { ok: false, target: 'skill', error: 'foreign-skill', message: `${skillDestDir} is not owned by KRYLO (missing ownership marker). Nothing will be removed.` };
  }
  const plan = { ok: true, target: 'skill', actions: [`remove ${skillDestDir}`] };
  if (apply) {
    fs.rmSync(skillDestDir, { recursive: true, force: true });
    plan.applied = true;
  }
  return plan;
}

function removeRules(apply, projectDir) {
  const rulesFile = path.join(projectDir, '.codex', 'rules', 'krylo.rules');
  if (!fs.existsSync(rulesFile)) return { ok: true, target: 'rules', state: 'absent', actions: [] };
  const owned = classifyRulesOwnership(rulesFile) === 'krylo-owned';
  if (!owned) {
    return { ok: false, target: 'rules', error: 'foreign-rules-file', message: `${rulesFile} is not owned by KRYLO (missing ownership marker). Nothing will be removed.` };
  }
  const plan = { ok: true, target: 'rules', actions: [`remove ${rulesFile}`] };
  if (apply) {
    fs.rmSync(rulesFile, { force: true });
    plan.applied = true;
  }
  return plan;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const remove = argv.includes('--remove');
  const targetArgIdx = argv.indexOf('--target');
  const target = targetArgIdx !== -1 ? argv[targetArgIdx + 1] : 'all';
  const projectDirArgIdx = argv.indexOf('--project-dir');
  const projectDir = projectDirArgIdx !== -1 ? path.resolve(argv[projectDirArgIdx + 1]) : process.cwd();
  const codexBinaryArgIdx = argv.indexOf('--codex-binary');
  const codexBinary = codexBinaryArgIdx !== -1 ? argv[codexBinaryArgIdx + 1] : null;

  const results = {};
  if (remove) {
    if (target === 'skill' || target === 'all') results.skill = removeSkill(apply);
    if (target === 'rules' || target === 'all') results.rules = removeRules(apply, projectDir);
  } else {
    if (target === 'skill' || target === 'all') results.skill = planSkillInstall(apply);
    if (target === 'rules' || target === 'all') results.rules = planRulesInstall(apply, projectDir, codexBinary);
  }

  const overallOk = Object.values(results).every((r) => r.ok);
  process.stdout.write(JSON.stringify({
    ok: overallOk,
    mode: apply ? 'apply' : 'dry-run',
    ...(apply ? {} : { note: 'dry run only - nothing was changed; re-run with --apply' }),
    ...results,
  }, null, 2));
  process.exit(overallOk ? 0 : 1);
}

main();
