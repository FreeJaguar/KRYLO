import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SCRIPTS_ROOT } from '../hooks/helpers.mjs';

// Read from the real manifest rather than hardcoding. An independent review
// found that this test's hardcoded literal is exactly why the stamp it
// guards went stale twice: it asserts agreement between the script and the
// TEST, so when a release bumps package.json and neither the script nor the
// test is touched, both stay on the old value and agree with each other
// while the product version has moved on. Deriving it here means a bump
// that forgets the stamp fails this test instead of passing it.
const CURRENT_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(SCRIPTS_ROOT, '..', '..', '..', 'package.json'), 'utf8'),
).version;

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-home-'));
}

function runSetup(script, args, home) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'setup', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_TEST_HOME: home },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* noop */ }
  return { status: res.status, stdout: res.stdout, json };
}

function aliasPaths(home) {
  const dir = path.join(home, '.claude', 'skills', 'krylo');
  return { dir, skill: path.join(dir, 'SKILL.md'), meta: path.join(dir, '.krylo-alias.json') };
}

test('alias: dry run changes nothing', () => {
  const home = mkHome();
  try {
    const res = runSetup('install-alias.mjs', [], home);
    assert.equal(res.status, 0);
    assert.equal(res.json.mode, 'dry-run');
    assert.ok(!fs.existsSync(aliasPaths(home).dir));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('alias: apply installs a marked wrapper with metadata', () => {
  const home = mkHome();
  try {
    const res = runSetup('install-alias.mjs', ['--apply'], home);
    assert.equal(res.status, 0);
    const { skill, meta } = aliasPaths(home);
    const content = fs.readFileSync(skill, 'utf8');
    assert.ok(content.includes(`krylo-alias-version: ${CURRENT_VERSION}`),
      `the installed alias must stamp the real current product version, got: ${content.match(/krylo-alias-version: \S+/)?.[0]}`);
    assert.match(content, /\/krylo:run/);
    assert.match(content, /\$ARGUMENTS/);
    assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).version, CURRENT_VERSION);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('alias: re-apply backs up the previous krylo-owned wrapper', () => {
  const home = mkHome();
  try {
    runSetup('install-alias.mjs', ['--apply'], home);
    const res = runSetup('install-alias.mjs', ['--apply'], home);
    assert.equal(res.status, 0);
    assert.ok(res.json.backup, 'expected a backup path');
    const { dir } = aliasPaths(home);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('SKILL.md.backup-'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('alias: foreign skill is never overwritten, in dry-run or apply', () => {
  const home = mkHome();
  try {
    const { dir, skill } = aliasPaths(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(skill, '---\nname: krylo\n---\nMy personal krylo skill.', 'utf8');

    const dry = runSetup('install-alias.mjs', [], home);
    assert.equal(dry.status, 1);
    assert.equal(dry.json.error, 'foreign-skill');

    const apply = runSetup('install-alias.mjs', ['--apply'], home);
    assert.equal(apply.status, 1);
    assert.match(fs.readFileSync(skill, 'utf8'), /My personal krylo skill/);

    const remove = runSetup('remove-alias.mjs', ['--apply'], home);
    assert.equal(remove.status, 1);
    assert.ok(fs.existsSync(skill), 'foreign skill must not be removed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('alias: remove dry-run deletes nothing; apply removes only krylo-owned files', () => {
  const home = mkHome();
  try {
    runSetup('install-alias.mjs', ['--apply'], home);
    const { dir, skill } = aliasPaths(home);

    const dry = runSetup('remove-alias.mjs', [], home);
    assert.equal(dry.status, 0);
    assert.ok(fs.existsSync(skill));

    const apply = runSetup('remove-alias.mjs', ['--apply'], home);
    assert.equal(apply.status, 0);
    assert.ok(!fs.existsSync(dir), 'alias directory should be removed when empty');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('alias: rollback restores the newest backup', () => {
  const home = mkHome();
  try {
    runSetup('install-alias.mjs', ['--apply'], home);
    const { skill } = aliasPaths(home);
    const firstContent = fs.readFileSync(skill, 'utf8');
    // Second install creates a backup of the first.
    runSetup('install-alias.mjs', ['--apply'], home);

    const restore = runSetup('remove-alias.mjs', ['--apply', '--restore-backup', '--keep-backups'], home);
    assert.equal(restore.status, 0);
    assert.equal(fs.readFileSync(skill, 'utf8'), firstContent);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
