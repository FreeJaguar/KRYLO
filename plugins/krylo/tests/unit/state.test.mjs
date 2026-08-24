import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createInitialState,
  validateState,
  completionEval,
  saveState,
  loadState,
  applyApprovalResolution,
} from '../../scripts/lib/state.mjs';

function hostIdentityFor(hostSessionId) {
  return { host: 'claude', hostSessionId };
}

function withTempDataRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-state-'));
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('createInitialState produces state that validates against validateState', () => {
  withTempDataRoot((dir) => {
    const state = createInitialState({
      goalText: 'Implement the widget export feature',
      hostIdentity: hostIdentityFor('session-1'),
      projectDir: dir,
      lane: 'BUILD',
      risk: 'medium',
      complexity: 'normal',
      kryloVersion: '0.1.0',
    });
    const { valid, errors } = validateState(state);
    assert.deepEqual(errors, []);
    assert.equal(valid, true);
    assert.equal(state.schemaVersion, '1.1.0');
    assert.equal(state.phase, 'INITIALIZING');
    assert.equal(state.terminalState, null);
    assert.equal(state.orbit.budget, 5);
    assert.equal(state.questionGate.budget, 1);
    assert.equal(state.questionGate.used, 0);
    assert.match(state.project.rootHash, /^[a-f0-9]{64}$/);
    assert.equal(state.host.name, 'claude');
    assert.equal(state.host.sessionId, 'session-1');
    assert.equal(state.delegation.externalWorker, false);
    assert.equal(state.delegation.depth, 0);
    assert.equal('sessionId' in state, false);
  });
});

test('goal with an embedded secret token is redacted in goal.normalized', () => {
  withTempDataRoot((dir) => {
    const state = createInitialState({
      goalText: 'Fix the deploy script that leaked ghp_1234567890abcdefghijklmno to logs',
      hostIdentity: hostIdentityFor('session-2'),
      projectDir: dir,
      lane: 'PATCH',
      risk: 'low',
    });
    assert.ok(!state.goal.normalized.includes('ghp_1234567890abcdefghijklmno'));
    assert.ok(state.goal.normalized.includes('[REDACTED]'));
  });
});

test('goal.normalized is whitespace-collapsed and capped at 300 chars', () => {
  withTempDataRoot((dir) => {
    const longGoal = `line one\n\n   line   two\t\ttab   ${'x'.repeat(400)}`;
    const state = createInitialState({
      goalText: longGoal,
      hostIdentity: hostIdentityFor('session-3'),
      projectDir: dir,
      lane: 'BUILD',
      risk: 'low',
    });
    assert.ok(state.goal.normalized.length <= 300);
    assert.ok(!state.goal.normalized.includes('\n'));
    assert.ok(!state.goal.normalized.includes('\t'));
  });
});

function baseCompleteState(dir) {
  const state = createInitialState({
    goalText: 'ship feature',
    hostIdentity: hostIdentityFor('s'),
    projectDir: dir,
    lane: 'BUILD',
    risk: 'low',
  });
  state.acceptanceCriteria = [{ id: 'AC-1', description: 'thing works', status: 'proven', evidenceRefs: ['EV-1'] }];
  state.evidence = [{
    id: 'EV-1',
    type: 'test',
    label: 'unit tests',
    timestamp: new Date().toISOString(),
    sourceTool: 'node:test',
    result: 'pass',
    summary: '10 tests passed',
    artifactPath: null,
    stale: false,
  }];
  return state;
}

test('completionEval: true when all conditions are satisfied', () => {
  withTempDataRoot((dir) => {
    const state = baseCompleteState(dir);
    const result = completionEval(state);
    assert.equal(result.complete, true);
    assert.deepEqual(result.reasons, []);
  });
});

test('completionEval: false when a high-severity finding is open', () => {
  withTempDataRoot((dir) => {
    const state = baseCompleteState(dir);
    state.findings = [{ id: 'finding-1', severity: 'high', status: 'open', summary: 'bad thing' }];
    const result = completionEval(state);
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((r) => r.includes('finding-1')));
  });
});

