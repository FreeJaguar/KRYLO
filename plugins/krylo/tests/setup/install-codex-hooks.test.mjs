import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { SCRIPTS_ROOT } from '../hooks/helpers.mjs';

function run(args, home, projectDir) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'setup', 'install-codex.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, KRYLO_TEST_HOME: home },
    cwd: projectDir,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* noop */ }
  return { status: res.status, stdout: res.stdout, json };
}

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-codex-hooks-home-'));
}
function mkProject(nameHint = 'krylo-codex-hooks-proj-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), nameHint));
}
function hooksFileOf(project) {
  return path.join(project, '.codex', 'hooks.json');
}
function sidecarFileOf(project) {
  return path.join(project, '.codex', 'krylo-hooks-meta.json');
}
function launcherFileOf(project) {
  return path.join(project, '.codex', 'krylo', 'codex-project-hook-launcher.mjs');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Codex nests the event map under a top-level `hooks` key -- the ONLY shape
// the real installed build accepts (a flat event map is rejected outright
// with "unknown field `UserPromptSubmit`, expected `description` or
// `hooks`", and a rejected config is dropped in full, silently). Verified
// live against codex-cli 0.154.0; see
// docs/adr/0035-codex-live-hook-verification.md.
function readHookEvents(project) {
  return readJson(hooksFileOf(project)).hooks;
}

test('install-codex hooks: default (no --apply) is a dry run that changes nothing on disk', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'hooks', '--project-dir', project], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.mode, 'dry-run');
    assert.equal(res.json.hooks.ok, true);
    assert.ok(!fs.existsSync(hooksFileOf(project)), 'dry run must not create hooks.json');
    assert.ok(!fs.existsSync(sidecarFileOf(project)), 'dry run must not create the sidecar');
    assert.ok(!fs.existsSync(launcherFileOf(project)), 'dry run must not create the launcher');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: fresh --apply writes hooks.json, the sidecar, and the launcher, with commandWindows present for every entry', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.hooks.applied, true);
    const hooks = readHookEvents(project);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']) {
      assert.ok(Array.isArray(hooks[event]) && hooks[event].length === 1, `${event} must have exactly one KRYLO entry`);
      const hookDef = hooks[event][0].hooks[0];
      assert.match(hookDef.command, /codex-project-hook-launcher\.mjs/);
      assert.ok(hookDef.commandWindows, `${event} must provide commandWindows`);
      assert.match(hookDef.commandWindows, /codex-project-hook-launcher\.mjs/);
      assert.ok(!path.isAbsolute(hookDef.command.replace(/^node\s+/, '')), 'command must be a project-relative path, never a machine-specific absolute one');
    }
    assert.match(hooks.PreToolUse[0].matcher, /Bash/);
    // SessionEnd's real platform timeout budget is confirmed ~1-3 seconds
    // (docs/adr/0033-codex-lifecycle-enforcement.md) -- registering a
    // larger value risks the platform simply killing it mid-execution.
    assert.ok(hooks.SessionEnd[0].hooks[0].timeout <= 3, 'SessionEnd timeout must respect the confirmed platform ceiling');
    assert.ok(fs.existsSync(sidecarFileOf(project)));
    assert.ok(fs.existsSync(launcherFileOf(project)));
    const launcherContent = fs.readFileSync(launcherFileOf(project), 'utf8');
    assert.match(launcherContent, /krylo-hook-launcher-version:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: preserves unrelated pre-existing events and unrelated entries within a shared event array', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const foreignHooks = {
      description: 'a project\'s own hooks, not KRYLO\'s',
      hooks: {
        // PreCompact is genuinely out of scope for KRYLO (docs/adr/0033
        // explicitly defers it) -- a real event KRYLO never manages, unlike
        // SessionStart/SessionEnd/Stop, which this checkpoint now owns.
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo unrelated-precompact' }] }],
        PreToolUse: [{ matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'echo unrelated-pretooluse' }] }],
      },
    };
    fs.writeFileSync(hooksFileOf(project), JSON.stringify(foreignHooks, null, 2), 'utf8');

    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.status, 0, JSON.stringify(res.json));
    const hooks = readHookEvents(project);
    assert.equal(hooks.PreCompact.length, 1);
    assert.equal(hooks.PreCompact[0].hooks[0].command, 'echo unrelated-precompact', 'an event KRYLO does not manage at all must be byte-for-byte untouched');
    assert.equal(hooks.PreToolUse.length, 2, 'KRYLO must append alongside the existing foreign PreToolUse entry, never replace it');
    const foreignEntry = hooks.PreToolUse.find((e) => e.matcher === 'SomeOtherTool');
    assert.ok(foreignEntry, 'the foreign PreToolUse entry must still be present');
    assert.equal(foreignEntry.hooks[0].command, 'echo unrelated-pretooluse');
    const krylOwnedEntry = hooks.PreToolUse.find((e) => e.matcher !== 'SomeOtherTool');
    assert.match(krylOwnedEntry.hooks[0].command, /codex-project-hook-launcher\.mjs/);
    assert.equal(readJson(hooksFileOf(project)).description, 'a project\'s own hooks, not KRYLO\'s', 'unrelated top-level keys must survive untouched');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// A hooks.json written in the LEGACY flat shape (events at the top level)
