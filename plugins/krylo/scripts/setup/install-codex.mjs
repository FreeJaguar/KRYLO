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
// Three independent, separately-scoped targets (run one, or several, via
// --target skill|rules|hooks|all):
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
//
// --target hooks: installs <project>/.codex/hooks.json project-scoped hook
//   enforcement (docs/adr/0032-codex-project-scoped-hook-enforcement.md) --
//   the mechanism that actually closes the "--target skill alone provides
//   no enforcement" gap noted above, required because the Codex IDE
//   extension does not support plugins at all. See planHooksInstall() below.

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

/**
 * Rename, retrying the transient Windows failures that a rename of a
 * just-created directory tree genuinely hits.
 *
 * Reproduced directly, not theorized: running `--target skill --apply`
 * against fresh temp homes in a loop failed roughly one time in six with
 * `EPERM: operation not permitted, rename '...krylo-run.new-<pid>-<ts>' ->
 * '...krylo-run'`. Nothing is wrong with the staged tree -- Windows simply
 * refuses the rename while another process (antivirus, the Search indexer)
 * still holds a handle on the hundreds of files the recursive copy just
 * created. The failure was safe (the existing install was never lost, and
 * the error said so), but a routine setup command failing intermittently is
 * still a defect, and it was the source of the install tests' flakiness.
 *
 * Bounded and synchronous on purpose: a handful of short sleeps, then give
 * up and let the caller's existing failure path report it exactly as before.
 * Only the known-transient codes are retried; a genuine EXDEV or ENOENT
 * fails immediately rather than being retried into a slower identical error.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

export function renameWithRetry(from, to, { attempts = 8, delayMs = 60, rename = fs.renameSync } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(err.code)) throw err;
      // Synchronous sleep: this is a one-shot CLI, there is no event loop to
      // keep responsive, and Atomics.wait is the only portable blocking wait.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt);
    }
  }
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
    enforcementNote: 'Installing the Skill makes $krylo-run discoverable/invocable (CLI and IDE) and bundles a real, functional runtime, but provides NO hook enforcement on its own -- the Codex IDE extension does not support plugins. Full enforcement in VS Code additionally requires trusted project-scoped hooks: run install-codex.mjs --target hooks --apply in the target project (see the Codex capability matrix). Until project hooks are installed and trusted, a standalone-Skill-only session should be treated as read-only/diagnostic, not a fully enforced autonomous run.',
    rollback: backupPath
      ? `restore ${backupPath} over ${skillDestDir}, or remove ${skillDestDir} entirely`
      : `remove ${skillDestDir} entirely`,
    actions: [
      `stage ${skillSrcDir} (plus this repository's own ${RUNTIME_DIRS.join('/')} runtime) -> ${skillDestDir}.new-<pid>-<ts> and verify it`,
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
    for (const d of RUNTIME_DIRS) {
      copyDirRecursive(path.join(pluginRoot(), d), path.join(tempDir, d));
    }
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
      if (backupPath) renameWithRetry(skillDestDir, backupPath);
      renameWithRetry(tempDir, skillDestDir);
    } catch (err) {
      let restored = false;
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(skillDestDir)) {
        try {
          renameWithRetry(backupPath, skillDestDir);
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
    renameWithRetry(tempFile, rulesFile);
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
// docs/adr/0033-codex-lifecycle-enforcement.md adds Stop/SessionStart/
// SessionEnd to the original ADR-0032 set. classifyEventOwnership()/
// planHooksInstall()/removeHooks() below are already generic over this
// array -- no further per-event special-casing was needed to extend them.
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd'];
const LAUNCHER_REL_PATH = path.join('.codex', 'krylo', 'codex-project-hook-launcher.mjs');
const EVENT_LAUNCHER_ARG = {
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use',
  Stop: 'stop',
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
};
// SessionEnd's real platform timeout budget is confirmed ~1-3 seconds
// (docs/adr/0033, direct source inspection of SESSION_END_MAX_TIMEOUT_SEC);
// Stop uses the same generous budget the Claude Stop hook already does
// (skills/run/SKILL.md); every other event keeps the original 15s default.
const EVENT_TIMEOUT_SEC = { PreToolUse: 30, Stop: 60, SessionEnd: 3 };

function launcherCommandsFor(event) {
  const arg = EVENT_LAUNCHER_ARG[event];
  return {
    command: `node ${LAUNCHER_REL_PATH.split(path.sep).join('/')} ${arg}`,
    commandWindows: `node ${LAUNCHER_REL_PATH.split(path.sep).join('\\')} ${arg}`,
  };
}

function krylOwnedEntryFor(event) {
  const { command, commandWindows } = launcherCommandsFor(event);
  const hookDef = { type: 'command', command, commandWindows, timeout: EVENT_TIMEOUT_SEC[event] ?? 15 };
  return event === 'PreToolUse'
    ? { matcher: 'Bash|shell|exec_command|apply_patch|mcp__.*', hooks: [hookDef] }
    : { hooks: [hookDef] };
}

// Codex's hooks config -- the plugin-bundled one AND this project-scoped
// one -- nests its event map under a top-level `hooks` key. A live smoke
// test against a real authenticated codex-cli 0.154.0 session
// (docs/adr/0035-codex-live-hook-verification.md) observed the flat
// event-map shape this installer used to write being rejected outright:
//   "warning: failed to parse hooks config ...\.codex\hooks.json: unknown
//    field `UserPromptSubmit`, expected `description` or `hooks`"
// -- and a rejected config is dropped IN FULL, silently, so every KRYLO
// project-scoped hook (the PreToolUse risk gate included) simply never ran.
//
// An independent Security Reviewer found, and reproduced, that the first
// version of these helpers drew exactly the wrong conclusion from that
// evidence: it "preserved every other top-level key" the document carried.
// But the observed rejection is on ANY unrecognized top-level key, not only
// on a flat event map -- so preserving one means writing a document Codex
// still discards in full, while reporting `ok: true`. That reintroduced the
// very fail-open this checkpoint exists to close, through the write path.
// The accepted top-level key set is therefore treated as a hard allowlist,
// in both directions: a document that violates it is refused up front
// (never silently rewritten -- KRYLO does not restructure a file it does
// not own), and a document KRYLO writes can only ever contain these keys.
const ACCEPTED_HOOKS_TOP_LEVEL_KEYS = new Set(['description', 'hooks']);

function eventMapOf(doc) {
  return doc?.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : {};
}

/**
 * Why a pre-existing hooks.json cannot be used as-is, or null when it can.
 * Ordered most-specific first so the message names the real problem.
 */
