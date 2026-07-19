import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordEvent } from '../../scripts/lib/telemetry.mjs';

function withTempDataRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-telemetry-'));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('recordEvent only persists whitelisted fields; extras like command/prompt are dropped', () => {
  withTempDataRoot((dir) => {
    const result = recordEvent('run-abc123', {
      event: 'tool-call',
      toolName: 'Bash',
      durationMs: 42,
      status: 'ok',
      command: 'rm -rf /some/secret/path',
      prompt: 'the raw user prompt should never appear here',
      arbitraryField: 'should also be dropped',
    });
    assert.equal(result.ok, true);

    const filePath = path.join(dir, 'telemetry', 'run-abc123.jsonl');
    const contents = fs.readFileSync(filePath, 'utf8');
    assert.ok(!contents.includes('rm -rf'));
    assert.ok(!contents.includes('prompt'));
    assert.ok(!contents.includes('raw user prompt'));
    assert.ok(!contents.includes('arbitraryField'));

    const line = JSON.parse(contents.trim().split('\n')[0]);
    assert.equal(line.event, 'tool-call');
    assert.equal(line.toolName, 'Bash');
    assert.equal(line.durationMs, 42);
    assert.equal(line.status, 'ok');
    assert.equal('command' in line, false);
    assert.equal('prompt' in line, false);
    assert.equal('arbitraryField' in line, false);
    assert.equal(typeof line.ts, 'string');
  });
});

test('recordEvent is a no-op when CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY=false', () => {
  withTempDataRoot((dir) => {
    const prevOption = process.env.CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY;
    process.env.CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY = 'false';
    try {
      const result = recordEvent('run-abc123', { event: 'tool-call' });
      assert.equal(result.ok, true);
      assert.equal(result.skipped, 'disabled');
      const filePath = path.join(dir, 'telemetry', 'run-abc123.jsonl');
      assert.equal(fs.existsSync(filePath), false);
    } finally {
      if (prevOption === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY;
      else process.env.CLAUDE_PLUGIN_OPTION_LOCAL_TELEMETRY = prevOption;
    }
  });
});

test('recordEvent never throws even when the telemetry directory cannot be created', () => {
  withTempDataRoot((dir) => {
    // Create a plain file where the "telemetry" directory would need to go,
    // so mkdirSync(recursive) is forced to fail.
    fs.writeFileSync(path.join(dir, 'telemetry'), 'not a directory', 'utf8');
    assert.doesNotThrow(() => {
      const result = recordEvent('run-abc123', { event: 'tool-call' });
      assert.equal(result.ok, false);
    });
  });
});
