import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-codex-setup-home-'));
}
function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-codex-setup-proj-'));
}

test('install-codex: an unknown --target is rejected deterministically, never silently succeeds', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'skils', '--apply'], home, project);
    assert.equal(res.status, 1, 'a typo\'d target must never exit 0');
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'unknown-target');
    assert.ok(!('skill' in res.json) && !('rules' in res.json), 'nothing should have been planned or applied for an unrecognized target');
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run')), 'no mutation must occur for an unknown target');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: a --target flag with no following value is rejected, not a raw crash', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target'], home, project);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'missing-target-value');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: --project-dir immediately followed by another flag is rejected, not silently treated as the value', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'rules', '--project-dir', '--apply'], home, project);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'missing-project-dir-value');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: --target=skill (equals form) is parsed the same as --target skill, not silently treated as "all"', () => {
  // An independent review found argv.indexOf('--target') never matches the
  // whole token '--target=skill', so target silently defaulted to 'all'
  // and BOTH skill and rules were installed -- the same "malformed flag
  // silently does the wrong thing" class the two-argument-form validation
  // above exists to close, in the more permissive direction.
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target=skill'], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.mode, 'dry-run');
    assert.ok('skill' in res.json, 'the skill target must be planned');
    assert.ok(!('rules' in res.json), 'the rules target must NOT be planned for --target=skill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: default (no --apply) is a dry run that changes nothing on disk', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'skill'], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.mode, 'dry-run');
    assert.equal(res.json.skill.ok, true);
    assert.equal(res.json.skill.existing, 'absent');
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run')), 'dry run must not create anything');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: fresh --apply installs the skill verbatim from the repository source', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'skill', '--apply'], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.skill.applied, true);
    const installedFile = path.join(home, '.agents', 'skills', 'krylo-run', 'SKILL.md');
    assert.ok(fs.existsSync(installedFile));
    const content = fs.readFileSync(installedFile, 'utf8');
    assert.match(content, /name:\s*krylo-run/);
    assert.match(content, /krylo-codex-skill-version:/, 'installed copy must carry the KRYLO ownership marker');
    // Also copies the implicit-invocation policy file.
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run', 'agents', 'openai.yaml')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: a pre-existing krylo-run directory with no SKILL.md at all is backed up, not hard-failed (regression)', () => {
  // An independent review found classifySkillOwnership() only checks
  // whether SKILL.md exists, so a directory that exists but has no
  // SKILL.md (a stray/partial directory, e.g. containing only a README)
  // was classified 'absent' -- skipping the move-aside entirely and making
  // the atomic swap-in rename fail on a non-empty target (a functional
  // regression against the pre-atomic-swap code, which used to merge into
  // such a directory via copyDirRecursive instead of failing).
  const home = mkHome();
  const project = mkProject();
  try {
    const strayDir = path.join(home, '.agents', 'skills', 'krylo-run');
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(path.join(strayDir, 'README.md'), 'not a KRYLO skill, no SKILL.md here', 'utf8');

    const res = run(['--target', 'skill', '--apply'], home, project);
    assert.equal(res.status, 0, res.stdout);
    assert.equal(res.json.skill.applied, true);
    assert.ok(res.json.skill.backup, 'the stray pre-existing directory must be backed up, not silently discarded or hard-failed');
    assert.ok(fs.existsSync(path.join(res.json.skill.backup, 'README.md')), 'the stray directory\'s own content must survive in the backup');
    assert.ok(fs.existsSync(path.join(strayDir, 'SKILL.md')), 'the new install must be live at the destination');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: an unrecognized flag is rejected, never silently ignored', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--targt', 'skill'], home, project); // typo of --target
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'unknown-flag');
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run')), 'no mutation must occur for an unrecognized flag');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: a foreign (non-KRYLO) skill named krylo-run is never overwritten', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const foreignDir = path.join(home, '.agents', 'skills', 'krylo-run');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '---\nname: krylo-run\n---\nnot KRYLO\n', 'utf8');

    const dryRun = run(['--target', 'skill'], home, project);
    assert.equal(dryRun.json.skill.ok, false);
    assert.equal(dryRun.json.skill.error, 'foreign-skill');

    const applyRun = run(['--target', 'skill', '--apply'], home, project);
    assert.equal(applyRun.json.skill.ok, false);
    assert.equal(applyRun.status, 1);
    const content = fs.readFileSync(path.join(foreignDir, 'SKILL.md'), 'utf8');
    assert.equal(content, '---\nname: krylo-run\n---\nnot KRYLO\n', 'foreign content must be byte-for-byte untouched');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: re-applying over a KRYLO-owned install backs up the previous copy first (upgrade path)', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const first = run(['--target', 'skill', '--apply'], home, project);
    assert.equal(first.json.skill.applied, true);

    const second = run(['--target', 'skill', '--apply'], home, project);
    assert.equal(second.status, 0);
    assert.equal(second.json.skill.existing, 'krylo-owned');
    assert.ok(second.json.skill.backup, 'a backup path must be recorded for an upgrade');
    assert.ok(fs.existsSync(second.json.skill.backup), 'the backup directory must actually exist on disk');
    assert.ok(fs.existsSync(path.join(second.json.skill.backup, 'SKILL.md')));
    // The live install must still be present and valid after the upgrade.
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run', 'SKILL.md')));

    // The atomic stage-verify-swap must never leave a temp staging
    // directory behind, whether this was a fresh install or an upgrade.
    const skillsDir = path.join(home, '.agents', 'skills');
    const leftoverStaging = fs.readdirSync(skillsDir).filter((name) => name.includes('.new-'));
    assert.deepEqual(leftoverStaging, [], 'no .new-* staging directory should remain after a successful apply');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: idempotent -- applying twice in a row never errors and always leaves a valid install', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = run(['--target', 'skill', '--apply'], home, project);
      assert.equal(res.status, 0, `apply #${i + 1} must succeed`);
    }
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run', 'SKILL.md')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: --remove uninstalls only a KRYLO-owned skill, and refuses a foreign one', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    run(['--target', 'skill', '--apply'], home, project);
    const dryRemove = run(['--target', 'skill', '--remove'], home, project);
    assert.equal(dryRemove.json.skill.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run')), 'dry-run remove must not delete anything');

    const applyRemove = run(['--target', 'skill', '--remove', '--apply'], home, project);
    assert.equal(applyRemove.json.skill.applied, true);
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'krylo-run')), 'apply remove must actually delete the install');

    // Removing again (already absent) is a safe no-op, not an error.
    const removeAgain = run(['--target', 'skill', '--remove', '--apply'], home, project);
    assert.equal(removeAgain.json.skill.ok, true);
    assert.equal(removeAgain.json.skill.state, 'absent');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: rules target generates a project-scoped Starlark .rules file with the KRYLO ownership marker', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'rules', '--apply', '--project-dir', project], home, project);
    assert.equal(res.status, 0);
    assert.equal(res.json.rules.applied, true);
    const rulesFile = path.join(project, '.codex', 'rules', 'krylo.rules');
    assert.ok(fs.existsSync(rulesFile));
    const content = fs.readFileSync(rulesFile, 'utf8');
    assert.match(content, /krylo-rules-version:/);
    assert.match(content, /prefix_rule\(/);
    assert.match(content, /pattern = \["git", "push"\]/);
    assert.match(content, /decision = "prompt"/);

    // The write-then-rename must never leave a .new-* temp file behind.
    const rulesDir = path.join(project, '.codex', 'rules');
    const leftoverStaging = fs.readdirSync(rulesDir).filter((name) => name.includes('.new-'));
    assert.deepEqual(leftoverStaging, [], 'no .new-* temp file should remain after a successful rules apply');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('real Codex binary: the generated .rules file is genuinely valid Starlark that codex execpolicy check accepts, and produces "prompt" for the covered commands', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const res = run(['--target', 'rules', '--apply', '--project-dir', project], home, project);
    assert.equal(res.json.rules.applied, true);
    const rulesFile = path.join(project, '.codex', 'rules', 'krylo.rules');

    let versionCheck;
    try {
      versionCheck = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    } catch {
      versionCheck = null;
    }
    if (!versionCheck || versionCheck.status !== 0) {
      // Real Codex binary is not available on this machine/CI image -- skip
      // rather than fail the suite on an unrelated environment gap, same
      // convention as the real-Bash-fixture tests elsewhere in this repo.
      return;
    }

    const check = spawnSync('codex', ['-c', 'service_tier=flex', 'execpolicy', 'check', '--rules', rulesFile, '--', 'git', 'push', 'origin', 'main'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const parsed = JSON.parse(check.stdout);
    assert.equal(parsed.decision, 'prompt', 'the real Codex execpolicy engine must classify a covered command as prompt');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('install-codex: a foreign rules file at the same path is never overwritten', () => {
  const home = mkHome();
  const project = mkProject();
  try {
    const rulesDir = path.join(project, '.codex', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'krylo.rules'), '# hand-written, not KRYLO-owned\n', 'utf8');

    const res = run(['--target', 'rules', '--apply', '--project-dir', project], home, project);
    assert.equal(res.json.rules.ok, false);
    assert.equal(res.json.rules.error, 'foreign-rules-file');
    assert.equal(fs.readFileSync(path.join(rulesDir, 'krylo.rules'), 'utf8'), '# hand-written, not KRYLO-owned\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
