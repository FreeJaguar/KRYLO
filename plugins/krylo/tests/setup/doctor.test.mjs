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
    assert.equal(res.json.versions.krylo, '0.1.0');
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
