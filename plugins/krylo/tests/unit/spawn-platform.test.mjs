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

// Regression: this test originally called `platformSpawnTarget('claude', ...)`
// directly, requiring a REAL Claude Code CLI to be installed on whatever
// machine runs the suite -- it passed on this project's own dev machine
// (which has claude installed) but failed outright on a generic
// GitHub-hosted Windows CI runner with neither claude nor codex
// preinstalled ("claude must resolve on this environment"), confirmed via
// the actual failing CI run. Rewritten to use a controlled, disposable
// `.cmd` shim fixture (in the exact npm `cmd-shim` shape this module
// documents supporting) added to a temporary PATH prefix instead --
// exercises the SAME production code path (`resolveOnPath()`'s real
// `where` lookup, then `resolveWindowsShimTarget()`'s real shim parsing)
// without depending on any specific CLI being present on the runner
// image. The one real, always-available executable every environment
// running this test already has is `node.exe` itself (`process.execPath`),
// used here as the fixture shim's own real target.
test('on Windows, an npm-style CLI resolves to its REAL underlying target via a controlled fixture shim, never cmd.exe', { skip: os.platform() !== 'win32' }, () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-shim-fixture-'));
  const shimPath = path.join(fixtureDir, 'krylo-fixture-cli.cmd');
  // The exact npm cmd-shim single-target shape: one quoted absolute path,
  // then a bare %* forwarding every argument.
  fs.writeFileSync(shimPath, `@ECHO off\r\n"${process.execPath}" %*\r\n`);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
    const result = platformSpawnTarget('krylo-fixture-cli', ['--version', '--foo']);
    assert.ok(result, 'the fixture shim must resolve via the real PATH-lookup + shim-parsing code path');
    assert.doesNotMatch(result.command.toLowerCase(), /cmd\.exe$/, 'must never route through cmd.exe -- see spawn-platform.mjs header comment for why');
    assert.match(result.command.toLowerCase(), /\.exe$/);
    assert.deepEqual(result.args.slice(-2), ['--version', '--foo']);
    // Prove it actually spawns, not just resolves: node.exe --version.
    const res = spawnSync(result.command, [...result.args.slice(0, -2), '--version'], { encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^v?\d+\.\d+\.\d+/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// Regression (Critical/High, found and reproduced with a working exploit
// by a fresh independent Security Reviewer against docs/adr/0034-codex-
// runtime-compatibility-gate.md, which turns this function's resolution
// result into a security TRUST decision): confirmed directly (`where
// codex`, run from a directory containing a decoy `codex.cmd`) that
// Windows' `where.exe` searches the CURRENT DIRECTORY before PATH.
// resolveOnPath() used to spawn `where` with no explicit `cwd`, inheriting
// the calling process's own cwd -- for a project-scoped hook launcher
// (docs/adr/0032-codex-project-scoped-hook-enforcement.md), that is the
// untrusted PROJECT ROOT, writable by the model through KRYLO's own
// ordinary, risk-gate-permitted Write tool. A decoy file matching npm's
// cmd-shim shape planted there would be resolved and then directly
// EXECUTED as if it were the real binary. Fixed by pinning `where`'s own
// spawn to a neutral `cwd` (`os.tmpdir()`), removing the project root from
// its search order entirely while genuine PATH-installed binaries are
// still found identically.
test('on Windows, a decoy file planted in the CURRENT DIRECTORY never shadows the real PATH-installed target (regression: where.exe searches cwd before PATH)', { skip: os.platform() !== 'win32' }, () => {
  const pathFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-cwd-shadow-real-'));
  const decoyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-cwd-shadow-decoy-'));
  const originalPath = process.env.PATH;
  const originalCwd = process.cwd();
  try {
    // The REAL, legitimate target -- reachable only via PATH.
    const realShimPath = path.join(pathFixtureDir, 'krylo-cwd-shadow-fixture.cmd');
    fs.writeFileSync(realShimPath, `@ECHO off\r\n"${process.execPath}" %*\r\n`);
    process.env.PATH = `${pathFixtureDir}${path.delimiter}${originalPath}`;

    // A DECOY with the exact same command name, planted in the current
    // working directory -- the exact shape a model could write into a
    // project root through an ordinary Write tool call.
    const decoyMarkerPath = path.join(decoyCwd, 'DECOY_WAS_EXECUTED.txt');
    const decoyShimPath = path.join(decoyCwd, 'krylo-cwd-shadow-fixture.cmd');
    fs.writeFileSync(decoyShimPath, `@ECHO off\r\necho decoy-version 0.0.0\r\necho executed > "${decoyMarkerPath}"\r\n`);

    process.chdir(decoyCwd);
    const target = platformSpawnTarget('krylo-cwd-shadow-fixture', ['--version']);
    assert.ok(target, 'the real PATH-installed target must still resolve');
    assert.doesNotMatch(target.command.toLowerCase(), /krylo-cwd-shadow-decoy/, 'must never resolve to the decoy planted in cwd');

    const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^v?\d+\.\d+\.\d+/, 'must genuinely spawn the real node.exe target, not the decoy');
    assert.ok(!fs.existsSync(decoyMarkerPath), 'the decoy must never have been executed');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(pathFixtureDir, { recursive: true, force: true });
    fs.rmSync(decoyCwd, { recursive: true, force: true });
  }
});

// Regression (High, found and reproduced by a SECOND fresh independent
// Security Reviewer, re-checking the CWD-shadow fix above): pinning
// `where`'s own cwd to `os.tmpdir()` only RELOCATED the vulnerability, it
// did not close it -- (a) os.tmpdir()'s own root is itself an equally
// Write-reachable location for a decoy, and (b) os.tmpdir() is computed
// from the TEMP/TMP environment variables, so redirecting either back to
// the original project-shaped decoy directory fully revives the original
// exploit. Both are now closed by validating that a `where` candidate's
// own containing directory is an EXACT member of the literal directories
// PATH lists -- a decoy anywhere else, regardless of cwd, is rejected.
test('on Windows, a decoy planted directly in os.tmpdir() itself never shadows the real PATH-installed target (regression: an earlier cwd-pinning fix only relocated the vulnerability)', { skip: os.platform() !== 'win32' }, () => {
  const pathFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-tmpdir-shadow-real-'));
  const decoyMarkerPath = path.join(os.tmpdir(), 'TMPDIR_DECOY_EXECUTED.txt');
  const decoyShimPath = path.join(os.tmpdir(), 'krylo-tmpdir-shadow-fixture.cmd');
  const originalPath = process.env.PATH;
  try {
    const realShimPath = path.join(pathFixtureDir, 'krylo-tmpdir-shadow-fixture.cmd');
    fs.writeFileSync(realShimPath, `@ECHO off\r\n"${process.execPath}" %*\r\n`);
    process.env.PATH = `${pathFixtureDir}${path.delimiter}${originalPath}`;

    // A decoy with the exact same command name, planted directly in
    // os.tmpdir()'s own root -- itself a Write-reachable location.
    fs.writeFileSync(decoyShimPath, `@ECHO off\r\necho decoy-version 0.0.0\r\necho executed > "${decoyMarkerPath}"\r\n`);

    const target = platformSpawnTarget('krylo-tmpdir-shadow-fixture', ['--version']);
    assert.ok(target, 'the real PATH-installed target must still resolve');
    assert.doesNotMatch(target.command.toLowerCase(), new RegExp(os.tmpdir().toLowerCase().replace(/[\\]/g, '\\\\')), 'must never resolve to a decoy planted in os.tmpdir() itself');

    const res = spawnSync(target.command, target.args, { encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^v?\d+\.\d+\.\d+/);
    assert.ok(!fs.existsSync(decoyMarkerPath), 'the tmpdir-planted decoy must never have been executed');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(pathFixtureDir, { recursive: true, force: true });
    fs.rmSync(decoyShimPath, { force: true });
    fs.rmSync(decoyMarkerPath, { force: true });
  }
});

test('on Windows, redirecting TEMP/TMP back to a decoy directory does not revive the CWD-shadow exploit', { skip: os.platform() !== 'win32' }, () => {
  const pathFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-temp-redirect-real-'));
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-temp-redirect-decoy-'));
  const originalPath = process.env.PATH;
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  try {
    const realShimPath = path.join(pathFixtureDir, 'krylo-temp-redirect-fixture.cmd');
    fs.writeFileSync(realShimPath, `@ECHO off\r\n"${process.execPath}" %*\r\n`);
    process.env.PATH = `${pathFixtureDir}${path.delimiter}${originalPath}`;

    const decoyMarkerPath = path.join(decoyDir, 'TEMP_REDIRECT_DECOY_EXECUTED.txt');
    fs.writeFileSync(path.join(decoyDir, 'krylo-temp-redirect-fixture.cmd'), `@ECHO off\r\necho decoy-version 0.0.0\r\necho executed > "${decoyMarkerPath}"\r\n`);

    // TEMP/TMP redirected to the decoy directory -- this is what os.tmpdir()
    // itself is computed from, and is NOT a KRYLO-named variable any
    // sentinel-gating convention covers.
    process.env.TEMP = decoyDir;
    process.env.TMP = decoyDir;

    const target = platformSpawnTarget('krylo-temp-redirect-fixture', ['--version']);
    assert.ok(target, 'the real PATH-installed target must still resolve');
    assert.doesNotMatch(target.command.toLowerCase(), /krylo-temp-redirect-decoy/, 'must never resolve to the decoy even when TEMP/TMP point at it');
    assert.ok(!fs.existsSync(decoyMarkerPath), 'the TEMP/TMP-redirected decoy must never have been executed');
  } finally {
    process.env.PATH = originalPath;
    process.env.TEMP = originalTemp;
    process.env.TMP = originalTmp;
    fs.rmSync(pathFixtureDir, { recursive: true, force: true });
    fs.rmSync(decoyDir, { recursive: true, force: true });
  }
});

test('on Windows, a RELATIVE PATH entry is never trusted as a PATH-membership match, even when it resolves to the untrusted cwd (regression)', { skip: os.platform() !== 'win32' }, () => {
  // An independent review found pathDirectorySet() previously called
  // path.resolve(entry) on every PATH entry unconditionally -- a relative
  // entry (here, a bare ".") resolves against THIS PROCESS'S OWN cwd, which
  // during real Cross-Harness worker capability detection is the untrusted
  // project root. Combined with TEMP/TMP also redirected there (so where's
  // own cwd-first search finds the decoy), a decoy that is NOT a real PATH
  // member was still accepted. This test reproduces exactly that
  // combination and confirms the fix (dropping non-absolute PATH entries
  // before resolving) closes it.
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-relative-path-decoy-'));
  const originalPath = process.env.PATH;
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  const originalCwd = process.cwd();
  try {
    const decoyMarkerPath = path.join(decoyDir, 'RELATIVE_PATH_DECOY_EXECUTED.txt');
    fs.writeFileSync(path.join(decoyDir, 'krylo-relative-path-fixture.cmd'), `@ECHO off\r\necho decoy-version 0.0.0\r\necho executed > "${decoyMarkerPath}"\r\n`);

    // A bare "." (relative) PATH entry, deliberately with no genuine
    // absolute entry for this fixture name anywhere else on PATH.
    process.env.PATH = `.${path.delimiter}${originalPath}`;
    process.env.TEMP = decoyDir;
    process.env.TMP = decoyDir;
    process.chdir(decoyDir);

    const target = platformSpawnTarget('krylo-relative-path-fixture', ['--version']);
    assert.equal(target, null, 'a relative PATH entry must never be trusted as a membership match for a decoy in the untrusted cwd');
    assert.ok(!fs.existsSync(decoyMarkerPath), 'the decoy must never have been executed');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    process.env.TEMP = originalTemp;
    process.env.TMP = originalTmp;
    fs.rmSync(decoyDir, { recursive: true, force: true });
  }
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

// Regression: this test originally shelled out to `where claude` / `where
// codex` and required both real CLIs to be installed on PATH -- it passed
// on this project's own dev machine but failed on a generic GitHub-hosted
// Windows CI runner ("claude.cmd must be resolvable on PATH in this
// environment"), confirmed via the actual failing CI run. Rewritten to
// build two controlled, disposable fixture `.cmd` files reproducing the two
// real npm cmd-shim shapes this module documents supporting (single quoted
// .exe target, and the node.exe+colocated-script shape with %dp0%/%_prog%
// substitution and surrounding control-flow junk, mirroring the real
// installed claude.cmd/codex.cmd shapes characterized when this module was
// written) -- exercising the exact same parsing logic without requiring
// either CLI to be present. The node+script fixture deliberately has no
// node.exe colocated, forcing the shim's own documented PATH-fallback
// branch (`%_prog%` -> bare `node`) through `resolveOnPath()`; `node` is
// guaranteed present on any environment capable of running this test suite
// at all, so this needs no external dependency.
test('resolveWindowsShimTarget correctly parses controlled fixture cmd-shims (single-exe shape and node+script shape), independent of any preinstalled claude/codex CLI', { skip: os.platform() !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-shim-parse-fixture-'));
  try {
    const singleShim = path.join(dir, 'fixture-single.cmd');
    fs.writeFileSync(singleShim, `@ECHO off\r\n"${process.execPath}" %*\r\n`);
    const singleTarget = resolveWindowsShimTarget(singleShim);
    assert.ok(singleTarget);
    assert.equal(singleTarget.command, process.execPath);
    assert.deepEqual(singleTarget.prefixArgs, []);

    const nodeShim = path.join(dir, 'fixture-node-script.cmd');
    fs.writeFileSync(nodeShim, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%node.exe" (',
      '  SET "_prog=%dp0%node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%fixture-script.js" %*',
      '',
    ].join('\r\n'));
    const scriptTarget = resolveWindowsShimTarget(nodeShim);
    assert.ok(scriptTarget, 'the node+script fixture shim must resolve via the documented %_prog% PATH-fallback branch');
    assert.match(scriptTarget.command.toLowerCase(), /node\.exe$/);
    assert.ok(scriptTarget.prefixArgs.length === 1 && /fixture-script\.js$/i.test(scriptTarget.prefixArgs[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
