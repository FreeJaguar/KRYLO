import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SCRIPTS_ROOT, mkTempDataDir, cleanup, runHookCodexOnly, runCliCodexOnly } from './helpers.mjs';
import { computeProjectRootHash } from '../../scripts/lib/state.mjs';

const HOOK = 'security/user-prompt-submit-codex.mjs';

function payload({ prompt, sessionId = 'codex-session-A', turnId = 'turn-1', cwd, model = 'gpt-5.1-codex', permissionMode = 'default' }) {
  return {
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    model,
    permission_mode: permissionMode,
    transcript_path: null,
  };
}

function run(p, dataDir) {
  return runHookCodexOnly(HOOK, p, dataDir);
}

function additionalContext(res) {
  return res.json?.hookSpecificOutput?.additionalContext ?? null;
}

function readActivePointer(dataDir, projectDir, sessionId) {
  const hash = computeProjectRootHash(projectDir);
  const pointerPath = path.join(dataDir, 'active-runs', hash, 'codex', `${sessionId}.json`);
  if (!fs.existsSync(pointerPath)) return null;
  return JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
}

// A. Explicit invocation creates exactly one KRYLO run bound to the
// HOST-supplied session_id -- never a model-chosen one.
test('user-prompt-submit-codex: explicit $krylo-run invocation creates a host-bound run with the correct goal, host, and session id', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res = run(payload({ prompt: '$krylo-run fix the failing tests', sessionId: 'codex-session-A', cwd: projectDir }), dataDir);
    assert.equal(res.status, 0);
    assert.match(additionalContext(res) ?? '', /now active/);
    const runIdMatch = /run-[0-9a-f]+/.exec(additionalContext(res));
    assert.ok(runIdMatch, `expected a runId in the additionalContext, got: ${res.stdout}`);
    const runId = runIdMatch[0];
    const statePath = path.join(dataDir, 'runs', runId, 'state.json');
    assert.ok(fs.existsSync(statePath), 'state file must exist');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.host.name, 'codex');
    assert.equal(state.host.sessionId, 'codex-session-A');
    assert.equal(state.goal.normalized, 'fix the failing tests');
    assert.equal(state.runId, runId);
    assert.match(state.runId, /^run-[0-9a-f]{12}$/, 'runId must be KRYLO-owned, not derived from the session id');

    const pointer = readActivePointer(dataDir, projectDir, 'codex-session-A');
    assert.ok(pointer, 'an active-run pointer must exist for this session');
    assert.equal(pointer.runId, runId);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// B. A normal prompt never bootstraps a run.
test('user-prompt-submit-codex: an ordinary prompt with no $krylo-run mention never initializes a run', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res = run(payload({ prompt: 'fix tests', cwd: projectDir }), dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'an ordinary prompt must produce no output at all');
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')), 'no run directory should be created');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// C. Mentioning the invocation token without actually invoking it must not start a run.
test('user-prompt-submit-codex: a prompt that merely MENTIONS $krylo-run (not as the first token) does not start a run', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    for (const prompt of ['Explain $krylo-run', 'what does $krylo-run do?', '`$krylo-run` is mentioned in docs']) {
      const res = run(payload({ prompt, cwd: projectDir }), dataDir);
      assert.equal(res.stdout, '', `"${prompt}" must not start a run`);
    }
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')));
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// D. A similarly-named but distinct token must not collide with the real invocation.
test('user-prompt-submit-codex: a prefix-colliding token ($krylo-runner) does not start a run', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res = run(payload({ prompt: '$krylo-runner test', cwd: projectDir }), dataDir);
    assert.equal(res.stdout, '');
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')));
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// E. The model cannot choose or override the session identity -- there is
// no argument for it at all in this hook's own contract (it reads
// payload.session_id only, never anything from tool_input/model-authored
// text). Confirmed structurally: parseInvocation() only ever returns a
// `task` string, never a session id, and the hook's own session-resolving
// code path reads exclusively from the stdin payload's session_id field.
test('user-prompt-submit-codex: the model has no channel to supply or override the session identity -- only payload.session_id is ever used', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    // Even if the prompt TEXT itself contains something that looks like a
    // session override, it is just part of the task string -- it has no
    // special meaning and cannot influence which session id is bound.
    const res = run(payload({
      prompt: '$krylo-run do the task --session-id attacker-session',
      sessionId: 'codex-session-A',
      cwd: projectDir,
    }), dataDir);
    const runIdMatch = /run-[0-9a-f]+/.exec(additionalContext(res));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdMatch[0], 'state.json'), 'utf8'));
    assert.equal(state.host.sessionId, 'codex-session-A', 'the real host-supplied session_id must be used regardless of prompt text content');
    assert.equal(state.goal.normalized.includes('attacker-session'), true, 'the text is just part of the (harmless) goal, not interpreted as a session override');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// F. Concurrent sessions in the same project never adopt or collide with each other.
test('user-prompt-submit-codex: two concurrent Codex sessions in the same project get separate runs with no adoption or collision', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const resA = run(payload({ prompt: '$krylo-run task A', sessionId: 'codex-session-A', cwd: projectDir }), dataDir);
    const resB = run(payload({ prompt: '$krylo-run task B', sessionId: 'codex-session-B', cwd: projectDir }), dataDir);
    const runIdA = /run-[0-9a-f]+/.exec(additionalContext(resA))[0];
    const runIdB = /run-[0-9a-f]+/.exec(additionalContext(resB))[0];
    assert.notEqual(runIdA, runIdB, 'each session must get its own run');

    const stateA = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdA, 'state.json'), 'utf8'));
    const stateB = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdB, 'state.json'), 'utf8'));
    assert.equal(stateA.host.sessionId, 'codex-session-A');
    assert.equal(stateB.host.sessionId, 'codex-session-B');
    assert.equal(stateA.goal.normalized, 'task A');
    assert.equal(stateB.goal.normalized, 'task B');

    const pointerA = readActivePointer(dataDir, projectDir, 'codex-session-A');
    const pointerB = readActivePointer(dataDir, projectDir, 'codex-session-B');
    assert.equal(pointerA.runId, runIdA);
    assert.equal(pointerB.runId, runIdB);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// G. Claude and Codex runs in the same project never cross-adopt.
