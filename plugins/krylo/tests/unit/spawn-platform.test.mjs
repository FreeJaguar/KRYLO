import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { platformSpawnTarget, resolveWindowsShimTarget } from '../../scripts/lib/spawn-platform.mjs';

test('on POSIX, the command and args pass through unchanged', { skip: os.platform() === 'win32' }, () => {
  const result = platformSpawnTarget('claude', ['--version']);
  assert.deepEqual(result, { command: 'claude', args: ['--version'] });
});

test('on Windows, a real installed npm CLI (claude) resolves to its REAL underlying target, never cmd.exe', { skip: os.platform() !== 'win32' }, () => {
  const result = platformSpawnTarget('claude', ['--version', '--foo']);
  assert.ok(result, 'claude must resolve on this environment');
  assert.doesNotMatch(result.command.toLowerCase(), /cmd\.exe$/, 'must never route through cmd.exe -- see spawn-platform.mjs header comment for why');
  assert.match(result.command.toLowerCase(), /\.exe$/);
  assert.deepEqual(result.args.slice(-2), ['--version', '--foo']);
});

test('on Windows, spawning the resolved real target actually works (real process, real version output)', { skip: os.platform() !== 'win32' }, () => {
  const target = platformSpawnTarget('node', ['--version']);
  assert.ok(target);
  const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^v?\d+\.\d+\.\d+/);
});

test('on Windows, an argv element containing shell metacharacters is passed through as inert literal data, never executed', { skip: os.platform() !== 'win32' }, () => {
  const target = platformSpawnTarget('node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'x && echo INJECTED || echo INJECTED2', 'y; rm -rf /', 'z`echo INJECTED3`']);
  assert.ok(target);
  const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed, ['x && echo INJECTED || echo INJECTED2', 'y; rm -rf /', 'z`echo INJECTED3`']);
});

// Regression for a CONFIRMED, REPRODUCED vulnerability: a fresh independent
// Security Reviewer found and demonstrated that the earlier cmd.exe-wrapping
// implementation of platformSpawnTarget() was genuinely exploitable via an
// argv element containing an embedded double-quote character -- cmd.exe
// re-parses the command line Node builds for the FINAL target's own argv,
// and an embedded `"` prematurely closes cmd.exe's own quoted region,
// letting metacharacters after it execute as real cmd.exe syntax. Directly
// reproduced: this exact payload created a real file on disk under the old
// implementation. The fix (resolving the real underlying .exe/node target
// and invoking it directly, bypassing cmd.exe/no reparsing step at all) is
// what this test proves closes it, on the real installed node.exe.
test('on Windows, an argv element containing an embedded double-quote and cmd.exe metacharacters cannot break out and execute a command (the confirmed real vulnerability this module was rewritten to close)', { skip: os.platform() !== 'win32' }, () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-quote-breakout-'));
  const markerFile = path.join(probeDir, 'PWNED.txt');
  try {
    const payload = 'x" & echo pwned> PWNED.txt & rem "';
    const target = platformSpawnTarget('node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', payload]);
    assert.ok(target);
    const res = spawnSync(target.command, target.args, { cwd: probeDir, encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), [payload], 'the payload must arrive as ONE intact literal argv element, not be split by cmd.exe re-parsing it');
    assert.ok(!fs.existsSync(markerFile), 'the embedded "& echo ... >" must never actually execute and create a file');
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});

test('spawning a bare, unresolvable command name fails closed (returns null), never falls back to an unsafe path', { skip: os.platform() !== 'win32' }, () => {
  const target = platformSpawnTarget('this-cli-definitely-does-not-exist-xyz', ['--version']);
  assert.equal(target, null);
});

test('resolveWindowsShimTarget correctly parses the real installed claude.cmd and codex.cmd shims', { skip: os.platform() !== 'win32' }, () => {
  const res = spawnSync('where', ['claude'], { encoding: 'utf8', shell: false });
  const claudeCmd = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('.cmd'));
  assert.ok(claudeCmd, 'claude.cmd must be resolvable on PATH in this environment');
  const target = resolveWindowsShimTarget(claudeCmd);
  assert.ok(target);
  assert.match(target.command.toLowerCase(), /claude\.exe$/);

  const res2 = spawnSync('where', ['codex'], { encoding: 'utf8', shell: false });
  const codexCmd = res2.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('.cmd'));
  assert.ok(codexCmd, 'codex.cmd must be resolvable on PATH in this environment');
  const codexTarget = resolveWindowsShimTarget(codexCmd);
  assert.ok(codexTarget);
  assert.match(codexTarget.command.toLowerCase(), /node\.exe$/);
  assert.ok(codexTarget.prefixArgs.length === 1 && /codex\.js$/i.test(codexTarget.prefixArgs[0]));
});

test('resolveWindowsShimTarget fails closed (returns null) on an unrecognized shim format, never guesses', { skip: os.platform() !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-bad-shim-'));
  try {
    const badShim = path.join(dir, 'weird.cmd');
    fs.writeFileSync(badShim, '@echo off\r\necho this is not a recognized shim shape\r\n');
    assert.equal(resolveWindowsShimTarget(badShim), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
