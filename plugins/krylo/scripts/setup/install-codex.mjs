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

// A standalone (non-plugin) Codex session has no PLUGIN_ROOT at all, so the
// Skill alone (SKILL.md + agents/openai.yaml) is not enough for KRYLO to
// actually run there: every runtime script it would invoke has to
// physically exist somewhere a portable, deterministic path can reach.
// scripts/host/codex/context.mjs's own resolveCodexPluginRoot() already
// falls back to an import.meta.url-relative root when PLUGIN_ROOT is unset
// -- copying the real runtime verbatim to this same destination is what
// makes that existing fallback resolve correctly here, with no change to
// context.mjs itself required (docs/adr/0032-codex-project-scoped-hook-enforcement.md).
const RUNTIME_DIRS = ['scripts', 'references', 'schemas', 'policies'];

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
    enforcementNote: 'Installing the Skill makes $krylo-run discoverable/invocable (CLI and IDE) and bundles a real, functional runtime, but provides NO hook enforcement on its own -- the Codex IDE extension does not support plugins. Full enforcement in VS Code additionally requires trusted project-scoped hooks: run install-codex.mjs --target hooks --apply in the target project (see the Codex capability matrix). Until project hooks are installed and trusted, a standalone-Skill-only session should be treated as read-only/diagnostic, not a fully enforced autonomous run.',
    rollback: backupPath
      ? `restore ${backupPath} over ${skillDestDir}, or remove ${skillDestDir} entirely`
      : `remove ${skillDestDir} entirely`,
    actions: [
      ...(backupPath ? [`copy ${skillDestDir} -> ${backupPath}`] : []),
      `copy ${skillSrcDir} -> ${skillDestDir}`,
      ...RUNTIME_DIRS.map((d) => `copy ${path.join(pluginRoot(), d)} -> ${path.join(skillDestDir, d)}`),
    ],
  };

  if (apply) {
    fs.mkdirSync(path.dirname(skillDestDir), { recursive: true });
    if (backupPath) {
      copyDirRecursive(skillDestDir, backupPath);
      fs.rmSync(skillDestDir, { recursive: true, force: true });
    }
    copyDirRecursive(skillSrcDir, skillDestDir);
    for (const d of RUNTIME_DIRS) {
      copyDirRecursive(path.join(pluginRoot(), d), path.join(skillDestDir, d));
    }
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

// Project-scoped Codex hook enforcement
// (docs/adr/0032-codex-project-scoped-hook-enforcement.md,
// docs/process/MULTI_HOST_CODEX_MAINTENANCE_DESIGN.md Section 10.4).
//
// --target hooks: installs <project>/.codex/hooks.json entries for
// UserPromptSubmit/PreToolUse/PostToolUse, each pointing at a thin,
// project-local launcher (<project>/.codex/krylo/codex-project-hook-launcher.mjs)
// via a plain project-relative command path -- never a machine-specific
// absolute path, since Codex confirms PLUGIN_ROOT/PLUGIN_DATA are
// plugin-bundled-hook-only and no portable templating exists for
// project-hook command strings. The launcher itself locates the real
// runtime this repository's own --target skill install already bundles
// (scripts/references/schemas/policies copied verbatim to
// $HOME/.agents/skills/krylo-run/) at RUN TIME via a portable algorithm, so
// nothing here ever embeds a per-machine path in shareable config.
//
// hooks.json is a file Codex itself may also use for a project's OWN
// unrelated hooks, so this is a genuine semantic array-level merge, not a
// whole-file replace like the Skill/.rules installs above: KRYLO owns
// exactly one matcher-group entry per event, tracked via a KRYLO-owned
// sidecar (<project>/.codex/krylo-hooks-meta.json) recording exactly which
// entry KRYLO installed, so a later upgrade/removal can find and replace/
// remove precisely that entry and leave every other entry (KRYLO's own
// other events, or another tool's own hooks entirely) byte-for-byte
// untouched. If the sidecar's recorded entry no longer matches what is
// actually live (hand-edited or partially removed), setup refuses to touch
// that event automatically rather than guess.

const HOOKS_VERSION = '0.2.0';
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
const LAUNCHER_REL_PATH = path.join('.codex', 'krylo', 'codex-project-hook-launcher.mjs');
const EVENT_LAUNCHER_ARG = { UserPromptSubmit: 'user-prompt-submit', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use' };

function launcherCommandsFor(event) {
  const arg = EVENT_LAUNCHER_ARG[event];
  return {
    command: `node ${LAUNCHER_REL_PATH.split(path.sep).join('/')} ${arg}`,
    commandWindows: `node ${LAUNCHER_REL_PATH.split(path.sep).join('\\')} ${arg}`,
  };
}

function krylOwnedEntryFor(event) {
  const { command, commandWindows } = launcherCommandsFor(event);
  const hookDef = { type: 'command', command, commandWindows, timeout: event === 'PreToolUse' ? 30 : 15 };
  return event === 'PreToolUse'
    ? { matcher: 'Bash|shell|exec_command|apply_patch|mcp__.*', hooks: [hookDef] }
    : { hooks: [hookDef] };
}

function readJsonFileSafe(file) {
  if (!fs.existsSync(file)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

// Deliberately simple (JSON.stringify equality, not a general deep-equal
// dependency): every value compared here is either read back verbatim from
// disk or constructed by krylOwnedEntryFor()'s own single, stable code
// path, so key order is always self-consistent -- no need for order-
// independent comparison.
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifyEventOwnership({ liveHooksJson, sidecar, event }) {
  const sidecarEntry = sidecar?.ownedEntries?.[event];
  const liveArray = Array.isArray(liveHooksJson?.[event]) ? liveHooksJson[event] : [];
  if (!sidecarEntry) return { state: 'absent' };
  const foundIndex = liveArray.findIndex((entry) => sameJson(entry, sidecarEntry));
  if (foundIndex === -1) return { state: 'ambiguous' };
  return { state: 'krylo-owned', index: foundIndex };
}

function gitTrackedState(projectDir, relFile) {
  try {
    execFileSync('git', ['-C', projectDir, 'ls-files', '--error-unmatch', '--', relFile], { stdio: 'ignore' });
    return 'tracked';
  } catch {
    return 'untracked-or-not-a-git-repo';
  }
}

function planHooksInstall(apply, projectDir) {
  const codexDir = path.join(projectDir, '.codex');
  const hooksFile = path.join(codexDir, 'hooks.json');
  const sidecarFile = path.join(codexDir, 'krylo-hooks-meta.json');
  const launcherDestFile = path.join(projectDir, LAUNCHER_REL_PATH);
  const launcherSrcFile = path.join(pluginRoot(), 'codex', 'project-hooks', 'codex-project-hook-launcher.mjs');

  const liveRead = readJsonFileSafe(hooksFile);
  if (!liveRead.ok) {
    return { ok: false, target: 'hooks', error: 'malformed-hooks-json', message: `${hooksFile} exists but is not valid JSON. Fix or remove it manually before running setup.` };
  }
  const liveHooksJson = liveRead.value ?? {};
  if (typeof liveHooksJson !== 'object' || liveHooksJson === null || Array.isArray(liveHooksJson)) {
    return { ok: false, target: 'hooks', error: 'malformed-hooks-json', message: `${hooksFile} exists but its top level is not a JSON object.` };
  }

  const sidecarRead = readJsonFileSafe(sidecarFile);
  const sidecar = sidecarRead.ok ? sidecarRead.value : null;

  const perEvent = {};
  for (const event of HOOK_EVENTS) perEvent[event] = classifyEventOwnership({ liveHooksJson, sidecar, event });

  const ambiguousEvents = HOOK_EVENTS.filter((e) => perEvent[e].state === 'ambiguous');
  if (ambiguousEvents.length > 0) {
    return {
      ok: false,
      target: 'hooks',
      error: 'ambiguous-ownership',
      message: `${hooksFile} was previously set up by KRYLO for [${ambiguousEvents.join(', ')}], but the recorded entry no longer matches what is actually there (hand-edited or partially removed?). Refusing to touch ${ambiguousEvents.join(', ')} automatically -- resolve manually, then re-run setup.`,
      ambiguousEvents,
    };
  }

  const needsBackup = HOOK_EVENTS.some((e) => perEvent[e].state === 'krylo-owned');
  const backupPath = needsBackup && fs.existsSync(hooksFile) ? `${hooksFile}.backup-${Date.now()}` : null;

  const nextHooksJson = { ...liveHooksJson };
  const newOwnedEntries = {};
  for (const event of HOOK_EVENTS) {
    const entry = krylOwnedEntryFor(event);
    newOwnedEntries[event] = entry;
    const currentArray = Array.isArray(nextHooksJson[event]) ? [...nextHooksJson[event]] : [];
    if (perEvent[event].state === 'krylo-owned') {
      currentArray[perEvent[event].index] = entry;
    } else {
      currentArray.push(entry);
    }
    nextHooksJson[event] = currentArray;
  }

  const gitStatus = gitTrackedState(projectDir, path.relative(projectDir, hooksFile).split(path.sep).join('/'));

  const plan = {
    ok: true,
    target: 'hooks',
    destination: hooksFile,
    sidecar: sidecarFile,
    launcher: launcherDestFile,
    perEvent: Object.fromEntries(HOOK_EVENTS.map((e) => [e, perEvent[e].state])),
    backup: backupPath,
    gitStatus,
    trustNote: "Project-local hooks only take effect once Codex's own project-trust layer for this .codex directory is reviewed and trusted (the /hooks flow) -- this script does not and cannot bypass that.",
    rollback: backupPath
      ? `restore ${backupPath} over ${hooksFile}`
      : `remove the KRYLO entries with --target hooks --remove --apply, or delete ${hooksFile} entirely if it contains only KRYLO's own entries`,
    actions: [
      ...(backupPath ? [`copy ${hooksFile} -> ${backupPath}`] : []),
      `write ${hooksFile}`,
      `write ${sidecarFile}`,
      `copy ${launcherSrcFile} -> ${launcherDestFile}`,
    ],
  };

  if (apply) {
    fs.mkdirSync(codexDir, { recursive: true });
    if (backupPath) fs.copyFileSync(hooksFile, backupPath);
    fs.writeFileSync(hooksFile, `${JSON.stringify(nextHooksJson, null, 2)}\n`, 'utf8');
    fs.writeFileSync(sidecarFile, `${JSON.stringify({ version: HOOKS_VERSION, installedAt: new Date().toISOString(), ownedEntries: newOwnedEntries }, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(launcherDestFile), { recursive: true });
    fs.copyFileSync(launcherSrcFile, launcherDestFile);
    plan.applied = true;
  }
  return plan;
}

function removeHooks(apply, projectDir) {
  const codexDir = path.join(projectDir, '.codex');
  const hooksFile = path.join(codexDir, 'hooks.json');
  const sidecarFile = path.join(codexDir, 'krylo-hooks-meta.json');
  const launcherDestFile = path.join(projectDir, LAUNCHER_REL_PATH);

  // The sidecar (not hooks.json's own existence) is the sole source of
  // truth for "does KRYLO have anything tracked to remove here": hooks.json
  // itself legitimately survives a successful removal (unrelated content
  // remains), so requiring BOTH files absent would make a second --remove
  // call after a real one wrongly fall through to "no ownership record"
  // below instead of the correct, idempotent "already absent".
  if (!fs.existsSync(sidecarFile)) {
    return { ok: true, target: 'hooks', state: 'absent', actions: [] };
  }

  const liveRead = readJsonFileSafe(hooksFile);
  if (!liveRead.ok) {
    return { ok: false, target: 'hooks', error: 'malformed-hooks-json', message: `${hooksFile} exists but is not valid JSON; refusing to touch it automatically.` };
  }
  const liveHooksJson = liveRead.value ?? {};
  const sidecarRead = readJsonFileSafe(sidecarFile);
  const sidecar = sidecarRead.ok ? sidecarRead.value : null;
  if (!sidecar) {
    return { ok: false, target: 'hooks', error: 'no-ownership-record', message: `${sidecarFile} exists but is not valid JSON; refusing to guess which entries in ${hooksFile} are KRYLO's own.` };
  }

  const perEvent = {};
  for (const event of HOOK_EVENTS) perEvent[event] = classifyEventOwnership({ liveHooksJson, sidecar, event });
  const ambiguousEvents = HOOK_EVENTS.filter((e) => perEvent[e].state === 'ambiguous');
  if (ambiguousEvents.length > 0) {
    return { ok: false, target: 'hooks', error: 'ambiguous-ownership', message: `Recorded KRYLO entries for [${ambiguousEvents.join(', ')}] no longer match what is live in ${hooksFile}; refusing to remove automatically.`, ambiguousEvents };
  }

  const backupPath = `${hooksFile}.backup-${Date.now()}`;
  const nextHooksJson = { ...liveHooksJson };
  for (const event of HOOK_EVENTS) {
    if (perEvent[event].state !== 'krylo-owned') continue;
    const arr = [...nextHooksJson[event]];
    arr.splice(perEvent[event].index, 1);
    if (arr.length > 0) nextHooksJson[event] = arr;
    else delete nextHooksJson[event];
  }

  const plan = {
    ok: true,
    target: 'hooks',
    backup: backupPath,
    actions: [
      `copy ${hooksFile} -> ${backupPath}`,
      Object.keys(nextHooksJson).length > 0 ? `write ${hooksFile}` : `remove ${hooksFile} (no entries remain)`,
      `remove ${sidecarFile}`,
      `remove ${launcherDestFile}`,
    ],
  };

  if (apply) {
    fs.copyFileSync(hooksFile, backupPath);
    if (Object.keys(nextHooksJson).length > 0) {
      fs.writeFileSync(hooksFile, `${JSON.stringify(nextHooksJson, null, 2)}\n`, 'utf8');
    } else {
      fs.rmSync(hooksFile, { force: true });
    }
    fs.rmSync(sidecarFile, { force: true });
    fs.rmSync(launcherDestFile, { force: true });
    try { fs.rmdirSync(path.dirname(launcherDestFile)); } catch { /* not empty, or already gone -- fine, never force-remove unrelated content */ }
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
    if (target === 'hooks' || target === 'all') results.hooks = removeHooks(apply, projectDir);
  } else {
    if (target === 'skill' || target === 'all') results.skill = planSkillInstall(apply);
    if (target === 'rules' || target === 'all') results.rules = planRulesInstall(apply, projectDir, codexBinary);
    if (target === 'hooks' || target === 'all') results.hooks = planHooksInstall(apply, projectDir);
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