// is already non-functional on current Codex builds -- verified live: the
// build rejects it with "unknown field `UserPromptSubmit`, expected
// `description` or `hooks`" and drops the whole file. KRYLO must say so
// precisely rather than silently producing a hybrid document (its own
// entries nested, the project's own still stranded at the top level, the
// file still rejected in full).
test('install-codex hooks: a legacy flat-shaped hooks.json is refused with a precise explanation, never silently half-migrated', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(hooksFileOf(project), JSON.stringify({
      PreToolUse: [{ matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'echo legacy' }] }],
    }, null, 2), 'utf8');

    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.status, 1, 'a legacy-shaped file must not report success');
    assert.equal(res.json.hooks.ok, false);
    assert.equal(res.json.hooks.error, 'legacy-flat-hooks-json');
    assert.match(res.json.hooks.message, /hooks/, 'the message must explain the required shape');

    const after = readJson(hooksFileOf(project));
    assert.deepEqual(Object.keys(after), ['PreToolUse'], 'the project\'s own file must be left byte-for-byte untouched');
    assert.ok(!fs.existsSync(sidecarFileOf(project)), 'no ownership sidecar may be written for a refused install');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: re-applying over a KRYLO-owned install backs up hooks.json and replaces its own entry in place (upgrade path)', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(first.json.hooks.applied, true);

    const second = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(second.status, 0, JSON.stringify(second.json));
    assert.equal(second.json.hooks.perEvent.PreToolUse, 'krylo-owned');
    assert.ok(second.json.hooks.backup, 'a backup path must be recorded for an upgrade');
    assert.ok(fs.existsSync(second.json.hooks.backup), 'the backup file must actually exist on disk');
    const hooks = readHookEvents(project);
    assert.equal(hooks.PreToolUse.length, 1, 'the upgrade must replace in place, never duplicate');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: the backup written on upgrade genuinely restores the prior file (rollback actually works, not just a recorded path)', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(first.json.hooks.applied, true);
    const beforeUpgrade = fs.readFileSync(hooksFileOf(project), 'utf8');

    const second = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.ok(second.json.hooks.backup);
    assert.equal(fs.readFileSync(second.json.hooks.backup, 'utf8'), beforeUpgrade, 'the backup itself must be an exact copy of the pre-upgrade file');

    // Manually perform the documented rollback: restore the backup over the live file.
    fs.copyFileSync(second.json.hooks.backup, hooksFileOf(project));
    const restored = fs.readFileSync(hooksFileOf(project), 'utf8');
    assert.equal(restored, beforeUpgrade, 'restoring the recorded backup must reproduce the exact pre-upgrade content');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: idempotent -- applying twice in a row never errors and always leaves exactly one KRYLO entry per event', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
      assert.equal(res.status, 0, `apply #${i + 1} must succeed`);
    }
    const hooks = readHookEvents(project);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']) {
      assert.equal(hooks[event].length, 1, `${event} must have exactly one entry after two applies`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: a lost/deleted sidecar recovers by adopting the existing launcher-referencing entry instead of duplicating it (regression found by a fresh independent Reviewer)', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(first.json.hooks.applied, true);

    fs.rmSync(sidecarFileOf(project), { force: true });

    const second = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(second.status, 0, JSON.stringify(second.json));
    assert.equal(second.json.hooks.perEvent.PreToolUse, 'krylo-owned', 'a live launcher-referencing entry must be adopted, not treated as absent');
    const hooks = readHookEvents(project);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']) {
      assert.equal(hooks[event].length, 1, `${event} must still have exactly one entry, never duplicated`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: hooks.json deleted while the sidecar survives recovers as a fresh install rather than becoming permanently ambiguous', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(first.json.hooks.applied, true);

    fs.rmSync(hooksFileOf(project), { force: true });

    const second = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(second.status, 0, JSON.stringify(second.json));
    const hooks = readHookEvents(project);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']) {
      assert.equal(hooks[event].length, 1, `${event} must be freshly (re)installed, not stuck ambiguous`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: a genuinely foreign file at the launcher path is never overwritten', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    fs.mkdirSync(path.dirname(launcherFileOf(project)), { recursive: true });
    fs.writeFileSync(launcherFileOf(project), '#!/usr/bin/env node\nconsole.log("not KRYLO");\n', 'utf8');

    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.json.hooks.ok, false);
    assert.equal(res.json.hooks.error, 'foreign-launcher-file');
    assert.equal(fs.readFileSync(launcherFileOf(project), 'utf8'), '#!/usr/bin/env node\nconsole.log("not KRYLO");\n', 'foreign content must be byte-for-byte untouched');
    assert.ok(!fs.existsSync(hooksFileOf(project)), 'hooks.json must not be written when the launcher target is foreign');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: ambiguous ownership (sidecar says KRYLO installed something, but it was hand-edited away) refuses to touch that event automatically', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(first.json.hooks.applied, true);

    // Hand-edit the KRYLO-owned PreToolUse entry so it no longer matches the sidecar record.
    const hooks = readHookEvents(project);
    hooks.PreToolUse[0].hooks[0].timeout = 999;
    fs.writeFileSync(hooksFileOf(project), JSON.stringify({ hooks }, null, 2), 'utf8');

    const second = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(second.json.hooks.ok, false);
    assert.equal(second.json.hooks.error, 'ambiguous-ownership');
    assert.ok(second.json.hooks.ambiguousEvents.includes('PreToolUse'));
    const unchangedHooks = readHookEvents(project);
    assert.equal(unchangedHooks.PreToolUse[0].hooks[0].timeout, 999, 'the hand-edited entry must remain untouched, never silently overwritten');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: a malformed (non-JSON) hooks.json is refused, never guessed at or overwritten', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(hooksFileOf(project), '{ this is not valid json', 'utf8');
    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.json.hooks.ok, false);
    assert.equal(res.json.hooks.error, 'malformed-hooks-json');
    assert.equal(fs.readFileSync(hooksFileOf(project), 'utf8'), '{ this is not valid json');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: --remove uninstalls only the KRYLO-owned entries and preserves unrelated hooks', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(hooksFileOf(project), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }, null, 2), 'utf8');

    const install = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(install.json.hooks.applied, true);

    const dryRemove = run(['--target', 'hooks', '--remove', '--project-dir', project], home, project);
    assert.equal(dryRemove.json.hooks.ok, true);
    assert.ok(fs.existsSync(hooksFileOf(project)), 'dry-run remove must not delete anything');
    assert.ok(fs.existsSync(launcherFileOf(project)));

    const applyRemove = run(['--target', 'hooks', '--remove', '--apply', '--project-dir', project], home, project);
    assert.equal(applyRemove.json.hooks.applied, true);
    const hooks = readHookEvents(project);
    assert.equal(hooks.UserPromptSubmit, undefined, 'KRYLO event with nothing else in it must be removed entirely');
    assert.equal(hooks.SessionStart[0].hooks[0].command, 'echo unrelated', 'unrelated content must survive removal');
    assert.ok(!fs.existsSync(sidecarFileOf(project)));
    assert.ok(!fs.existsSync(launcherFileOf(project)));

    const removeAgain = run(['--target', 'hooks', '--remove', '--apply', '--project-dir', project], home, project);
    assert.equal(removeAgain.json.hooks.ok, true);
    assert.equal(removeAgain.json.hooks.state, 'absent');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: --remove when hooks.json was deleted by hand but the sidecar survives cleans up safely, never a raw ENOENT crash (regression found by independent Reviewer + Security Reviewer)', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const install = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(install.json.hooks.applied, true);

    // Simulate a user hand-deleting hooks.json while leaving the sidecar
    // (and launcher) in place -- classifyEventOwnership() already treats
    // this as "absent" for every event, but the apply path's backup step
    // previously called fs.copyFileSync(hooksFile, backupPath)
    // unconditionally, throwing an uncaught ENOENT instead of the clean
    // {ok:false}/{ok:true, state:'absent'} shape every other path here
    // returns.
    fs.rmSync(hooksFileOf(project), { force: true });
    assert.ok(fs.existsSync(sidecarFileOf(project)), 'fixture precondition: sidecar must still exist');

    const applyRemove = run(['--target', 'hooks', '--remove', '--apply', '--project-dir', project], home, project);
    assert.equal(applyRemove.status, 0, 'must never crash with a raw exception, even when hooks.json is missing');
    assert.equal(applyRemove.json.hooks.ok, true);
    assert.ok(!fs.existsSync(sidecarFileOf(project)), 'the now-meaningless sidecar must still be cleaned up');
    assert.ok(!fs.existsSync(launcherFileOf(project)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: works correctly when the project directory path contains spaces', () => {
  const home = mkHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo codex hooks proj '));
  try {
    const res = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(res.status, 0, JSON.stringify(res.json));
    assert.ok(fs.existsSync(hooksFileOf(project)));
    assert.ok(fs.existsSync(launcherFileOf(project)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex hooks: reports whether .codex/hooks.json is git-tracked or untracked, and never writes .gitignore', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    execFileSync('git', ['-C', project, 'init', '-q'], { encoding: 'utf8' });
    execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
    execFileSync('git', ['-C', project, 'config', 'user.name', 'Test'], { encoding: 'utf8' });

    const untrackedRes = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(untrackedRes.json.hooks.gitStatus, 'untracked-or-not-a-git-repo');
    assert.ok(!fs.existsSync(path.join(project, '.gitignore')), 'setup must never create/modify .gitignore');

    execFileSync('git', ['-C', project, 'add', '.codex/hooks.json'], { encoding: 'utf8' });
    execFileSync('git', ['-C', project, 'commit', '-q', '-m', 'track hooks.json'], { encoding: 'utf8' });

    const trackedRes = run(['--target', 'hooks', '--apply', '--project-dir', project], home, project);
    assert.equal(trackedRes.json.hooks.gitStatus, 'tracked');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
