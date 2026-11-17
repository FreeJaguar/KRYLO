// docs/adr/0046-unreadable-state-followups-and-lock-deadline.md, decision 2:
// the failure-fingerprint hook (PostToolUseFailure) and the agent-event hook
// (SubagentStart/SubagentStop) must not drop a mutation silently when they
// cannot re-read or save the run state under the lock. They record a
// distinct `*-not-persisted` telemetry event whose `status` names the cause,
// the same way posttool-telemetry records `counter-not-persisted`
// (ADR-0045, decision 6). They stay fail-open: exit 0, no output, never a
// decision. Before ADR-0046 both hooks returned with nothing recorded.
//
// The fault is injected with the test-only --import preload
// tests/fixtures/state-io/fail-state-rereads.mjs: the first N reads of
// state.json succeed (N = KRYLO_TEST_STATE_READS_BEFORE_FAULT) and every later
// one fails with EISDIR. Each test asserts that the fault actually fired.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkTempDataDir, createActiveRun, runHook, readState, cleanup } from './helpers.mjs';
import { recordFailureFingerprint } from '../../scripts/orbit/fingerprint.mjs';
import { recordAgentEvent } from '../../scripts/status/agent-events.mjs';
import { runLockPath } from '../../scripts/lib/paths.mjs';

const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'state-io', 'fail-state-rereads.mjs');
const FINGERPRINT = 'orbit/fingerprint.mjs';
const AGENT_EVENTS = 'status/agent-events.mjs';

function faultEnv(dataDir, readsBeforeFault) {
  const log = path.join(dataDir, 'injected-faults.log');
  return {
    log,
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
      KRYLO_TEST_STATE_READS_BEFORE_FAULT: String(readsBeforeFault),
      KRYLO_TEST_FAIL_READ_LOG: log,
    },
  };
}

function events(dataDir, runId) {
  const file = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function failurePayload(cwd) {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    error: 'eslint found 3 problems in src/a.js',
    cwd,
  };
}

function assertSilentExit(res) {
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '', 'a telemetry hook never prints a decision');
}

for (const [readsBeforeFault, cause] of [[1, 'reload'], [2, 'saveState() pre-write read']]) {
  test(`fingerprint: a failed ${cause} is recorded as failure-not-persisted, not dropped`, () => {
    const dataDir = mkTempDataDir('krylo-fp-not-persisted-');
    try {
      const { runId, statePath } = createActiveRun(dataDir);
      const { log, env } = faultEnv(dataDir, readsBeforeFault);
      const res = runHook(FINGERPRINT, failurePayload(dataDir), dataDir, { env });
      assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`EISDIR read ${readsBeforeFault + 1}`), 'the injected fault must have fired');
      assertSilentExit(res);

      const recorded = events(dataDir, runId);
      assert.equal(recorded.filter((e) => e.event === 'failure').length, 0, 'no fingerprint was persisted, so none may be claimed');
      const notPersisted = recorded.filter((e) => e.event === 'failure-not-persisted');
      assert.equal(notPersisted.length, 1);
      assert.equal(notPersisted[0].status, 'state-unreadable');
      assert.equal(notPersisted[0].category, 'lint');
      assert.match(notPersisted[0].hash, /^[0-9a-f]{16}$/);
      assert.equal(readState(statePath).orbit.fingerprints.length, 0, 'nothing was persisted');
    } finally {
      cleanup(dataDir);
    }
  });
}

test('agent-events: a failed reload on SubagentStart is recorded as agent-start-not-persisted, not dropped', () => {
  const dataDir = mkTempDataDir('krylo-ae-start-not-persisted-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    const { log, env } = faultEnv(dataDir, 1);
    const res = runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStart', agent_type: 'krylo:builder', model: 'sonnet', cwd: dataDir }, dataDir, { env });
    assert.ok(fs.existsSync(log), 'the injected fault must have fired');
    assertSilentExit(res);

    const recorded = events(dataDir, runId);
    assert.equal(recorded.filter((e) => e.event === 'agent-start').length, 0);
    const notPersisted = recorded.filter((e) => e.event === 'agent-start-not-persisted');
    assert.equal(notPersisted.length, 1);
    assert.equal(notPersisted[0].status, 'state-unreadable');
    assert.equal(notPersisted[0].agentType, 'krylo:builder');
    assert.equal(readState(statePath).agents.length, 0, 'nothing was persisted');
  } finally {
    cleanup(dataDir);
  }
});

test('agent-events: a refused save on SubagentStop is recorded as agent-stop-not-persisted, not dropped', () => {
  const dataDir = mkTempDataDir('krylo-ae-stop-not-persisted-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStart', agent_type: 'krylo:builder', model: 'sonnet', cwd: dataDir }, dataDir);
    assert.equal(readState(statePath).agents[0].status, 'running');

    const { log, env } = faultEnv(dataDir, 2);
    const res = runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStop', agent_type: 'krylo:builder', status: 'completed', cwd: dataDir }, dataDir, { env });
    assert.match(fs.readFileSync(log, 'utf8'), /EISDIR read 3/, 'the fault must have hit saveState()\'s pre-write read');
    assertSilentExit(res);

    const recorded = events(dataDir, runId);
    assert.equal(recorded.filter((e) => e.event === 'agent-stop').length, 0);
    const notPersisted = recorded.filter((e) => e.event === 'agent-stop-not-persisted');
    assert.equal(notPersisted.length, 1);
    assert.equal(notPersisted[0].status, 'state-unreadable');
    assert.equal(notPersisted[0].agentType, 'krylo:builder');
    assert.equal(readState(statePath).agents[0].status, 'running', 'the stop was not persisted');
  } finally {
    cleanup(dataDir);
  }
});

