import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeJoin } from '../../scripts/lib/paths.mjs';
import { computeProjectRootHash } from '../../scripts/lib/state.mjs';
import { redactText } from '../../scripts/lib/redact.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-paths-'));
}

test('safeJoin allows a normal nested path under root', () => {
  const root = mkTempRoot();
  try {
    const result = safeJoin(root, 'runs', 'run-abc123', 'state.json');
    assert.ok(result.startsWith(path.resolve(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safeJoin rejects ".." traversal escape', () => {
  const root = mkTempRoot();
  try {
    assert.throws(() => safeJoin(root, '..', '..', 'etc', 'passwd'));
    assert.throws(() => safeJoin(root, 'runs', '..', '..', 'outside.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safeJoin rejects absolute-path injection segments', () => {
  const root = mkTempRoot();
  try {
    if (process.platform === 'win32') {
      assert.throws(() => safeJoin(root, 'C:\\Windows\\System32'));
    } else {
      assert.throws(() => safeJoin(root, '/etc/passwd'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safeJoin rejects traversal segments using forward slashes on Windows', () => {
  const root = mkTempRoot();
  try {
    assert.throws(() => safeJoin(root, '../../outside'));
    assert.throws(() => safeJoin(root, 'a/../../../outside'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project root hash is identical for the same directory expressed with / vs \\', () => {
  const root = mkTempRoot();
  try {
    const nested = path.join(root, 'proj', 'sub');
    fs.mkdirSync(nested, { recursive: true });
    const backslashForm = nested; // native form on Windows already uses backslashes
    const forwardSlashForm = nested.split(path.sep).join('/');
    const hashA = computeProjectRootHash(backslashForm);
    const hashB = computeProjectRootHash(forwardSlashForm);
    assert.equal(hashA, hashB);
    assert.match(hashA, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('redact replaces home-dir prefixes for both Windows and POSIX styles', () => {
  const win = redactText('C:\\Users\\bob\\Documents\\secret.txt');
  assert.ok(win.startsWith('~'));
  const posix = redactText('/home/bob/documents/secret.txt');
  assert.ok(posix.startsWith('~'));
  const mac = redactText('/Users/bob/documents/secret.txt');
  assert.ok(mac.startsWith('~'));
});
