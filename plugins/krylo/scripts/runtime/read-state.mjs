#!/usr/bin/env node
// Print (deep-redacted) run state, or a single dotted field from it.

import { loadState, readCurrentRunPointer } from '../lib/state.mjs';
import { deepRedact } from '../lib/redact.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--run': args.run = argv[++i]; break;
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

  let runId = args.run;
  if (!runId) {
    const pointer = readCurrentRunPointer();
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
