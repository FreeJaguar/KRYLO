#!/usr/bin/env node
// Install the optional personal /krylo wrapper skill (docs/18-setup-and-alias.md,
// ADR-0002, ADR-0013).
//
// DEFAULT IS DRY RUN: prints the exact plan and changes nothing.
// --apply performs the installation. A foreign skill named `krylo` is never
// overwritten, in any mode. A KRYLO-owned older alias is backed up first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALIAS_VERSION = '0.3.0';

function homeDir() {
  return process.env.KRYLO_TEST_HOME && process.env.KRYLO_TEST_HOME.trim() !== ''
    ? process.env.KRYLO_TEST_HOME
    : os.homedir();
}

const WRAPPER_CONTENT = `---
name: krylo
description: Personal convenience wrapper that forwards to the installed KRYLO plugin. The portable command /krylo:run always works without this wrapper.
argument-hint: "<task>"
disable-model-invocation: true
user-invocable: true
---

<!-- krylo-alias-version: ${ALIAS_VERSION} -->
<!-- Installed by /krylo:setup. Remove with: node remove-alias.mjs --apply -->

Invoke the installed KRYLO plugin run skill \`/krylo:run\` with these arguments, unchanged:

$ARGUMENTS
`;

function classifyExisting(skillFile, aliasDir) {
  if (!fs.existsSync(aliasDir)) return 'absent';
  if (!fs.existsSync(skillFile)) return 'foreign';
  const content = fs.readFileSync(skillFile, 'utf8');
  return /krylo-alias-version:/.test(content) ? 'krylo-owned' : 'foreign';
}

function main() {
  const apply = process.argv.includes('--apply');
  const aliasDir = path.join(homeDir(), '.claude', 'skills', 'krylo');
  const skillFile = path.join(aliasDir, 'SKILL.md');
  const metaFile = path.join(aliasDir, '.krylo-alias.json');

  const existing = classifyExisting(skillFile, aliasDir);

  if (existing === 'foreign') {
    process.stdout.write(JSON.stringify({
      ok: false,
      mode: apply ? 'apply' : 'dry-run',
      error: 'foreign-skill',
      message: `A personal skill named 'krylo' already exists at ${aliasDir} and is not owned by KRYLO. It will NOT be overwritten. Rename or remove it manually if you want the alias.`,
    }, null, 2));
    process.exit(1);
  }

  const backupPath = existing === 'krylo-owned' ? `${skillFile}.backup-${Date.now()}` : null;
  const plan = {
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    target: skillFile,
    existing,
    backup: backupPath,
    aliasVersion: ALIAS_VERSION,
    rollback: backupPath
      ? `restore ${backupPath} over ${skillFile}, or run remove-alias.mjs --apply --restore-backup`
      : `run remove-alias.mjs --apply`,
    actions: [
      ...(backupPath ? [`copy ${skillFile} -> ${backupPath}`] : []),
      `write ${skillFile}`,
      `write ${metaFile}`,
    ],
  };

  if (!apply) {
    process.stdout.write(JSON.stringify({ ...plan, note: 'dry run only - nothing was changed; re-run with --apply' }, null, 2));
    process.exit(0);
  }

  fs.mkdirSync(aliasDir, { recursive: true });
  if (backupPath) fs.copyFileSync(skillFile, backupPath);
  fs.writeFileSync(skillFile, WRAPPER_CONTENT, 'utf8');
  fs.writeFileSync(metaFile, JSON.stringify({ version: ALIAS_VERSION, installedAt: new Date().toISOString() }, null, 2), 'utf8');

  process.stdout.write(JSON.stringify({ ...plan, applied: true }, null, 2));
  process.exit(0);
}

main();
