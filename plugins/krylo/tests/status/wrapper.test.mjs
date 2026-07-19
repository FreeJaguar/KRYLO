import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { mkTempDataDir, createActiveRun, cleanup, SCRIPTS_ROOT } from '../hooks/helpers.mjs';

function runWrapper(dataDir) {
  return spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, 'status', 'statusline-wrapper.mjs')], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
}

test('wrapper: no config, no run -> empty output, exit 0', () => {
  const dataDir = mkTempDataDir('krylo-wrap-');
  try {
    const res = runWrapper(dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup(dataDir);
  }
});

test('wrapper: active run -> KRYLO segment only', () => {
  const dataDir = mkTempDataDir('krylo-wrap-');
  try {
    createActiveRun(dataDir);
    const res = runWrapper(dataDir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^KRYLO INITIALIZING 0\/3 0\/0 AC$/);
  } finally {
    cleanup(dataDir);
  }
});

test('wrapper: preserves original status line and appends KRYLO segment', () => {
  const dataDir = mkTempDataDir('krylo-wrap-');
  try {
    createActiveRun(dataDir);
    const original = `"${process.execPath}" -e "console.log('orig-line')"`;
    fs.writeFileSync(path.join(dataDir, 'wrapper-config.json'), JSON.stringify({ originalCommand: original }), 'utf8');
    const res = runWrapper(dataDir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /orig-line \| KRYLO INITIALIZING/);
  } finally {
    cleanup(dataDir);
  }
});

test('wrapper: failing original command degrades gracefully', () => {
  const dataDir = mkTempDataDir('krylo-wrap-');
  try {
    createActiveRun(dataDir);
    fs.writeFileSync(path.join(dataDir, 'wrapper-config.json'), JSON.stringify({ originalCommand: 'definitely-not-a-command-xyz' }), 'utf8');
    const res = runWrapper(dataDir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /KRYLO INITIALIZING/);
  } finally {
    cleanup(dataDir);
  }
});
