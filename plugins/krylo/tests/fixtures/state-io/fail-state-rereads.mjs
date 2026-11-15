// Test-only preload (node --import): lets the first read of any state.json
// in this process succeed and fails every later one with a non-transient
// EISDIR. A hook's lock-free resolveActiveRun() read therefore finds the
// run, and its re-read under the run lock fails -- the exact path
// docs/adr/0045-transient-state-io-retry.md requires to be reported as
// counter-not-persisted rather than silently dropped.
import fs from 'node:fs';
import path from 'node:path';

const realReadFileSync = fs.readFileSync;
let stateReads = 0;
fs.readFileSync = function readFileSyncWithFault(p, ...rest) {
  if (typeof p === 'string' && path.basename(p) === 'state.json') {
    stateReads++;
    if (stateReads > 1) {
      const err = new Error(`EISDIR: injected by fail-state-rereads.mjs, read '${p}'`);
      err.code = 'EISDIR';
      throw err;
    }
  }
  return realReadFileSync.call(fs, p, ...rest);
};
