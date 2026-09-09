import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  HOST_NAMES,
  createHostIdentity,
  bindRunId,
  validateHostIdentity,
  validateHostContext,
} from '../../scripts/lib/host-context.mjs';

test('HOST_NAMES contains only approved first-class hosts', () => {
  assert.deepEqual(HOST_NAMES, ['claude', 'codex']);
});

test('createHostIdentity returns an immutable normalized identity', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-1',
    hostTurnId: 'prompt-1',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
    permissionMode: 'default',
  });

  assert.equal(identity.host, 'claude');
  assert.equal(identity.hostSessionId, 'session-1');
  assert.equal(path.isAbsolute(identity.projectRoot), true);
  assert.equal(path.isAbsolute(identity.pluginRoot), true);
  assert.equal(path.isAbsolute(identity.dataRoot), true);
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(validateHostIdentity(identity).valid, true);
});

test('bindRunId creates a validated immutable HostContext', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-2',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
  });
  const context = bindRunId(identity, 'run-abcdef123456');
  assert.equal(context.runId, 'run-abcdef123456');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(validateHostContext(context).valid, true);
});

test('invalid host and missing session are rejected', () => {
  assert.equal(validateHostIdentity({ host: 'other' }).valid, false);
  assert.throws(() => createHostIdentity({ host: 'claude', hostSessionId: '' }));
});

test('bindRunId rejects malformed run IDs', () => {
  const identity = createHostIdentity({
    host: 'claude',
    hostSessionId: 'session-3',
    projectRoot: '.',
    pluginRoot: '.',
    dataRoot: '.',
  });
  assert.throws(() => bindRunId(identity, '../escape'));
});
