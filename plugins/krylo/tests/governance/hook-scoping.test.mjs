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
  assert.ok(block.includes('Bash|PowerShell|Write|Edit|NotebookEdit|Read|Glob|Grep|mcp__.*'));
});

test('no other KRYLO skill declares an interception hook', () => {
  // The Codex explicit-invocation Skill ('krylo-run') lives entirely
  // outside this directory (plugins/krylo/codex/skills/krylo-run, checked
  // by a separate test below) -- an independent review found a Claude-
  // shaped skill sitting inside Claude's own auto-discovered skills/ would
  // itself become a 6th, model-invocable Claude skill, a real Claude-side
  // regression (docs/adr/0029's second review round). So this directory
  // listing is never exempted for it.
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

// Task 9 (docs/process/MULTI_HOST_FOUNDATION_IMPLEMENTATION_PLAN.md): Tasks 2-8
// relocated Claude-specific interpretation into scripts/host/claude/** and
// extracted scripts/security/risk-policy.mjs out of risk-gate.mjs. Every one
// of the six required hook scripts must still resolve its Claude-payload
// normalization through the same real host adapter file, and risk-gate.mjs
// must still resolve its policy logic through the same real extracted file,
// proving none of those refactors left a hook silently importing a
// moved/renamed/missing module.
test('every required hook script imports the real Claude host-transport adapter, and risk-gate imports the real extracted risk policy', () => {
  const hostTransportRel = 'scripts/host/claude/hook-transport.mjs';
  const hostTransportAbs = path.join(PLUGIN_ROOT, hostTransportRel);
  assert.ok(fs.existsSync(hostTransportAbs), `${hostTransportRel} must exist`);

  const riskPolicyRel = 'scripts/security/risk-policy.mjs';
  const riskPolicyAbs = path.join(PLUGIN_ROOT, riskPolicyRel);
  assert.ok(fs.existsSync(riskPolicyAbs), `${riskPolicyRel} must exist`);

  const hostContextAbs = path.join(PLUGIN_ROOT, 'scripts', 'host', 'claude', 'context.mjs');
  assert.ok(fs.existsSync(hostContextAbs), 'scripts/host/claude/context.mjs must exist');

  const uniqueScripts = [...new Set(REQUIRED_EVENTS_AND_SCRIPTS.map(([, scriptRel]) => scriptRel))];
  for (const scriptRel of uniqueScripts) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, scriptRel), 'utf8');
    assert.match(
      source,
      /from ['"]\.\.\/host\/claude\/hook-transport\.mjs['"]/,
      `${scriptRel} must import the real host/claude/hook-transport.mjs adapter, not a moved or renamed path`,
    );
  }

  const riskGateSource = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'security', 'risk-gate.mjs'), 'utf8');
  assert.match(
    riskGateSource,
    /from ['"]\.\/risk-policy\.mjs['"]/,
    'risk-gate.mjs must import the real extracted ./risk-policy.mjs, not a moved or renamed path',
  );
});

