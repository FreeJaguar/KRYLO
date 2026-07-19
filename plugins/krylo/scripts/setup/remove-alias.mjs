#!/usr/bin/env node
// Remove the optional personal /krylo wrapper skill. Removes ONLY files owned
// by KRYLO (ownership marker required). DEFAULT IS DRY RUN; --apply executes.
// --restore-backup restores the newest backup instead of deleting.
// --keep-backups retains backup files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function homeDir() {
  return process.env.KRYLO_TEST_HOME && process.env.KRYLO_TEST_HOME.trim() !== ''
    ? process.env.KRYLO_TEST_HOME
    : os.homedir();
}

function main() {
  const apply = process.argv.includes('--apply');
  const restoreBackup = process.argv.includes('--restore-backup');
  const keepBackups = process.argv.includes('--keep-backups');

  const aliasDir = path.join(homeDir(), '.claude', 'skills', 'krylo');
  const skillFile = path.join(aliasDir, 'SKILL.md');
  const metaFile = path.join(aliasDir, '.krylo-alias.json');

  if (!fs.existsSync(aliasDir)) {
    process.stdout.write(JSON.stringify({ ok: true, mode: apply ? 'apply' : 'dry-run', state: 'absent', actions: [] }));
    process.exit(0);
  }

  const owned = fs.existsSync(skillFile) && /krylo-alias-version:/.test(fs.readFileSync(skillFile, 'utf8'));
  if (!owned) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'foreign-skill',
      message: `${aliasDir} is not owned by KRYLO (missing ownership marker). Nothing will be removed.`,
    }, null, 2));
    process.exit(1);
  }

  const backups = fs.readdirSync(aliasDir)
    .filter((f) => f.startsWith('SKILL.md.backup-'))
    .sort()
    .map((f) => path.join(aliasDir, f));

  const actions = [];
  if (restoreBackup && backups.length > 0) {
    actions.push(`restore ${backups[backups.length - 1]} -> ${skillFile}`);
  } else {
    actions.push(`remove ${skillFile}`);
  }
  if (fs.existsSync(metaFile)) actions.push(`remove ${metaFile}`);
  if (!keepBackups) for (const b of backups) actions.push(`remove ${b}`);
  actions.push(`remove ${aliasDir} when empty`);

  if (!apply) {
    process.stdout.write(JSON.stringify({ ok: true, mode: 'dry-run', actions, note: 'dry run only - nothing was changed; re-run with --apply' }, null, 2));
    process.exit(0);
  }

  if (restoreBackup && backups.length > 0) {
    fs.copyFileSync(backups[backups.length - 1], skillFile);
  } else {
    fs.rmSync(skillFile, { force: true });
  }
  fs.rmSync(metaFile, { force: true });
  if (!keepBackups) for (const b of backups) fs.rmSync(b, { force: true });
  try {
    if (fs.readdirSync(aliasDir).length === 0) fs.rmdirSync(aliasDir);
  } catch {
    // leave a non-empty directory alone
  }

  process.stdout.write(JSON.stringify({ ok: true, mode: 'apply', actions, applied: true }, null, 2));
  process.exit(0);
}

main();
