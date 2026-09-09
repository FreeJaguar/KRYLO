#!/usr/bin/env node
// Codex host setup (docs/adr/0029-codex-host-packaging-and-approval-boundary.md,
// docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md Tasks 6 and 9).
//
// DEFAULT IS DRY RUN: prints the exact plan and changes nothing. --apply
// performs the installation. Shares scripts/setup/install-alias.mjs's own
// ownership/backup contract: a foreign file is never overwritten in any
// mode, and a KRYLO-owned older version is backed up before being replaced.
// An earlier version of this apply path built the replacement copy directly
// on top of the live destination (backup, `rmSync` the live install, THEN
// copy the new content in) -- if the copy step failed partway, the user was
// left with neither a working old install nor a working new one, and only
// a prose "rollback" hint pointed at a backup they had to restore manually.
// The skill-install path (planSkillInstall) now stages the replacement in a
// sibling temp directory first, verifies it round-trips from disk before
// touching the live install at all, swaps it in with a single atomic
// rename (never a delete-then-copy), and automatically restores the prior
// install from its backup if the swap itself fails. The rules-install path
// (planRulesInstall) writes its replacement to a temp file and atomically
// renames it over the destination, so a mid-write crash can never leave a
// truncated rules file in place.
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

  // A rename's target must not already exist -- so ANY pre-existing
  // directory at the destination must be moved aside first, not only a
  // 'krylo-owned' one. An independent review found classifySkillOwnership()
  // only checks whether SKILL.md itself exists, so a directory that exists
  // but happens to have no SKILL.md (a stray/partial install, or simply a
  // foreign-named directory containing unrelated files) was classified
  // 'absent' -- skipping the move-aside entirely and making the swap-in
  // rename below fail on a non-empty target. The pre-atomic-swap code used
  // copyDirRecursive(), which merges into an existing directory rather than
  // failing; this preserves that same "never destroy what was already
  // there" property, just via a backup instead of a silent merge.
  const skillDestDirExists = fs.existsSync(skillDestDir);
  const backupPath = skillDestDirExists ? `${skillDestDir}.backup-${Date.now()}` : null;
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
      `stage ${skillSrcDir} -> ${skillDestDir}.new-<pid>-<ts> and verify it`,
      ...(backupPath ? [`move ${skillDestDir} -> ${backupPath}`] : []),
      `move ${skillDestDir}.new-<pid>-<ts> -> ${skillDestDir}`,
    ],
  };

  if (apply) {
    fs.mkdirSync(path.dirname(skillDestDir), { recursive: true });

    // Stage the full replacement in a sibling temp directory (same parent,
    // so the final swap below is a same-volume rename -- atomic on both
    // POSIX and Windows) and verify it before the live install is touched
    // at all.
    const tempDir = `${skillDestDir}.new-${process.pid}-${Date.now()}`;
    fs.rmSync(tempDir, { recursive: true, force: true });
    copyDirRecursive(skillSrcDir, tempDir);
    const tempSkillFile = path.join(tempDir, 'SKILL.md');
    // Stamp ownership onto the staged copy without mutating the
    // repository's own source file.
    const stamped = `${fs.readFileSync(tempSkillFile, 'utf8')}\n<!-- krylo-codex-skill-version: ${RULES_VERSION} -->\n<!-- Installed by install-codex.mjs. Remove by deleting this directory. -->\n`;
    fs.writeFileSync(tempSkillFile, stamped, 'utf8');

    const verified = fs.existsSync(tempSkillFile) && /krylo-codex-skill-version:/.test(fs.readFileSync(tempSkillFile, 'utf8'));
    if (!verified) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return {
        ok: false,
        target: 'skill',
        error: 'staging-verification-failed',
        message: 'The new Skill copy could not be verified before installation; the existing install (if any) was left untouched.',
      };
    }

    // Move the current install aside (if any) and swap the verified
    // replacement in. Never a delete-then-copy: at every point up to the
    // final rename, the live install directory still holds its ORIGINAL
    // content or the backup does. An independent review found the
    // move-aside rename itself was previously OUTSIDE this try/catch --
    // reproduced a raw, uncaught crash (a real Windows EBUSY, e.g. the
    // directory open in an editor or AV/indexer) that left the staged
    // tempDir orphaned on disk instead of the clean {ok:false} this
    // function promises everywhere else. Both renames, and the tempDir
    // cleanup, are now one failure-handled unit.
    try {
      if (backupPath) fs.renameSync(skillDestDir, backupPath);
      fs.renameSync(tempDir, skillDestDir);
    } catch (err) {
      let restored = false;
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(skillDestDir)) {
        try {
          fs.renameSync(backupPath, skillDestDir);
          restored = true;
        } catch {
          // Best-effort restore only; fall through to report the failure.
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      return {
        ok: false,
        target: 'skill',
        error: 'swap-failed',
        message: `Failed to install the staged Skill: ${err.message}. ${restored ? 'The previous install was automatically restored.' : (backupPath ? `Manual recovery may be required: check ${backupPath}.` : 'No prior install existed at this destination; nothing was lost.')}`,
      };
    }
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
    // Write-then-rename (same directory, same volume): a mid-write crash
    // can never leave a truncated rules file at the live path.
    const tempFile = `${rulesFile}.new-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, rulesFile);
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

const KNOWN_FLAGS = new Set(['--apply', '--remove', '--target', '--project-dir', '--codex-binary']);
const VALID_TARGETS = new Set(['skill', 'rules', 'all']);

/**
 * Reject before any mutation, not after: an unknown/missing --target value
 * previously fell through both `target === 'skill' || target === 'all'` /
 * `target === 'rules' || target === 'all'` checks silently, leaving
 * `results` empty -- `Object.values({}).every(...)` is vacuously true, so a
 * typo (e.g. `--target skils`) reported a clean success with nothing
 * installed or removed. A missing trailing value for `--target`,
 * `--project-dir`, or `--codex-binary` (the flag is the last argv element,
 * or immediately followed by another known flag) previously reached
 * `path.resolve(undefined)` and crashed with a raw TypeError instead of a
 * clear error. Both are now caught here, deterministically, before any
 * plan/apply function runs.
 */
function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return { present: false, value: undefined };
  const value = argv[idx + 1];
  // An empty string (e.g. `--project-dir=`) is treated the same as a
  // missing value -- silently resolving it to `path.resolve('')` ===
  // process.cwd() would mask exactly the kind of typo this validation
  // exists to catch.
  if (value === undefined || value === '' || KNOWN_FLAGS.has(value)) {
    return { present: true, value: undefined, missing: true };
  }
  return { present: true, value };
}

/**
 * An unrecognized `--`-prefixed flag (e.g. `--targt skill`, a typo of
 * `--target`) was previously ignored entirely, silently falling through to
 * every default -- the same "malformed input does the wrong thing
 * silently" class every other check in this function's neighborhood
 * exists to close. Only `--`-prefixed tokens are checked; flag VALUES
 * never start with `--` in this script's own usage.
 */
function findUnknownFlag(argv) {
  return argv.find((token) => token.startsWith('--') && !KNOWN_FLAGS.has(token));
}

/**
 * `--target=skill` (the equals form) previously bypassed readFlagValue()
 * entirely -- `argv.indexOf('--target')` never matches `'--target=skill'`
 * as a whole token, so `target` silently defaulted to `'all'` and BOTH the
 * skill and rules targets were installed, the same "malformed flag
 * silently does the wrong thing" class this file's own --target validation
 * exists to close, just in the more permissive direction. Normalizing
 * `--flag=value` into `--flag`, `value` up front means every downstream
 * check sees one consistent shape, exactly as if the two-argument form had
 * been used.
 */
function expandEqualsFlags(argv) {
  const expanded = [];
  for (const token of argv) {
    const eqIdx = token.startsWith('--') ? token.indexOf('=') : -1;
    if (eqIdx > 2) {
      expanded.push(token.slice(0, eqIdx), token.slice(eqIdx + 1));
    } else {
      expanded.push(token);
    }
  }
  return expanded;
}

function main() {
  const argv = expandEqualsFlags(process.argv.slice(2));

  const unknownFlag = findUnknownFlag(argv);
  if (unknownFlag) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown-flag', message: `Unrecognized flag: ${unknownFlag}.` }, null, 2));
    process.exit(1);
  }

  const apply = argv.includes('--apply');
  const remove = argv.includes('--remove');

  const targetFlag = readFlagValue(argv, '--target');
  if (targetFlag.missing) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing-target-value', message: '--target requires a value: skill, rules, or all.' }, null, 2));
    process.exit(1);
  }
  const target = targetFlag.present ? targetFlag.value : 'all';
  if (!VALID_TARGETS.has(target)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown-target', message: `--target must be one of: skill, rules, all (got ${JSON.stringify(target)}).` }, null, 2));
    process.exit(1);
  }

  const projectDirFlag = readFlagValue(argv, '--project-dir');
  if (projectDirFlag.missing) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing-project-dir-value', message: '--project-dir requires a path value.' }, null, 2));
    process.exit(1);
  }
  const projectDir = projectDirFlag.present ? path.resolve(projectDirFlag.value) : process.cwd();

  const codexBinaryFlag = readFlagValue(argv, '--codex-binary');
  if (codexBinaryFlag.missing) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing-codex-binary-value', message: '--codex-binary requires a value.' }, null, 2));
    process.exit(1);
  }
  const codexBinary = codexBinaryFlag.present ? codexBinaryFlag.value : null;

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