test('completionEval: false when a risk approval is pending', () => {
  withTempDataRoot((dir) => {
    const state = baseCompleteState(dir);
    state.riskApprovals = [{ id: 'ra-1', actionClass: 'git-push', status: 'pending', requestedAt: new Date().toISOString() }];
    const result = completionEval(state);
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((r) => r.includes('ra-1')));
  });
});

test('completionEval: false when evidence is stale', () => {
  withTempDataRoot((dir) => {
    const state = baseCompleteState(dir);
    state.evidence[0].stale = true;
    const result = completionEval(state);
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((r) => r.includes('AC-1')));
  });
});

test('completionEval: false when a proven criterion has no evidence reference', () => {
  withTempDataRoot((dir) => {
    const state = baseCompleteState(dir);
    state.acceptanceCriteria[0].evidenceRefs = [];
    const result = completionEval(state);
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((r) => r.includes('AC-1')));
  });
});

test('completionEval: false when there are no acceptance criteria', () => {
  withTempDataRoot((dir) => {
    const state = createInitialState({ goalText: 'x', hostIdentity: hostIdentityFor('s'), projectDir: dir, lane: 'BUILD', risk: 'low' });
    const result = completionEval(state);
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((r) => r.includes('no acceptance criteria')));
  });
});

test('corrupted state.json is preserved as .corrupt-* and reported as a recovery indicator', () => {
  withTempDataRoot((dir) => {
    const state = createInitialState({ goalText: 'x', hostIdentity: hostIdentityFor('s'), projectDir: dir, lane: 'BUILD', risk: 'low' });
    const saveResult = saveState(state);
    assert.equal(saveResult.ok, true);

    const statePath = path.join(process.env.KRYLO_DATA_ROOT, 'runs', state.runId, 'state.json');
    fs.writeFileSync(statePath, '{ not valid json', 'utf8');

    const loaded = loadState(state.runId);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'corrupted');
    assert.equal(loaded.recovered, true);
    assert.ok(fs.existsSync(loaded.corruptPath));
    assert.match(path.basename(loaded.corruptPath), /^state\.corrupt-\d+\.json$/);
  });
});

test('loadState reports not-found for a run that does not exist', () => {
  withTempDataRoot(() => {
    const loaded = loadState('run-doesnotexist');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'not-found');
  });
});

test('saveState refuses to persist an invalid state', () => {
  withTempDataRoot((dir) => {
    const state = createInitialState({ goalText: 'x', hostIdentity: hostIdentityFor('s'), projectDir: dir, lane: 'BUILD', risk: 'low' });
    state.phase = 'NOT_A_REAL_PHASE';
    const result = saveState(state);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });
});

test('applyApprovalResolution refuses "approved" itself, as defense in depth (docs/adr/0025-native-permission-approval.md)', () => {
  // A KRYLO-local approval record must never again be able to authorize
  // execution. update-state.mjs's CLI already refuses `approved` before
  // ever calling this function, but the function itself must refuse it too
  // -- a future caller must not be able to reintroduce the removed
  // authorization surface just by calling this with a different status.
  const state = createInitialState({ goalText: 'x', hostIdentity: hostIdentityFor('s'), projectDir: '/tmp/proj', lane: 'BUILD', risk: 'low' });
  state.riskApprovals.push({
    id: 'ra-1', actionClass: 'git-push', status: 'pending', requestedAt: new Date().toISOString(),
  });

  const result = applyApprovalResolution(state, 'ra-1', 'approved');
  assert.equal(result.error, 'invalid-approval-status');
  assert.equal(state.riskApprovals[0].status, 'pending', 'the approval must be left untouched by the refused call');

  const denied = applyApprovalResolution(state, 'ra-1', 'denied');
  assert.equal(denied.ok, true);
  assert.equal(state.riskApprovals[0].status, 'denied');
});
