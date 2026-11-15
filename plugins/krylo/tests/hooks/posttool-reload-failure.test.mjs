// docs/adr/0045-transient-state-io-retry.md, decision 6: when the
// PostToolUse telemetry hook resolves its run but then cannot re-read the
// state under the run lock, the increment is not persisted and the hook must
// say so (status 'counter-not-persisted') instead of returning as if it had
// saved. Before ADR-0045 both entrypoints returned silently.
//
// The fault is injected with a test-only --import preload
// (tests/fixtures/state-io/fail-state-rereads.mjs) that fails every read of
// state.json after the first one in the hook process.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  mkTempDataDir,
  createActiveRun,
  createActiveRunCodexOnly,
  runHook,
  runHookCodexOnly,
  readState,
  cleanup,
} from './helpers.mjs';

const PRELOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'state-io', 'fail-state-rereads.mjs');
const NODE_OPTIONS = `--import=${pathToFileURL(PRELOAD).href}`;

function toolEvents(dataDir, runId) {
  const file = path.join(dataDir, 'telemetry', `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'tool');
}

test('posttool-telemetry (Claude): a failed reload under the lock is recorded as counter-not-persisted', () => {
  const dataDir = mkTempDataDir('krylo-reload-fail-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    const res = runHook('runtime/posttool-telemetry.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Grep', duration_ms: 1, cwd: dataDir }, dataDir, { env: { NODE_OPTIONS } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');

    const events = toolEvents(dataDir, runId);
    assert.equal(events.length, 1, 'the tool event itself is still recorded');
    assert.equal(events[0].status, 'counter-not-persisted');
    assert.equal(readState(statePath).toolCounters.Grep, undefined, 'nothing was persisted');
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')), []);
  } finally {
    cleanup(dataDir);
  }
});

test('posttool-telemetry-codex: a failed reload under the lock is recorded as counter-not-persisted', () => {
  const dataDir = mkTempDataDir('krylo-reload-fail-codex-');
  try {
    const { runId, statePath } = createActiveRunCodexOnly(dataDir);
    const res = runHookCodexOnly('runtime/posttool-telemetry-codex.mjs', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dataDir, session_id: 'codex-hook-session',
    }, dataDir, { env: { NODE_OPTIONS } });
    assert.equal(res.status, 0);

    const events = toolEvents(dataDir, runId);
    assert.equal(events.length, 1, 'the tool event itself is still recorded');
    assert.equal(events[0].status, 'counter-not-persisted');
    assert.equal(readState(statePath).toolCounters.Bash, undefined, 'nothing was persisted');
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith('state.corrupt-')), []);
  } finally {
    cleanup(dataDir);
  }
});

test('control: without the injected fault both entrypoints persist the increment and record no failure status', () => {
  const dataDir = mkTempDataDir('krylo-reload-ok-');
  try {
    const { runId, statePath } = createActiveRun(dataDir);
    runHook('runtime/posttool-telemetry.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Grep', duration_ms: 1, cwd: dataDir }, dataDir);
    assert.equal(readState(statePath).toolCounters.Grep, 1);
    assert.equal(toolEvents(dataDir, runId)[0].status, undefined);
  } finally {
    cleanup(dataDir);
  }
  const codexDir = mkTempDataDir('krylo-reload-ok-codex-');
  try {
    const { runId, statePath } = createActiveRunCodexOnly(codexDir);
    runHookCodexOnly('runtime/posttool-telemetry-codex.mjs', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: codexDir, session_id: 'codex-hook-session',
    }, codexDir);
    assert.equal(readState(statePath).toolCounters.Bash, 1);
    assert.equal(toolEvents(codexDir, runId)[0].status, undefined);
  } finally {
    cleanup(codexDir);
  }
});
