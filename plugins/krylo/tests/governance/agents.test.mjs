// Agent-system boundaries (Milestone 3 acceptance): twelve agents, portable
// model aliases only, read-only roles carry no Write or Edit, Builder is the
// single normal writer, and every skill stays manual-invocation only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, `no frontmatter in ${file}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const EXPECTED_AGENTS = [
  'scout', 'builder', 'verifier', 'reviewer', 'security-reviewer', 'architect',
  'design-reviewer', 'product-strategist', 'migration-reviewer', 'ai-eval-engineer',
  'performance-reviewer', 'deep-debugger',
];

test('exactly the twelve planned agents exist', () => {
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  assert.deepEqual(files.sort(), [...EXPECTED_AGENTS].sort());
});

test('only the Builder holds Write/Edit; models are portable aliases; unsupported frontmatter absent', () => {
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  for (const name of EXPECTED_AGENTS) {
    const fields = frontmatter(path.join(agentsDir, `${name}.md`));
    const tools = (fields.tools ?? '').split(',').map((t) => t.trim());
    if (name === 'builder') {
      assert.ok(tools.includes('Write') && tools.includes('Edit'), 'builder must be the writer');
    } else {
      assert.ok(!tools.includes('Write') && !tools.includes('Edit'), `${name} must not have Write/Edit`);
    }
    assert.ok(['haiku', 'sonnet', 'opus'].includes(fields.model), `${name} must use a portable alias, got ${fields.model}`);
    for (const forbidden of ['permissionMode', 'hooks', 'mcpServers']) {
      assert.ok(!(forbidden in fields), `${name} declares unsupported field ${forbidden}`);
    }
  }
});

test('all five Claude skills are manual-invocation only', () => {
  // Excludes 'krylo-run' (the Codex Skill, docs/adr/0029-codex-host-packaging-and-approval-boundary.md):
  // Codex SKILL.md frontmatter does not document disable-model-invocation/
  // user-invocable fields at all -- Codex's own implicit-invocation control
  // is a separate agents/openai.yaml file, checked by the test below.
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'krylo-run')
    .map((e) => e.name);
  assert.deepEqual(skills.sort(), ['audit-tool', 'doctor', 'run', 'setup', 'status']);
  for (const skill of skills) {
    const fields = frontmatter(path.join(skillsDir, skill, 'SKILL.md'));
    assert.equal(fields['disable-model-invocation'], 'true', `${skill} must not be model-invocable`);
    assert.equal(fields['user-invocable'], 'true', `${skill} must be user-invocable`);
  }
});

test('the Codex krylo-run skill disables implicit invocation via agents/openai.yaml', () => {
  const yamlPath = path.join(PLUGIN_ROOT, 'skills', 'krylo-run', 'agents', 'openai.yaml');
  const text = fs.readFileSync(yamlPath, 'utf8');
  assert.match(text, /allow_implicit_invocation:\s*false/, 'krylo-run must disable implicit invocation, same explicit-only guarantee as the Claude run skill');
  const skillFields = frontmatter(path.join(PLUGIN_ROOT, 'skills', 'krylo-run', 'SKILL.md'));
  assert.equal(skillFields.name, 'krylo-run');
  assert.ok(typeof skillFields.description === 'string' && skillFields.description.length > 0);
});

test('no plugin settings.json ships while the CLI floor is below 2.1.207 (ADR-0016)', () => {
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, 'settings.json')));
});
