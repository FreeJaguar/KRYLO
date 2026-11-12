import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SCRIPTS_ROOT } from '../hooks/helpers.mjs';

function runDoctor(dataDir, home, args = ['--json']) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'setup', 'doctor.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_TEST_HOME: home },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* noop */ }
  return { status: res.status, stdout: res.stdout, json };
}

function runDoctorAsCodex(dataDir, home, args = ['--json']) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'setup', 'doctor.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: path.resolve(SCRIPTS_ROOT, '..'), KRYLO_TEST_HOME: home },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* noop */ }
  return { status: res.status, stdout: res.stdout, json };
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      out.push(path.relative(dir, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join('\n');
}

test('doctor: healthy environment -> exit 0, correct inventory, read-only', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  try {
    const homeBefore = snapshot(home);

    const res = runDoctor(dataDir, home);
    assert.equal(res.status, 0, res.stdout);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.versions.krylo, '0.3.0');
    // 5, not 6: the Codex Skill (krylo-run) lives at codex/skills/krylo-run,
    // deliberately outside Claude's own auto-discovered skills/ directory
    // this doctor scan counts -- an independent review found it would
    // otherwise become a 6th, model-invocable Claude skill, a real
    // Claude-side regression (docs/adr/0029's second review round).
    assert.equal(res.json.components.skills, 5);
    assert.equal(res.json.components.agents, 12);
    assert.equal(res.json.components.hooksHealthy, true);
    assert.equal(res.json.storage.writable, true);
    assert.equal(res.json.alias.state, 'absent');

    // Read-only guarantee: home untouched; data dir may only gain empty parents from the removed probe.
    assert.equal(snapshot(home), homeBefore, 'doctor must not modify the user home');
    assert.ok(!fs.existsSync(path.join(dataDir, '.doctor-probe')), 'doctor probe must be cleaned up');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: reports foreign alias and conflicting orchestrators', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  try {
    const aliasDir = path.join(home, '.claude', 'skills', 'krylo');
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, 'SKILL.md'), '---\nname: krylo\n---\nnot ours', 'utf8');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'ralph-loop'), { recursive: true });

    const res = runDoctor(dataDir, home);
    assert.equal(res.json.alias.state, 'foreign');
    assert.deepEqual(res.json.conflictingOrchestrators, ['ralph-loop']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: under a Codex-shaped environment, storage tracks the Codex data root, not Claude\'s', () => {
  const codexDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-codexdata-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  try {
    const res = runDoctorAsCodex(codexDataDir, home);
    assert.equal(res.status, 0, res.stdout);
    assert.equal(res.json.host, 'codex');
    assert.equal(res.json.storage.host, 'codex');
    assert.equal(res.json.storage.writable, true);
    // Pin down the actual bug this fix closes, not just the label: an
    // independent review found the original version of this test asserted
    // storage.host === 'codex' (which merely echoes the detectHost() value
    // passed in) without ever confirming storage.dataRoot itself resolved
    // under the Codex data dir rather than a Claude default -- codexDataDir
    // is outside $HOME, so redactText() will not mask it here.
    assert.ok(
      res.json.storage.dataRoot.includes(path.basename(codexDataDir)),
      `storage.dataRoot must resolve under the Codex data dir, got: ${res.json.storage.dataRoot}`,
    );
    // otherHostStorage must describe Claude's own default root, informational
    // only (no write probe -- this test never grants doctor a Claude data
    // root override, so a write attempt there would escape the isolated dirs).
    assert.equal(res.json.otherHostStorage.host, 'claude');
    assert.ok(
      !res.json.otherHostStorage.dataRoot.includes(path.basename(codexDataDir)),
      'otherHostStorage must never echo the active (Codex) data root',
    );
    assert.equal(res.json.codexComponents.hooksHealthy, true);
    assert.equal(res.json.codexSkill.state, 'absent');
  } finally {
    fs.rmSync(codexDataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: default (Claude-shaped) environment reports host claude and a codex otherHostStorage entry', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  try {
    const res = runDoctor(dataDir, home);
    assert.equal(res.json.host, 'claude');
    assert.equal(res.json.storage.host, 'claude');
    assert.equal(res.json.otherHostStorage.host, 'codex');
    assert.equal(typeof res.json.otherHostStorage.exists, 'boolean');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: reports an installed Codex krylo-run skill and a foreign one', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  try {
    const res1 = runDoctor(dataDir, home);
    assert.equal(res1.json.codexSkill.state, 'absent');

    const codexSkillDir = path.join(home, '.agents', 'skills', 'krylo-run');
    fs.mkdirSync(codexSkillDir, { recursive: true });
    fs.writeFileSync(path.join(codexSkillDir, 'SKILL.md'), '---\nname: krylo-run\n---\nnot ours', 'utf8');
    const res2 = runDoctor(dataDir, home);
    assert.equal(res2.json.codexSkill.state, 'foreign');

    fs.writeFileSync(path.join(codexSkillDir, 'SKILL.md'), '---\nname: krylo-run\n---\nours\n<!-- krylo-codex-skill-version: 0.2.0 -->\n', 'utf8');
    const res3 = runDoctor(dataDir, home);
    assert.equal(res3.json.codexSkill.state, 'krylo-owned');
    assert.equal(res3.json.codexSkill.version, '0.2.0');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: unwritable storage -> exit 1 with remediation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-doc-home-'));
  const blocker = path.join(home, 'blocker-file');
  fs.writeFileSync(blocker, 'x', 'utf8');
  try {
    // A path under an existing FILE can never become a directory on any OS.
    const res = runDoctor(path.join(blocker, 'sub'), home);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.problems.some((p) => p.severity === 'critical' && /not writable/.test(p.problem)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