// Superseded by the approved Codex Host checkpoint
// (docs/process/CODEX_HOST_IMPLEMENTATION_PLAN.md, docs/adr/0029-codex-host-packaging-and-approval-boundary.md):
// this test previously asserted NO Codex host adapter existed at all. It now
// asserts the narrower, still-load-bearing invariant ADR-0021 actually
// depends on: adding Codex support must not touch how Claude launches its
// OWN hooks. Claude's plugin-wide hooks/hooks.json must remain empty and
// Claude's run Skill must remain uncoupled from Codex, regardless of what
// the Codex host adapter/Skill/hooks file contain.
test('Codex host adapter is isolated from the Claude Skill-scoped hook design (ADR-0021 invariant preserved)', () => {
  const hostDir = path.join(PLUGIN_ROOT, 'scripts', 'host');
  const hostSubdirs = fs.existsSync(hostDir)
    ? fs.readdirSync(hostDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // scripts/host/cross-harness/ (docs/adr/0030-cross-harness-advisory-workers.md)
  // holds the two thin PROVIDER adapters used when the native host spawns
  // the OPPOSITE provider's CLI as an advisory worker -- a third directory
  // alongside claude/codex, not a replacement for either, and not itself a
  // native KRYLO host.
  assert.deepEqual(hostSubdirs.sort(), ['claude', 'codex', 'cross-harness'], 'both host adapters ship side by side, neither replacing the other, alongside the Cross-Harness provider adapters');

  const hooksConfigText = fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8');
  assert.doesNotMatch(hooksConfigText, /codex/i, 'Claude\'s plugin-wide hooks.json must remain empty and unaffected by Codex support (ADR-0021)');

  const skillText = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'run', 'SKILL.md'), 'utf8');
  // The original invariant here was "the Claude run skill must not
  // reference Codex at all" -- a proxy for "Claude/Codex host wiring stays
  // decoupled." docs/adr/0030-cross-harness-advisory-workers.md introduces
  // a deliberate, reviewed exception: the Skill's Cross-Harness section
  // legitimately names Codex once, as the opposite provider a Claude-native
  // run may spawn an advisory worker from -- that is the feature working
  // as designed, not coupling. What the invariant must still catch is any
  // BROADER reference (Codex-specific hook payload fields, session
  // handling, flags, etc. hardcoded into the Claude skill) -- so this now
  // asserts the mention is confined to exactly the Cross-Harness section
  // and stays at the single expected occurrence, not an unbounded/growing
  // coupling.
  const crossHarnessSection = /## Cross-Harness[\s\S]*?(?=\n## |$)/.exec(skillText)?.[0] ?? '';
  const outsideCrossHarness = skillText.replace(crossHarnessSection, '');
  assert.doesNotMatch(outsideCrossHarness, /codex/i, 'Codex must not be referenced anywhere in the Claude run skill outside the Cross-Harness section');
  assert.ok((crossHarnessSection.match(/codex/gi) || []).length <= 2, 'the Cross-Harness section must stay within its two expected Codex mentions (naming the opposite provider, and its availability caveat), not grow into broader coupling');

  // Codex's own hook registration must live in a SEPARATE file its manifest
  // explicitly points to, never falling back to (and therefore never risking
  // collision with) the auto-discovered hooks/hooks.json Claude also reads
  // by the same directory convention.
  const codexHooksPath = path.join(PLUGIN_ROOT, 'hooks', 'codex-hooks.json');
  assert.ok(fs.existsSync(codexHooksPath), 'Codex hook registrations must live in their own file, not the shared hooks/hooks.json');
  const codexPluginManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(codexPluginManifest.hooks, './hooks/codex-hooks.json', 'the Codex manifest must explicitly reference its own hooks file, not rely on auto-discovery of hooks/hooks.json');
});

// Independent review plus direct byte inspection of the installed
// codex-cli 0.120.0 binary (see docs/adr/0029's own review-finding
// addendum) found two build-specific facts codex-hooks.json must respect:
// (1) the binary's own embedded PreToolUse JSON schema constrains
// tool_name to the literal const "Bash" for every command-hook invocation
// -- a matcher that does not include "Bash" never fires on this build; (2)
// "PermissionRequest" is absent from the binary's own embedded
// HookEventNameWire enum entirely -- registering an event a build does not
// recognize risks the whole hooks file failing to parse, silently dropping
// PreToolUse/PostToolUse with it.
function readCodexHooks() {
  const codexHooksPath = path.join(PLUGIN_ROOT, 'hooks', 'codex-hooks.json');
  const raw = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
  return { raw, events: raw.hooks };
}

// Live smoke test against a real authenticated codex-cli 0.154.0 session
// (docs/adr/0035-codex-live-hook-verification.md) found this file's previous
// top-level shape was rejected outright by the current build:
//   "failed to parse plugin hooks config ...: unknown field `$comment`,
//    expected `description` or `hooks`"
// A rejected config is silently dropped IN FULL -- every registration,
// PreToolUse's risk gate included -- which is the exact fail-open outcome
// this file's own description warns about. Asserted structurally here so a
// future edit cannot reintroduce an unaccepted top-level key.
test('codex-hooks.json uses the top-level shape the real installed build accepts (description + hooks), never a flat event map or a $comment key', () => {
  const { raw } = readCodexHooks();
  assert.deepEqual(
    Object.keys(raw).sort(),
    ['description', 'hooks'],
    'codex-cli 0.154.0 accepts exactly `description` and `hooks` at the top level; any other key makes the WHOLE file fail to parse and every hook silently vanish',
  );
  assert.equal(typeof raw.description, 'string');
  assert.ok(raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks), 'events must nest under the `hooks` key');
});