test('control: with the preload loaded but no fault reached, both hooks persist and record no not-persisted event', () => {
  const dataDir = mkTempDataDir('krylo-telemetry-control-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    const { log, env } = faultEnv(dataDir, 1000);
    assertSilentExit(runHook(FINGERPRINT, failurePayload(dataDir), dataDir, { env }));
    assertSilentExit(runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStart', agent_type: 'krylo:builder', cwd: dataDir }, dataDir, { env }));
    assertSilentExit(runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStop', agent_type: 'krylo:builder', cwd: dataDir }, dataDir, { env }));
    // A SubagentStop with no running agent is not a failed mutation: nothing to record.
    assertSilentExit(runHook(AGENT_EVENTS, { hook_event_name: 'SubagentStop', agent_type: 'krylo:reviewer', cwd: dataDir }, dataDir, { env }));
    assert.equal(fs.existsSync(log), false, 'no fault was injected');

    const state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 1);
    assert.equal(state.agents[0].status, 'completed');
    assert.deepEqual(events(dataDir, runId).map((e) => e.event), ['failure', 'agent-start', 'agent-stop']);
  } finally {
    cleanup(dataDir);
  }
});

// The two causes that do not come from a read: a throw from inside the held
// lock (the save itself, e.g. a rename that outlasted its retry budget,
// ADR-0045) is `save-failed`; a lock that could not be taken is
// `lock-failed`. Both drive the exported functions in-process against a real
// run created by init-run, so fs can be mocked directly.
function inProcessRun(fn) {
  const dataDir = mkTempDataDir('krylo-telemetry-inproc-');
  const prev = process.env.KRYLO_DATA_ROOT;
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    process.env.KRYLO_DATA_ROOT = dataDir;
    fn({ dataDir, runId, statePath });
  } finally {
    mock.restoreAll();
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    cleanup(dataDir);
  }
}

function failRenamesOfState() {
  const realRenameSync = fs.renameSync;
  let fired = 0;
  mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (typeof to === 'string' && path.basename(to) === 'state.json') {
      fired += 1;
      const err = new Error('ENOSPC: simulated non-transient rename failure');
      err.code = 'ENOSPC';
      throw err;
    }
    return realRenameSync.call(fs, from, to, ...rest);
  });
  return () => fired;
}

function holdLockWithFakeClock(runId) {
  fs.writeFileSync(runLockPath(runId), 'held by another process');
  let now = 0;
  mock.method(performance, 'now', () => now);
  mock.method(Atomics, 'wait', () => {
    now += 100;
    return 'timed-out';
  });
}

test('fingerprint and agent-events: a save that throws inside the held lock is save-failed, not lock-failed', () => {
  inProcessRun(({ dataDir, runId, statePath }) => {
    const renames = failRenamesOfState();
    recordFailureFingerprint(runId, 'Bash', 'eslint found 3 problems in src/a.js');
    recordAgentEvent(runId, 'SubagentStart', { agent_type: 'krylo:builder' });
    mock.restoreAll();
    assert.equal(renames(), 2, 'both saves must have reached the failing rename');

    const recorded = events(dataDir, runId);
    assert.deepEqual(recorded.map((e) => [e.event, e.status]), [
      ['failure-not-persisted', 'save-failed'],
      ['agent-start-not-persisted', 'save-failed'],
    ]);
    const state = readState(statePath);
    assert.equal(state.orbit.fingerprints.length, 0);
    assert.equal(state.agents.length, 0);
  });
});

test('fingerprint and agent-events: a lock that cannot be taken is lock-failed', () => {
  inProcessRun(({ dataDir, runId, statePath }) => {
    holdLockWithFakeClock(runId);
    recordFailureFingerprint(runId, 'Bash', 'eslint found 3 problems in src/a.js');
    recordAgentEvent(runId, 'SubagentStop', { agent_type: 'krylo:builder' });
    mock.restoreAll();
    assert.ok(fs.existsSync(runLockPath(runId)), 'the other holder\'s lock file must be left alone');

    const recorded = events(dataDir, runId);
    assert.deepEqual(recorded.map((e) => [e.event, e.status]), [
      ['failure-not-persisted', 'lock-failed'],
      ['agent-stop-not-persisted', 'lock-failed'],
    ]);
    assert.equal(readState(statePath).orbit.fingerprints.length, 0);
  });
});

test('fingerprint and agent-events: a reload that fails for a reason other than a read error is reload-failed', () => {
  inProcessRun(({ dataDir, runId, statePath }) => {
    // Bytes that can be read but are not JSON: loadState() reports
    // 'corrupted' (and preserves a copy), not 'unreadable'.
    fs.writeFileSync(statePath, '{not json', 'utf8');
    recordFailureFingerprint(runId, 'Bash', 'eslint found 3 problems in src/a.js');
    recordAgentEvent(runId, 'SubagentStart', { agent_type: 'krylo:builder' });

    assert.deepEqual(events(dataDir, runId).map((e) => [e.event, e.status]), [
      ['failure-not-persisted', 'reload-failed'],
      ['agent-start-not-persisted', 'reload-failed'],
    ]);
  });
});
