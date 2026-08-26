// TDD category A (task Section 19.A): version parsing/comparison.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSemver, parseCodexVersion, parseMajorMinor, compareParsed } from '../../scripts/lib/version-compare.mjs';

test('parseSemver: exact X.Y.Z and v-prefixed forms parse correctly', () => {
  assert.deepEqual(parseSemver('2.1.223'), { ok: true, major: 2, minor: 1, patch: 223 });
  assert.deepEqual(parseSemver('v2.1.223'), { ok: true, major: 2, minor: 1, patch: 223 });
});

test('parseSemver: malformed input is an explicit failure, never guessed', () => {
  for (const bad of ['2.1', '2.1.223-beta.1', 'not-a-version', '', '2.1.223.4', null, undefined, 42]) {
    const result = parseSemver(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be malformed`);
  }
});

test('parseCodexVersion: accepts both the GitHub tag shape and the CLI output shape', () => {
  assert.deepEqual(parseCodexVersion('rust-v0.120.0'), { ok: true, major: 0, minor: 120, patch: 0 });
  assert.deepEqual(parseCodexVersion('codex-cli 0.120.0'), { ok: true, major: 0, minor: 120, patch: 0 });
});

test('parseCodexVersion: malformed input is an explicit failure', () => {
  for (const bad of ['0.120.0', 'v0.120.0', 'rust-0.120.0', 'codex 0.120.0', '']) {
    assert.equal(parseCodexVersion(bad).ok, false, `expected ${JSON.stringify(bad)} to be malformed`);
  }
});

test('parseMajorMinor: accepts X.Y', () => {
  assert.deepEqual(parseMajorMinor('22'), { ok: false, reason: 'malformed-version' });
  assert.deepEqual(parseMajorMinor('22.0'), { ok: true, major: 22, minor: 0 });
});

test('compareParsed: newer, older, equal', () => {
  const a = parseSemver('2.1.223');
  const b = parseSemver('2.1.246');
  const c = parseSemver('2.1.223');
  assert.equal(compareParsed(a, b), -1, 'a older than b');
  assert.equal(compareParsed(b, a), 1, 'b newer than a');
  assert.equal(compareParsed(a, c), 0, 'a equal to c');
});

test('compareParsed: an unexpected prerelease-shaped input never silently compares as equal to a real release', () => {
  const real = parseSemver('2.1.223');
  const prerelease = parseSemver('2.1.223-beta.1');
  assert.equal(real.ok, true);
  assert.equal(prerelease.ok, false, 'a prerelease-shaped string must be rejected, not silently truncated and compared');
});