// Same live smoke test, second confirmed defect: Codex performs its OWN
// ${PLUGIN_ROOT} templating and never invokes a shell, so the cmd.exe-style
// %PLUGIN_ROOT% form is passed through as a literal string. Windows prefers
// commandWindows when present, so every KRYLO hook resolved to a path
// literally named "%PLUGIN_ROOT%\..." and FAILED ("hook: UserPromptSubmit
// Failed" observed live) -- meaning KRYLO's Codex host had never actually
// run on Windows at all. Proven fix, verified live: use ${PLUGIN_ROOT} in
// commandWindows too.
test('codex-hooks.json never uses the cmd-style %PLUGIN_ROOT% form, which the real build passes through literally instead of expanding', () => {
  const { raw } = readCodexHooks();
  const serialized = JSON.stringify(raw);
  assert.doesNotMatch(serialized, /%PLUGIN_ROOT%/, 'Codex expands ${PLUGIN_ROOT} itself and never runs a shell -- %PLUGIN_ROOT% stays literal and every hook using it fails to launch');
  for (const [event, entries] of Object.entries(raw.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        for (const field of ['command', 'commandWindows']) {
          if (typeof hook[field] !== 'string') continue;
          assert.match(hook[field], /\$\{PLUGIN_ROOT\}/, `${event}.${field} must locate its script through the \${PLUGIN_ROOT} placeholder the build actually expands`);
        }
      }
    }
  }
});

test('codex-hooks.json matches the real installed binary\'s confirmed PreToolUse schema (tool_name const "Bash") and never registers an unconfirmed hook event', () => {
  const { events: codexHooks } = readCodexHooks();
  assert.match(codexHooks.PreToolUse[0].matcher, /(^|\|)Bash(\||$)/, 'the PreToolUse matcher must match the literal "Bash" tool_name real Codex builds send, not only speculative alternatives');
  assert.ok(!('PermissionRequest' in codexHooks), 'PermissionRequest must not be registered until a build confirmed to support that hook event is verified (absent from the installed 0.120.0 build\'s own HookEventNameWire enum)');
  // SessionEnd added to the confirmed set by docs/adr/0033-codex-lifecycle-enforcement.md:
  // its own input schema (session-end.command.input.schema.json) and Rust
  // handler (codex-rs/hooks/src/events/session_end.rs) were fetched and
  // read directly at the current stable tag (rust-v0.152.1), confirming
  // the event genuinely exists and is dispatched -- it simply has no
  // output schema at all (cannot return a decision), which is why
  // session-end-codex.mjs never attempts to emit one.
  const confirmedEvents = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop'];
  for (const registeredEvent of Object.keys(codexHooks)) {
    assert.ok(confirmedEvents.includes(registeredEvent), `${registeredEvent} is not in the installed build's own confirmed HookEventNameWire enum`);
  }
});

// docs/adr/0029's UserPromptSubmit-based host-authoritative session bootstrap
// (Section 12 correction): user-prompt-submit-codex.mjs is the ONLY place a
// KRYLO Codex run is created, and it must actually be registered against the
// confirmed-real UserPromptSubmit event, with no matcher (the official
// rust-v0.120.0 source calls dispatcher::select_handlers with
// matcher_input=None for this event -- no tool_name concept applies here).
test('codex-hooks.json registers the UserPromptSubmit host-authoritative session bootstrap with no matcher', () => {
  const { events: codexHooks } = readCodexHooks();
  assert.ok(Array.isArray(codexHooks.UserPromptSubmit) && codexHooks.UserPromptSubmit.length > 0, 'UserPromptSubmit must be registered');
  const entry = codexHooks.UserPromptSubmit[0];
  assert.ok(!('matcher' in entry), 'UserPromptSubmit has no tool_name to match against and must not declare a matcher');
  const commands = entry.hooks.map((h) => h.command).join(' ');
  assert.match(commands, /user-prompt-submit-codex\.mjs/, 'UserPromptSubmit must invoke the real host-authoritative bootstrap script');
  const scriptPath = path.join(PLUGIN_ROOT, 'scripts', 'security', 'user-prompt-submit-codex.mjs');
  assert.ok(fs.existsSync(scriptPath), 'scripts/security/user-prompt-submit-codex.mjs referenced by codex-hooks.json must exist');
});

test('/krylo:run remains user-invocable and not model-invocable', () => {
  const block = frontmatterBlock(path.join(PLUGIN_ROOT, 'skills', 'run', 'SKILL.md'));
  assert.match(block, /^user-invocable:\s*true\s*$/m, 'the run skill must remain user-invocable');
  assert.match(block, /^disable-model-invocation:\s*true\s*$/m, 'the run skill must keep disable-model-invocation: true');
});
