import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomic, readJson } from '../../scripts/lib/atomic.mjs';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-atomic-'));
}

test('writeJsonAtomic + readJson round trip', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    const obj = { hello: 'world', n: 3, nested: { ok: true } };
    writeJsonAtomic(filePath, obj);
    const result = readJson(filePath);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, obj);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson returns not-found for a missing file without throwing', () => {
  const dir = mkTempDir();
  try {
    const result = readJson(path.join(dir, 'missing.json'));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not-found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson returns parse-error for corrupted JSON without throwing', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'bad.json');
    fs.writeFileSync(filePath, '{ this is not json', 'utf8');
    const result = readJson(filePath);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'parse-error');
    assert.equal(typeof result.raw, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sequential writes each leave the file in a valid, complete state', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    for (let i = 0; i < 20; i++) {
      writeJsonAtomic(filePath, { i, data: 'x'.repeat(50) });
      const result = readJson(filePath);
      assert.equal(result.ok, true);
      assert.equal(result.value.i, i);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no leftover temp files after successful writes', () => {
  const dir = mkTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    for (let i = 0; i < 5; i++) {
      writeJsonAtomic(filePath, { i });
    }
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('temp file is cleaned up when the write fails', () => {
  const dir = mkTempDir();
  try {
    // Passing a value with a BigInt makes JSON.stringify throw before any
    // file write happens, but we still exercise the failure path by writing
    // successfully first, then forcing rename to fail with a directory target.
    const filePath = path.join(dir, 'state.json');
    fs.mkdirSync(filePath); // filePath is now a directory, rename onto it must fail
    assert.throws(() => writeJsonAtomic(filePath, { a: 1 }));
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
