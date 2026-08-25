// Cross-platform child-process invocation helper.
//
// Found while building Cross-Harness (docs/adr/0030-cross-harness-advisory-workers.md):
// on Windows, `child_process.spawnSync('claude', [...], { shell: false })`
// fails outright with EINVAL, because `claude`/`codex` (like most npm-
// installed CLIs) resolve to a `.cmd` shim on Windows, and Node.js refuses
// to exec a `.cmd`/`.bat` file directly without a shell -- .cmd files are
// not real executables; only cmd.exe can interpret them. The naive fix,
// `shell: true`, is unsafe: Node's own runtime emits
// "DEP0190: Passing args to a child process with shell option true can
// lead to security vulnerabilities, as the arguments are not escaped, only
// concatenated" -- verified directly: an argv element containing `&&` was
// genuinely executed as a second shell command when `shell: true` was used.
//
// The safe pattern, verified directly against the real installed `claude`/
// `codex` npm shims on this platform: invoke `cmd.exe /d /s /c <command>
// <args...>` with `shell: false` and the full argv array intact. Windows'
// own CreateProcess argument-vector passing (not shell string
// concatenation) is used for every element, INCLUDING the target command
// name itself (cmd.exe performs its own PATH/PATHEXT resolution, so no
// manual `.cmd`-path lookup is needed) -- verified an argv element
// containing `&& echo INJECTED` is passed through as inert literal text,
// never executed. `/d` disables AutoRun registry commands (defense in
// depth: a compromised registry AutoRun entry cannot piggyback on this
// invocation); `/s` preserves the CreateProcess-standard quote-stripping
// behavior for the command argument specifically.
//
// On POSIX platforms, this is a no-op: the command is invoked directly,
// shell:false, exactly as every other spawn site in this codebase already
// does.

import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Kill an entire process tree rooted at pid. Necessary in addition to
 * spawnSync's own `timeout` option: on Windows, that option only signals
 * the DIRECT child -- here, always cmd.exe (platformSpawnTarget's wrapper,
 * needed to launch a .cmd shim at all). Verified directly building
 * Cross-Harness: a "slow worker" fixture invoked as cmd.exe -> worker.cmd
 * -> node kept running for its FULL delay, well past spawnSync reporting
 * TIMEOUT, because killing cmd.exe never touched the grandchild node
 * process -- an orphaned process that also kept holding a Windows file
 * lock on its own cwd for that entire remaining duration. `taskkill /t`
 * (tree) recursively terminates every descendant of pid. On POSIX,
 * spawnSync's own timeout kill already reaches the direct child; the
 * platformSpawnTarget wrapper is a no-op there (no extra process layer to
 * leak from), so nothing further is needed.
 */
export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (os.platform() === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: false, timeout: 5000, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Best-effort: the process may have already exited on its own.
  }
}

/**
 * Adjust a { command, args } pair for safe, shell:false spawning on the
 * current platform. Callers should always spawn with the RETURNED command
 * and args (never the originals directly) and always with shell:false.
 */
export function platformSpawnTarget(command, args) {
  if (os.platform() !== 'win32') {
    return { command, args };
  }
  const comSpec = typeof process.env.ComSpec === 'string' && process.env.ComSpec.trim() !== ''
    ? process.env.ComSpec
    : 'C:\\Windows\\System32\\cmd.exe';
  return { command: comSpec, args: ['/d', '/s', '/c', command, ...args] };
}