function unusableHooksDocReason(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'its top level is not a JSON object';
  const foreignKeys = Object.keys(doc).filter((key) => !ACCEPTED_HOOKS_TOP_LEVEL_KEYS.has(key));
  if (foreignKeys.length > 0) {
    return `it declares top-level key(s) [${foreignKeys.join(', ')}]; current Codex builds accept only "description" and "hooks" there (hook events nest UNDER "hooks"), and reject the whole file otherwise`;
  }
  if ('hooks' in doc && (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks))) {
    return 'its "hooks" value is not a JSON object';
  }
  for (const [event, entries] of Object.entries(eventMapOf(doc))) {
    if (!Array.isArray(entries)) return `its "hooks.${event}" value is not an array`;
  }
  return null;
}

function withEventMap(doc, events) {
  // Only ever emits keys from the accepted allowlist: a `description` the
  // document already carried is kept, everything else is impossible by
  // construction because a document carrying anything else was refused
  // before reaching here.
  const next = {};
  if (typeof doc?.description === 'string') next.description = doc.description;
  if (Object.keys(events).length > 0) next.hooks = events;
  return next;
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

// A live entry whose command references this file's own launcher, for this
// exact event, is an unambiguous KRYLO fingerprint -- nothing else would
// ever write that specific project-relative command string. Used below to
// recover from a lost/corrupted sidecar (adopt instead of duplicate) and
// is safe: it can only ever narrow a would-be "absent" append into a
// "krylo-owned" replace, never override a genuine "ambiguous" refusal.
function findSelfReferencingEntry(liveArray, event) {
  const arg = EVENT_LAUNCHER_ARG[event];
  const marker = LAUNCHER_REL_PATH.split(path.sep).join('/');
  return liveArray.findIndex((entry) => {
    const cmd = entry?.hooks?.[0]?.command;
    return typeof cmd === 'string' && cmd.includes(marker) && cmd.trim().endsWith(arg);
  });
}

function classifyEventOwnership({ liveHooksJson, sidecar, event }) {
  const sidecarEntry = sidecar?.ownedEntries?.[event];
  const liveArray = Array.isArray(liveHooksJson?.[event]) ? liveHooksJson[event] : [];

  if (sidecarEntry) {
    const foundIndex = liveArray.findIndex((entry) => sameJson(entry, sidecarEntry));
    if (foundIndex !== -1) return { state: 'krylo-owned', index: foundIndex };
    if (liveArray.length === 0) return { state: 'absent' }; // hooks.json itself was deleted/recreated -- nothing left to conflict with, safe to reinstall
    return { state: 'ambiguous' }; // something is there, but it isn't what the sidecar recorded -- refuse rather than guess
  }

  // No sidecar record at all for this event (fresh install, or the sidecar
  // itself was lost/corrupted). Recover by adopting an already-present
  // self-referencing entry instead of blindly appending a duplicate.
  const selfIndex = findSelfReferencingEntry(liveArray, event);
  if (selfIndex !== -1) return { state: 'krylo-owned', index: selfIndex };
  return { state: 'absent' };
}

function classifyLauncherOwnership(launcherFile) {
  if (!fs.existsSync(launcherFile)) return 'absent';
  const content = fs.readFileSync(launcherFile, 'utf8');
  return /krylo-hook-launcher-version:/.test(content) ? 'krylo-owned' : 'foreign';
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

  const launcherOwnership = classifyLauncherOwnership(launcherDestFile);
  if (launcherOwnership === 'foreign') {
    return {
      ok: false,
      target: 'hooks',
      error: 'foreign-launcher-file',
      message: `A file already exists at ${launcherDestFile} and is not owned by KRYLO. It will NOT be overwritten. Remove or rename it manually first.`,
    };
  }

  const liveRead = readJsonFileSafe(hooksFile);
  if (!liveRead.ok) {
    return { ok: false, target: 'hooks', error: 'malformed-hooks-json', message: `${hooksFile} exists but is not valid JSON. Fix or remove it manually before running setup.` };
  }
  const liveDoc = liveRead.value ?? {};
  const unusableReason = unusableHooksDocReason(liveDoc);
  if (unusableReason) {
    return {
      ok: false,
      target: 'hooks',
      error: 'unusable-hooks-json',
      message: `${hooksFile} cannot be extended safely: ${unusableReason}. A file current Codex builds reject is dropped IN FULL -- every hook in it, KRYLO's and the project's own alike, silently stops running -- so writing KRYLO's entries into it would report success while changing nothing. KRYLO will not restructure a file it does not own: fix the shape yourself (or remove the file), then re-run setup.`,
    };
  }
  const liveHooksJson = eventMapOf(liveDoc);

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

  const nextEvents = { ...liveHooksJson };
  const newOwnedEntries = {};
  for (const event of HOOK_EVENTS) {
    const entry = krylOwnedEntryFor(event);
    newOwnedEntries[event] = entry;
    const currentArray = Array.isArray(nextEvents[event]) ? [...nextEvents[event]] : [];
    if (perEvent[event].state === 'krylo-owned') {
      currentArray[perEvent[event].index] = entry;
    } else {
      currentArray.push(entry);
    }
    nextEvents[event] = currentArray;
  }
  const nextHooksJson = withEventMap(liveDoc, nextEvents);

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
    // Write-then-rename (same directory, same volume), the same pattern
    // planRulesInstall() above already established: a crash mid-write can
    // never leave a truncated hooks.json in place -- unlike a corrupted
    // Skill/.rules file, a truncated hooks.json fails Codex's own JSON
    // parsing and disables EVERY hook this project has registered, KRYLO's
    // own PreToolUse gate included, a fail-open outcome worth closing here.
    const hooksTemp = `${hooksFile}.new-${process.pid}-${Date.now()}`;
    fs.writeFileSync(hooksTemp, `${JSON.stringify(nextHooksJson, null, 2)}\n`, 'utf8');
    renameWithRetry(hooksTemp, hooksFile);
    const sidecarTemp = `${sidecarFile}.new-${process.pid}-${Date.now()}`;
    fs.writeFileSync(sidecarTemp, `${JSON.stringify({ version: HOOKS_VERSION, installedAt: new Date().toISOString(), ownedEntries: newOwnedEntries }, null, 2)}\n`, 'utf8');
    renameWithRetry(sidecarTemp, sidecarFile);
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
  const liveDoc = liveRead.value ?? {};
  // Removal, unlike installation, must also work on a file written by a
  // PRE-FIX version of this installer -- a flat top-level event map. An
  // independent Security Reviewer reproduced the alternative: reading only
  // the nested map there found nothing, so every event classified `absent`,
  // KRYLO's six entries were left orphaned pointing at a launcher that had
  // just been deleted, the ownership sidecar that could have cleaned them up
  // later was removed, and the command still reported success. Removing
  // KRYLO's own entries from whichever shape actually holds them is safe and
  // correct -- it takes content out, and writes the document back in the
  // same shape it was found, so it is never the structural rewrite of a
  // foreign file that the INSTALL path rightly refuses to perform.
  const isLegacyFlatDoc = !('hooks' in liveDoc)
    && HOOK_EVENTS.some((event) => Array.isArray(liveDoc[event]));
  const liveHooksJson = isLegacyFlatDoc ? liveDoc : eventMapOf(liveDoc);
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

  // The sidecar can outlive hooks.json itself (a user may delete hooks.json
  // by hand while leaving the sidecar behind) -- classifyEventOwnership()
  // already treats that as "absent" for every event (an empty liveArray),
  // so a backup is only ever meaningful, and only ever attempted, when
  // hooks.json genuinely still exists.
  const backupPath = fs.existsSync(hooksFile) ? `${hooksFile}.backup-${Date.now()}` : null;
  const nextEvents = { ...liveHooksJson };
  for (const event of HOOK_EVENTS) {
    if (perEvent[event].state !== 'krylo-owned') continue;
    const arr = [...nextEvents[event]];
    arr.splice(perEvent[event].index, 1);
    if (arr.length > 0) nextEvents[event] = arr;
    else delete nextEvents[event];
  }
  // Written back in the SHAPE IT WAS FOUND IN: a legacy flat document stays
  // flat (minus KRYLO's entries), a nested one stays nested. Removal never
  // migrates a document's structure -- that is the install path's refusal to
  // make, not a side effect of an uninstall. "Nothing remains" therefore
  // means the document is empty once KRYLO's own entries are gone.
  const nextHooksJson = isLegacyFlatDoc ? nextEvents : withEventMap(liveDoc, nextEvents);

  const plan = {
    ok: true,
    target: 'hooks',
    backup: backupPath,
    actions: [
      ...(backupPath ? [`copy ${hooksFile} -> ${backupPath}`] : []),
      Object.keys(nextHooksJson).length > 0 ? `write ${hooksFile}` : `remove ${hooksFile} (no entries remain)`,
      `remove ${sidecarFile}`,
      `remove ${launcherDestFile}`,
    ],
  };

  if (apply) {
    if (backupPath) fs.copyFileSync(hooksFile, backupPath);
    if (Object.keys(nextHooksJson).length > 0) {
      const hooksTemp = `${hooksFile}.new-${process.pid}-${Date.now()}`;
      fs.writeFileSync(hooksTemp, `${JSON.stringify(nextHooksJson, null, 2)}\n`, 'utf8');
      renameWithRetry(hooksTemp, hooksFile);
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

const KNOWN_FLAGS = new Set(['--apply', '--remove', '--target', '--project-dir', '--codex-binary']);
const VALID_TARGETS = new Set(['skill', 'rules', 'hooks', 'all']);

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
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing-target-value', message: '--target requires a value: skill, rules, hooks, or all.' }, null, 2));
    process.exit(1);
  }
  const target = targetFlag.present ? targetFlag.value : 'all';
  if (!VALID_TARGETS.has(target)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown-target', message: `--target must be one of: skill, rules, hooks, all (got ${JSON.stringify(target)}).` }, null, 2));
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

// Guarded the same way every other script in this repository guards its own
// entrypoint, so importing this module (to unit-test renameWithRetry) does
// not execute the installer as a side effect. Invoking it as a CLI --
// `node plugins/krylo/scripts/setup/install-codex.mjs ...`, including from
// the test suite's own subprocess calls -- is unchanged.
const isMainModule = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
