// Verifies the Item 4 hook-scoping decision (docs/adr/0021-hook-scoping-to-run-skill.md):
// per the current Claude Code hook schema, hooks declared in a Skill's own
// frontmatter run only while that skill is active and are cleaned up when it
// finishes; plugin-wide hooks/hooks.json runs for every ordinary session
// regardless of whether any KRYLO skill was invoked. KRYLO's six gate/
// telemetry hooks must live in the run skill's frontmatter, not plugin-wide,
// so an ordinary Claude Code session that never invokes /krylo:run launches
// zero KRYLO hook processes.
//
// What this test CAN prove deterministically: the wiring — hooks/hooks.json
// registers nothing plugin-wide, the run skill's frontmatter registers all
// six required events pointing at the real scripts, and no other KRYLO skill
// declares any interception hook. It cannot itself drive a live Claude Code
// session to observe zero process spawns outside a run — that guarantee
// rests on the documented platform behavior cited in the ADR.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function frontmatterBlock(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, `no frontmatter in ${file}`);
  return match[1];
}

const REQUIRED_EVENTS_AND_SCRIPTS = [
  ['PreToolUse', 'scripts/security/question-gate.mjs'],
  ['PreToolUse', 'scripts/security/risk-gate.mjs'],
  ['PostToolUse', 'scripts/runtime/posttool-telemetry.mjs'],
  ['PostToolUseFailure', 'scripts/orbit/fingerprint.mjs'],
  ['SubagentStart', 'scripts/status/agent-events.mjs'],
  ['SubagentStop', 'scripts/status/agent-events.mjs'],
  ['Stop', 'scripts/orbit/stop-gate.mjs'],
];

test('hooks/hooks.json registers no plugin-wide hooks', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooksConfig.hooks, {}, 'plugin-wide hooks.json must not intercept ordinary sessions');
});

test('the run skill frontmatter declares all six required hook events against real scripts', () => {
  const block = frontmatterBlock(path.join(PLUGIN_ROOT, 'skills', 'run', 'SKILL.md'));
  assert.match(block, /^hooks:\s*$/m, 'run skill must declare a hooks: key in its frontmatter');
  for (const [event, scriptRel] of REQUIRED_EVENTS_AND_SCRIPTS) {
    assert.match(block, new RegExp(`^\\s*${event}:`, 'm'), `run skill hooks must declare ${event}`);
    assert.ok(block.includes(scriptRel), `run skill hooks must reference ${scriptRel}`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, scriptRel)), `${scriptRel} referenced by the run skill must exist`);
  }
  // AskUserQuestion and the write-surface matcher (extended to MCP tools for Item 2) must both be present.
  assert.ok(block.includes('AskUserQuestion'));
  assert.ok(block.includes('Bash|Write|Edit|NotebookEdit|mcp__.*'));
});

test('no other KRYLO skill declares an interception hook', () => {
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  const others = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'run')
    .map((e) => e.name);
  assert.deepEqual(others.sort(), ['audit-tool', 'doctor', 'setup', 'status']);
  for (const skill of others) {
    const block = frontmatterBlock(path.join(skillsDir, skill, 'SKILL.md'));
    assert.ok(!/^hooks:/m.test(block), `${skill} must not declare hooks — only the run skill gates tool use`);
  }
});
