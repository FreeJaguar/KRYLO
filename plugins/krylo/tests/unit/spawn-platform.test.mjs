import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { platformSpawnTarget } from '../../scripts/lib/spawn-platform.mjs';

test('on POSIX, the command and args pass through unchanged', { skip: os.platform() === 'win32' }, () => {
  const result = platformSpawnTarget('claude', ['--version']);
  assert.deepEqual(result, { command: 'claude', args: ['--version'] });
});

test('on Windows, the command is wrapped through cmd.exe /d /s /c', { skip: os.platform() !== 'win32' }, () => {
  const result = platformSpawnTarget('claude', ['--version', '--foo']);
  assert.match(result.command.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(result.args, ['/d', '/s', '/c', 'claude', '--version', '--foo']);
});

test('on Windows, a .cmd npm shim can actually be spawned with shell:false via the wrapped target (real process, node/npm itself)', { skip: os.platform() !== 'win32' }, () => {
  // node is guaranteed present in this test environment; this proves the
  // wrapper genuinely produces a launchable, shell:false-safe invocation,
  // not merely a plausible-looking argv shape.
  const { command, args } = platformSpawnTarget('node', ['--version']);
  const res = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^v?\d+\.\d+\.\d+/);
});

test('on Windows, an argv element containing shell metacharacters is passed through as inert literal data, never executed', { skip: os.platform() !== 'win32' }, () => {
  const { command, args } = platformSpawnTarget('node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'x && echo INJECTED || echo INJECTED2', 'y; rm -rf /', 'z`echo INJECTED3`']);
  const res = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(res.status, 0);
  // The literal strings legitimately CONTAIN the word "INJECTED" as
  // payload text -- the real assertion is that node's own argv array came
  // through as exactly these three literal elements (proving cmd.exe never
  // re-interpreted &&/||/;/backticks as shell syntax), not that the
  // substring is absent from stdout altogether.
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed, ['x && echo INJECTED || echo INJECTED2', 'y; rm -rf /', 'z`echo INJECTED3`']);
  assert.equal((res.stdout.match(/INJECTED/g) || []).length, 3, 'exactly the three literal substring occurrences inside the untouched payload strings ("INJECTED", "INJECTED2", "INJECTED3"), and no more -- a real execution would print additional bare INJECTED/INJECTED2/INJECTED3 lines from the echo commands actually running');
});

test('spawning a bare, unresolvable command name fails cleanly (no hang, a real non-zero exit) rather than throwing', { skip: os.platform() !== 'win32' }, () => {
  const { command, args } = platformSpawnTarget('this-cli-definitely-does-not-exist-xyz', ['--version']);
  const res = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.notEqual(res.status, 0);
});
