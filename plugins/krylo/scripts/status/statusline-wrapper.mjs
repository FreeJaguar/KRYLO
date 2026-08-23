#!/usr/bin/env node
// KRYLO user-level main status-line wrapper (installed ONLY through
// /krylo:setup after a dry run and backup — ADR-0013, ADR-0016).
//
// Preserves the user's original status line when one was configured at
// install time (recorded in wrapper-config.json inside KRYLO's data root by
// setup, from user-approved configuration — never derived from hook input),
// then appends a compact KRYLO segment. Never crashes: on any failure it
// degrades to the original output or empty output.

import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getDataRoot } from '../lib/paths.mjs';
import { readJson } from '../lib/atomic.mjs';
import { readActiveRunPointerForCwd, loadState } from '../lib/state.mjs';
import { bootstrapClaudeStorageEnvironment, resolveClaudeSessionId } from '../host/claude/context.mjs';

async function readStdinRaw() {
  try {
    if (process.stdin.isTTY) return '';
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > 65536) break;
    }
    return data;
  } catch {
    return '';
  }
}

function kryloSegment(hostSessionId) {
  try {
    // No hostSessionId falls back to the most recently updated pointer
    // inside the `claude` host directory for this project only (never
    // crosses into another host's directory).
    const pointer = readActiveRunPointerForCwd(process.cwd(), { host: 'claude', hostSessionId });
    if (!pointer.ok || !pointer.value?.runId) return '';
    const loaded = loadState(pointer.value.runId);
    if (!loaded.ok) return '';
    const state = loaded.value;
    const proven = state.acceptanceCriteria.filter((c) => c.status === 'proven' || c.status === 'not-applicable').length;
    return `KRYLO ${state.phase} ${state.orbit.cycle}/${state.orbit.budget} ${proven}/${state.acceptanceCriteria.length} AC`;
  } catch {
    return '';
  }
}

async function main() {
  const stdinRaw = await readStdinRaw();

  bootstrapClaudeStorageEnvironment();

  let hookPayload = null;
  try {
    const parsed = JSON.parse(stdinRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hookPayload = parsed;
  } catch {
    // Absent or unparsable stdin just means no session id is available.
  }
  const hostSessionId = resolveClaudeSessionId({ hookPayload });

  let originalOut = '';
  try {
    const config = readJson(path.join(getDataRoot(), 'wrapper-config.json'));
    // Contract: originalCommand is an argv ARRAY captured by user-approved
    // setup. Executed without a shell so a planted config file cannot smuggle
    // shell metacharacters into an execution (defense-in-depth; the data root
    // is additionally write-protected by the risk gate).
    const argv = config.ok && Array.isArray(config.value?.originalCommand)
      ? config.value.originalCommand.filter((a) => typeof a === 'string')
      : null;
    if (argv && argv.length > 0) {
      const res = spawnSync(argv[0], argv.slice(1), { shell: false, input: stdinRaw, encoding: 'utf8', timeout: 2000 });
      if (typeof res.stdout === 'string') originalOut = res.stdout.trim();
    }
  } catch {
    originalOut = '';
  }

  const segment = kryloSegment(hostSessionId);
  const parts = [originalOut, segment].filter((p) => p !== '');
  process.stdout.write(parts.join(' | '));
  process.exit(0);
}

main().catch(() => process.exit(0));
