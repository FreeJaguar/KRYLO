// Tests for the optional external-capability adapters added in the KRYLO
// external-adapter integration pass (mattpocock/skills, OmniRoute,
// code-review-graph). Covers: catalog identity, alias resolution (exact
// match only, never substring), version-drift refusal, doctor detection
// (read-only, absent-by-default, no crash), and the production-policy
// external-write gate for install/start/apply-shaped Bash commands.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SCRIPTS_ROOT } from '../hooks/helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_TOOL = path.join(SCRIPTS_ROOT, 'audit', 'audit-tool.mjs');
const DOCTOR = path.join(SCRIPTS_ROOT, 'setup', 'doctor.mjs');

const REVIEWED = {
  'mattpocock-skills': '2ab958093e83e0ec752e6c1c5932da465bf23e0c',
  omniroute: '3.8.49',
  'code-review-graph': '9445a1a086a6e827b404e0c91309ced780fbd627',
};

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runAudit(args) {
  const res = spawnSync(process.execPath, [AUDIT_TOOL, ...args, '--json'], { encoding: 'utf8' });
  return { status: res.status, json: JSON.parse(res.stdout) };
}

function runDoctor(dataDir, home) {
  const res = spawnSync(process.execPath, [DOCTOR, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, KRYLO_TEST_HOME: home },
  });
  return { status: res.status, json: JSON.parse(res.stdout) };
}

test('catalog: mattpocock-skills, omniroute, and code-review-graph are present with the exact reviewed identity', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'tools.json'), 'utf8'));
  for (const [id, reviewedVersion] of Object.entries(REVIEWED)) {
    const record = catalog.tools.find((t) => t.id === id);
    assert.ok(record, `${id} must be in the catalog`);
    assert.equal(record.reviewedVersion, reviewedVersion);
    assert.equal(record.installationPolicy, 'user-approved');
  }
});

test('audit-tool: exact reviewed identity for each adapter resolves to a real tier verdict, not unreviewed', () => {
  for (const [id, version] of Object.entries(REVIEWED)) {
    const { status, json } = runAudit(['--target', id, '--version', version]);
    assert.equal(status, 0);
    assert.match(json.verdict, /^tier-/, `${id}@${version} should be a reviewed tier verdict, got ${json.verdict}`);
  }
});

test('audit-tool: repository URL and owner/repo aliases resolve to the same catalog identity as the canonical id', () => {
  const variants = [
    ['https://github.com/mattpocock/skills', 'mattpocock-skills'],
    ['mattpocock/skills', 'mattpocock-skills'],
    ['https://github.com/diegosouzapw/OmniRoute', 'omniroute'],
    ['diegosouzapw/omniroute', 'omniroute'],
    ['https://github.com/tirth8205/code-review-graph', 'code-review-graph'],
    ['tirth8205/code-review-graph', 'code-review-graph'],
  ];
  for (const [alias, canonical] of variants) {
    const a = runAudit(['--target', alias]);
    const b = runAudit(['--target', canonical]);
    assert.equal(a.json.identity.name, canonical, `${alias} must resolve to ${canonical}`);
    assert.deepEqual(a.json.registry, b.json.registry, `${alias} and ${canonical} must produce the same registry verdict`);
  }
});

test('audit-tool: a look-alike name that merely contains a known alias is never resolved to it (no substring matching)', () => {
  const lookalikes = [
    'https://github.com/some-random/lookalike-omniroute',
    'not-mattpocock/skills-fork',
    'evil-code-review-graph-clone',
  ];
  for (const name of lookalikes) {
    const { json } = runAudit(['--target', name]);
    assert.notEqual(json.registry.verdict, 'tier-B', `${name} must not inherit a reviewed tier`);
    assert.notEqual(json.registry.verdict, 'tier-B+', `${name} must not inherit a reviewed tier`);
    assert.equal(json.registry.verdict, 'unreviewed-no-automatic-use');
  }
});

test('audit-tool: JavaScript Object.prototype property names never resolve as a catalog alias', () => {
  // Regression for an independent-review finding: a plain object literal
  // used as a lookup table can return an inherited Object.prototype member
  // (e.g. "constructor", "toString") for a key it never explicitly
  // declared. resolveCatalogAlias must use an own-property check so a
  // --target of "constructor" is treated as an unknown name, not resolved
  // to some prototype value.
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const { json } = runAudit(['--target', name]);
    assert.equal(json.identity.name, name, `${name} must pass through unresolved, not be treated as a catalog alias`);
    assert.equal(json.registry.verdict, 'unreviewed-no-automatic-use');
  }
});

