// Markdown documents explain intent; JSON files drive deterministic
// decisions. These tests verify the two remain consistent (plugin/policies
// README rule) and that every policy artifact stays structurally sound.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENUMS } from '../../scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8'));
}

test('production-policy approval classes are valid state actionClass values with compiling patterns', () => {
  const policy = readJson('policies/production-policy.json');
  for (const [className, cls] of Object.entries(policy.approvalClasses)) {
    assert.ok(ENUMS.actionClass.includes(className), `approval class ${className} missing from run-state actionClass enum`);
    assert.ok(typeof cls.reason === 'string' && cls.reason.length > 0);
    for (const pattern of cls.patterns) {
      assert.doesNotThrow(() => new RegExp(pattern, 'i'), `pattern does not compile: ${pattern}`);
    }
  }
  for (const pattern of policy.sensitivePaths.patterns) {
    assert.doesNotThrow(() => new RegExp(pattern, 'i'), `sensitive pattern does not compile: ${pattern}`);
  }
  assert.equal(policy.failMode, 'fail-safe');
  assert.equal(policy.inactiveRunBehavior, 'allow');
});

test('environment profiles and catalog allowedProfiles agree', () => {
  const profiles = Object.keys(readJson('policies/environment-profiles.json').profiles);
  assert.deepEqual(profiles.sort(), ['local-only', 'private-approved', 'production-read-only', 'public-repository']);
  const catalog = readJson('catalog/tools.json');
  for (const tool of catalog.tools) {
    for (const p of tool.allowedProfiles ?? []) {
      assert.ok(profiles.includes(p), `${tool.id} references unknown profile ${p}`);
    }
  }
});

test('every catalog record satisfies the tool-record schema required fields and enums', () => {
  const schema = readJson('schemas/tool-record.schema.json');
  const catalog = readJson('catalog/tools.json');
  const tierEnum = schema.properties.trustTier.enum;
  const categoryEnum = schema.properties.category.enum;
  for (const tool of catalog.tools) {
    for (const req of schema.required) {
      assert.ok(req in tool, `${tool.id ?? '(no id)'} missing required field ${req}`);
    }
    assert.ok(tierEnum.includes(tool.trustTier), `${tool.id} has invalid tier ${tool.trustTier}`);
    assert.ok(categoryEnum.includes(tool.category), `${tool.id} has invalid category ${tool.category}`);
  }
});

test('question categories in run skill guidance match the state enum', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'run', 'SKILL.md'), 'utf8');
  for (const category of ENUMS.questionCategory) {
    assert.ok(skill.includes(category), `run skill does not document question category ${category}`);
  }
});

test('evals.json parses and references only known lanes and terminal states', () => {
  const evals = readJson('evals/evals.json');
  assert.ok(evals.scenarios.length >= 11);
  for (const s of evals.scenarios) {
    const lanes = [].concat(s.expected.lane ?? []);
    for (const lane of lanes) assert.ok(ENUMS.lane.includes(lane), `${s.id}: unknown lane ${lane}`);
    const terminals = [].concat(s.expected.terminalState ?? []);
    for (const t of terminals) assert.ok(ENUMS.terminalState.includes(t), `${s.id}: unknown terminal state ${t}`);
  }
});

test('hooks.json references only scripts that exist', () => {
  const hooks = readJson('hooks/hooks.json');
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/(.+\.mjs)/.exec(hook.command);
        assert.ok(match, `hook command has no plugin-root script: ${hook.command}`);
        const scriptPath = path.join(PLUGIN_ROOT, ...match[1].split('/'));
        assert.ok(fs.existsSync(scriptPath), `hook script missing: ${match[1]}`);
      }
    }
  }
});