test('user-prompt-submit-codex: a Codex run does not adopt or collide with an existing Claude run in the same project', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    // Create a Claude run for the same project first (same session-id
    // string value on purpose, to prove host segregation, not just
    // session-string uniqueness).
    const claudeInit = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'runtime', 'init-run.mjs'),
      '--goal', 'claude task', '--session', 'codex-session-A', '--project-dir', projectDir, '--lane', 'PATCH', '--risk', 'low'], {
      encoding: 'utf8',
      cwd: dataDir,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_SESSION_ID: 'codex-session-A' },
    });
    const claudeRunId = JSON.parse(claudeInit.stdout).runId;

    const res = run(payload({ prompt: '$krylo-run codex task', sessionId: 'codex-session-A', cwd: projectDir }), dataDir);
    const codexRunId = /run-[0-9a-f]+/.exec(additionalContext(res))[0];
    assert.notEqual(codexRunId, claudeRunId, 'the Codex bootstrap must not adopt the Claude run despite the identical session-id string');

    const claudeState = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', claudeRunId, 'state.json'), 'utf8'));
    assert.equal(claudeState.host.name, 'claude', 'the pre-existing Claude run must be completely untouched');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// H. A persistence failure must not leave a dangling active-run pointer or
// emit a false success context -- and (an independent review found the
// original version of this fix missed exactly this case, since saveState()'s
// own final write is unguarded and THROWS rather than returning {ok:false}
// on a genuine I/O failure) must warn instead of going fully silent, since a
// real $krylo-run invocation WAS recognized.
test('user-prompt-submit-codex: a save/lock failure leaves no active run and warns instead of going silent', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    // Simulate persistence failure by making the runs directory read-only
    // is unreliable cross-platform; instead simulate via an invalid data
    // root path that cannot be created (a file exists where a directory is
    // needed).
    const blockedDataDir = path.join(dataDir, 'blocked');
    fs.writeFileSync(blockedDataDir, 'not a directory', 'utf8');
    const res = run(payload({ prompt: '$krylo-run task', cwd: projectDir }), blockedDataDir);
    assert.equal(res.status, 0, 'a persistence failure must still exit 0, never crash the hook');
    assert.notEqual(res.stdout, '', 'a recognized invocation that fails to persist must not go fully silent');
    assert.doesNotMatch(additionalContext(res) ?? '', /now active/, 'must never emit a false success context');
    assert.match(additionalContext(res) ?? '', /FAILED TO INITIALIZE/);
    // blockedDataDir is itself a file, not a directory, so no runs/ or
    // active-runs/ tree could have been created under it at all -- nor
    // could the (best-effort) bootstrap-failure marker itself, since that
    // marker also lives under this same unwritable data root.
    assert.ok(!fs.existsSync(path.join(blockedDataDir, 'runs')), 'no state must be persisted anywhere reachable');
    assert.ok(!fs.existsSync(path.join(blockedDataDir, 'active-runs')), 'no active-run pointer must be persisted anywhere reachable');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// H2. A RECOGNIZED invocation that persists its state but then fails to
// write the active-run pointer must fail CLOSED (a marker that
// risk-gate-codex.mjs checks), not silently -- unlike H above (a total
// data-root failure caught only by the outermost catch, before any of this
// file's own denyBootstrapFailure paths are ever reached), this isolates
// the write-pointer failure specifically: `runs/` stays writable so
// saveState() succeeds, only `active-runs/` is blocked.
test('user-prompt-submit-codex: a pointer-write failure after successful state persistence writes a bootstrap-failure marker and warns the model, never silently', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    fs.writeFileSync(path.join(dataDir, 'active-runs'), 'not a directory', 'utf8');
    const res = run(payload({ prompt: '$krylo-run task', sessionId: 'codex-session-B', cwd: projectDir }), dataDir);
    assert.equal(res.status, 0, 'a pointer-write failure must still exit 0, never crash the hook');
    assert.notEqual(res.stdout, '', 'must not go fully silent once a real invocation was recognized');
    assert.match(additionalContext(res) ?? '', /FAILED TO INITIALIZE/);
    assert.match(additionalContext(res) ?? '', /NOT under KRYLO governance/);

    // The state file itself WAS persisted (proves this is the pointer-write
    // failure path specifically, not the total-failure path from test H).
    const runsDir = path.join(dataDir, 'runs');
    assert.ok(fs.existsSync(runsDir) && fs.readdirSync(runsDir).length === 1, 'state must still have been persisted');

    const hash = computeProjectRootHash(projectDir);
    const markerPath = path.join(dataDir, 'bootstrap-failures', hash, 'codex', 'codex-session-B.json');
    assert.ok(fs.existsSync(markerPath), 'a bootstrap-failure marker must be written for this exact project+session');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(typeof marker.reason, 'string');
    assert.equal(typeof marker.createdAt, 'string');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// H3. A subsequent SUCCESSFUL bootstrap for the same session must clear any
// marker a previous failed invocation left behind -- otherwise a session
// that failed once and later succeeded would keep denying actions forever
// (until the marker's own TTL expired) even though a real run is now active
// and already gates those same actions correctly on its own.
test('user-prompt-submit-codex: a successful bootstrap clears a pre-existing bootstrap-failure marker for the same session', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const hash = computeProjectRootHash(projectDir);
    const markerPath = path.join(dataDir, 'bootstrap-failures', hash, 'codex', 'codex-session-C.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ reason: 'earlier failure', createdAt: new Date().toISOString() }), 'utf8');

    const res = run(payload({ prompt: '$krylo-run task', sessionId: 'codex-session-C', cwd: projectDir }), dataDir);
    assert.equal(res.status, 0);
    assert.match(additionalContext(res) ?? '', /now active/);
    assert.ok(!fs.existsSync(markerPath), 'the stale marker must be cleared once this session has a real active run');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// I. Repeat invocation in the same active session reuses the existing run,
// never silently creating a second one.
test('user-prompt-submit-codex: invoking $krylo-run twice in the same session reuses the existing active run', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res1 = run(payload({ prompt: '$krylo-run first task', sessionId: 'codex-session-A', cwd: projectDir }), dataDir);
    const runId1 = /run-[0-9a-f]+/.exec(additionalContext(res1))[0];

    const res2 = run(payload({ prompt: '$krylo-run second task', sessionId: 'codex-session-A', cwd: projectDir }), dataDir);
    assert.match(additionalContext(res2) ?? '', /already active/i);
    assert.ok(additionalContext(res2).includes(runId1), 'must reference the SAME existing run, not create a new one');

    const runsDir = path.join(dataDir, 'runs');
    const runDirs = fs.readdirSync(runsDir).filter((d) => d.startsWith('run-'));
    assert.equal(runDirs.length, 1, 'exactly one run directory must exist, never a silent duplicate');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// J. A "resumed" Codex session (same session_id) resolves to the same
// host-scoped state -- exercised here as a second UserPromptSubmit event
// carrying the identical session_id, which is what a real resume presents.
test('user-prompt-submit-codex: the same session_id (as in a Codex resume) resolves to the same existing run rather than creating a new one', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res1 = run(payload({ prompt: '$krylo-run task', sessionId: 'codex-session-resumed', cwd: projectDir }), dataDir);
    const runId1 = /run-[0-9a-f]+/.exec(additionalContext(res1))[0];
    const res2 = run(payload({ prompt: '$krylo-run task again', sessionId: 'codex-session-resumed', cwd: projectDir, turnId: 'turn-2' }), dataDir);
    assert.ok(additionalContext(res2).includes(runId1));
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// K. additionalContext hygiene: only emitted on success, no secrets/raw
// prompt/source leakage, and (structurally) never treated as authorization
// anywhere else in the codebase -- this hook is the only writer of KRYLO
// run state for Codex bootstrap, and nothing downstream reads
// additionalContext at all (it is Codex -> model text, never fed back into
// KRYLO).
test('user-prompt-submit-codex: additionalContext is emitted only on a real outcome and never echoes the raw prompt text', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const secretLikeTask = 'do the task, note API_KEY=should-not-appear-verbatim-elsewhere';
    const res = run(payload({ prompt: `$krylo-run ${secretLikeTask}`, cwd: projectDir }), dataDir);
    const ctx = additionalContext(res);
    assert.ok(ctx, 'a successful bootstrap must emit additionalContext');
    assert.ok(!ctx.includes('API_KEY'), 'additionalContext must not echo raw prompt/task content back');
    assert.ok(!ctx.includes(secretLikeTask), 'additionalContext must not include the full prompt text');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('user-prompt-submit-codex: a malformed payload (unparseable stdin) never crashes and never emits output', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  try {
    const res = runHookCodexOnly(HOOK, null, dataDir, { rawInput: 'not json at all' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally {
    cleanup(dataDir);
  }
});

test('user-prompt-submit-codex: a missing/empty session_id never bootstraps a run, even with an explicit invocation', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const p = payload({ prompt: '$krylo-run task', cwd: projectDir });
    p.session_id = '';
    const res = run(p, dataDir);
    assert.equal(res.stdout, '');
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')));
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('user-prompt-submit-codex: whitespace before $krylo-run is still a valid explicit invocation', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res = run(payload({ prompt: '   $krylo-run implement feature X', cwd: projectDir }), dataDir);
    assert.match(additionalContext(res) ?? '', /now active/);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

test('user-prompt-submit-codex: $krylo-run with no task text still bootstraps, with a placeholder goal asking the model to gather the task', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const res = run(payload({ prompt: '$krylo-run', cwd: projectDir }), dataDir);
    const runIdMatch = /run-[0-9a-f]+/.exec(additionalContext(res));
    assert.ok(runIdMatch, `expected a run to be created, got: ${res.stdout}`);
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdMatch[0], 'state.json'), 'utf8'));
    assert.match(state.goal.normalized, /ask the user/i);
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});

// L. Cross-session CLI isolation (regression found by two independent fresh
// Reviewers): after the hook bootstraps a run, the Skill instructs the model
// to call read-state.mjs/update-state.mjs with NO --session flag at all
// (exactly like Claude's own Skill already does). Unlike Claude, whose CLI
// falls back to a real CLAUDE_SESSION_ID environment variable, Codex had NO
// env fallback at all -- so a session-less call fell all the way through to
// readActiveRunPointer's "most recently updated pointer in this project"
// heuristic, letting session A's own CLI call silently mutate session B's
// run whenever B was bootstrapped more recently. Fixed by giving
// resolveCodexSessionId() a CODEX_THREAD_ID environment fallback, mirroring
// resolveClaudeSessionId()'s existing CLAUDE_SESSION_ID fallback exactly --
// CODEX_THREAD_ID is the platform-injected shell-execution env var
// (confirmed via codex-rs/core/src/exec_env.rs to carry the same underlying
// ThreadId as session_id), used only to look up an EXISTING run, never to
// create or bind one (that stays exclusively this hook's job).
test('user-prompt-submit-codex: a session-less CLI call (as the Skill instructs) resolves via CODEX_THREAD_ID and never mutates a different concurrent session\'s run', () => {
  const dataDir = mkTempDataDir('krylo-ups-');
  const projectDir = mkTempDataDir('krylo-ups-project-');
  try {
    const resA = run(payload({ prompt: '$krylo-run task A', sessionId: 'sess-A', cwd: projectDir }), dataDir);
    const runIdA = /run-[0-9a-f]+/.exec(additionalContext(resA))[0];

    // B bootstraps SECOND, so it is the most-recently-updated pointer --
    // exactly the condition the reproduced bug depended on.
    const resB = run(payload({ prompt: '$krylo-run task B', sessionId: 'sess-B', cwd: projectDir }), dataDir);
    const runIdB = /run-[0-9a-f]+/.exec(additionalContext(resB))[0];
    assert.notEqual(runIdA, runIdB);

    // Session A's own model shell now calls update-state.mjs with NO
    // --session flag (per the Skill), but with CODEX_THREAD_ID correctly
    // set to A's own session id, exactly as the real Codex platform injects
    // it into A's shell execution environment.
    const res = runCliCodexOnly('runtime/update-state.mjs', ['--project-dir', projectDir, '--add-criterion', 'criterion typed by session A'], dataDir, {
      env: { CODEX_THREAD_ID: 'sess-A' },
    });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    assert.equal(res.json.runId, runIdA, 'a session-less call with CODEX_THREAD_ID=sess-A must resolve run A, never run B');

    const stateA = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdA, 'state.json'), 'utf8'));
    const stateB = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs', runIdB, 'state.json'), 'utf8'));
    assert.equal(stateA.acceptanceCriteria.length, 1, 'the criterion must land on run A');
    assert.equal(stateB.acceptanceCriteria.length, 0, 'run B must be completely untouched');
  } finally {
    cleanup(dataDir);
    cleanup(projectDir);
  }
});