test('audit-tool: a version/commit that differs from the reviewed identity is never automatically trusted', () => {
  const driftCases = [
    ['omniroute', '999.0.0'],
    ['mattpocock-skills', '0000000000000000000000000000000000000'],
    ['code-review-graph', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
  ];
  for (const [id, driftedVersion] of driftCases) {
    const { json } = runAudit(['--target', id, '--version', driftedVersion]);
    assert.equal(json.registry.verdict, 'unreviewed-no-automatic-use');
    assert.match(json.registry.reason, /not automatically trusted/);
  }
});

test('doctor: all three adapters report a structured absent/present result and never crash when absent', () => {
  const dataDir = mkTempDir('krylo-ext-adapters-data-');
  const home = mkTempDir('krylo-ext-adapters-home-');
  try {
    const { status, json } = runDoctor(dataDir, home);
    assert.equal(status, 0);
    for (const id of ['omniroute', 'code-review-graph', 'mattpocock-skills']) {
      assert.ok(id in json.adapters, `doctor must report an entry for ${id}`);
      assert.equal(typeof json.adapters[id].detected, 'boolean');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: mattpocock-skills detection is a read-only settings.json check, and reports true only when actually enabled', () => {
  const dataDir = mkTempDir('krylo-ext-adapters-data-');
  const home = mkTempDir('krylo-ext-adapters-home-');
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'mattpocock-skills@some-marketplace': true } }),
      'utf8',
    );
    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');

    const { json } = runDoctor(dataDir, home);
    assert.equal(json.adapters['mattpocock-skills'].detected, true);

    const after = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    assert.equal(before, after, 'doctor must never modify settings.json');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: a malformed settings.json fails soft to "not detected" instead of crashing', () => {
  const dataDir = mkTempDir('krylo-ext-adapters-data-');
  const home = mkTempDir('krylo-ext-adapters-home-');
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not valid json', 'utf8');
    const { status, json } = runDoctor(dataDir, home);
    assert.equal(status, 0);
    assert.equal(json.adapters['mattpocock-skills'].detected, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('production-policy: external-write gates omniroute install/start and code-review-graph apply/serve, but not benign commands', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policies', 'production-policy.json'), 'utf8'));
  const patterns = policy.approvalClasses['external-write'].patterns.map((p) => new RegExp(p, 'i'));
  const matches = (cmd) => patterns.some((re) => re.test(cmd));

  for (const cmd of [
    'npm install -g omniroute',
    'pnpm add -g omniroute@latest',
    'omniroute start',
    'omniroute-reset-password',
    'docker run -d --name omniroute diegosouzapw/omniroute:latest',
    'uvx code-review-graph serve',
    'code-review-graph apply --id 42',
    // Regression cases from independent security review: common equivalent
    // install/run forms that the first version of this pattern set missed.
    'npm i -g omniroute',
    'npx omniroute@latest',
    'bunx omniroute',
    'pip install code-review-graph',
    'pipx install code-review-graph',
    'uv tool install code-review-graph',
    'paru -S omniroute-bin',
    'pacman -S omniroute-bin',
  ]) {
    assert.ok(matches(cmd), `expected external-write to gate: ${cmd}`);
  }

  for (const cmd of [
    'npm install lodash',
    'git status',
    'code-review-graph --help',
    'npm test',
  ]) {
    assert.ok(!matches(cmd), `expected external-write to NOT gate benign command: ${cmd}`);
  }
});

test('production-policy: external-write patterns have no catastrophic-backtracking blowup on long input', () => {
  // Regression for an independent-review finding: an earlier version of
  // these patterns used two adjacent unbounded lazy quantifiers separated
  // by an optional group, which was quadratic in input length (~2.4s at
  // 80KB). Every gap is now a bounded repetition, so a long adversarial
  // Bash command (e.g. from a prompt-injected huge argument) must still
  // evaluate in well under the hook's own timeout, regardless of length.
  const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policies', 'production-policy.json'), 'utf8'));
  const patterns = policy.approvalClasses['external-write'].patterns.map((p) => new RegExp(p, 'i'));
  const hostile = `npm install ${'a'.repeat(200000)}`;
  const start = Date.now();
  for (const re of patterns) re.test(hostile);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `external-write patterns took ${elapsedMs}ms against a 200KB adversarial command; expected well under 1000ms`);
});
