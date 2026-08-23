#!/usr/bin/env node
// Print (deep-redacted) run state, or a single dotted field from it.

import path from 'node:path';

import { loadState, readActiveRunPointer, computeProjectRootHash } from '../lib/state.mjs';
import { deepRedact } from '../lib/redact.mjs';
import { bootstrapClaudeStorageEnvironment, resolveClaudeSessionId } from '../host/claude/context.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--run': args.run = argv[++i]; break;
      case '--session': args.session = argv[++i]; break;
      case '--project-dir': args.projectDir = argv[++i]; break;
      case '--field': args.field = argv[++i]; break;
      case '--raw': args.raw = true; break;
      default: break;
    }
  }
  return args;
}

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // The data root must be bootstrapped before any state/pointer access, even
  // when a session id is not (yet) known: --run bypasses pointer lookup
  // entirely, but still needs the correct KRYLO_DATA_ROOT resolved from the
  // Claude-specific env vars.
  bootstrapClaudeStorageEnvironment();

  let runId = args.run;
  if (!runId) {
    const projectRootHash = computeProjectRootHash(path.resolve(args.projectDir || process.cwd()));
    const hostSessionId = resolveClaudeSessionId({ explicitSessionId: args.session }) || undefined;
    const pointer = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId });
    if (!pointer.ok || !pointer.value || !pointer.value.runId) {
      console.log(JSON.stringify({ ok: false, error: 'no-current-run' }));
      process.exit(1);
      return;
    }
    runId = pointer.value.runId;
  }

  const result = loadState(runId);
  if (!result.ok) {
    console.log(JSON.stringify({ ok: false, error: result.error || 'load-failed' }));
    process.exit(1);
    return;
  }

  // --raw means "unformatted", not "unredacted": redaction is never optional.
  const redacted = deepRedact(result.value);

  if (args.field) {
    const value = getByPath(redacted, args.field);
    console.log(JSON.stringify({ ok: true, field: args.field, value: value === undefined ? null : value }));
    process.exit(0);
    return;
  }

  console.log(JSON.stringify(redacted));
  process.exit(0);
}

main();
