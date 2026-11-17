// Test-only preload (node --import): lets the first read of any state.json
// in this process succeed and fails every later one with a non-transient
// EISDIR. A hook's lock-free resolveActiveRun() read therefore finds the
// run, and its re-read under the run lock fails -- the exact path
// docs/adr/0045-transient-state-io-retry.md requires to be reported as
// counter-not-persisted rather than silently dropped.
//
// KRYLO_TEST_STATE_READS_BEFORE_FAULT (default 1) sets how many state.json
// reads succeed before the fault starts. With 2, the hook's reload under the
// lock succeeds too and saveState()'s pre-write read is the first to fail, so
// saveState() refuses with 'state-unreadable' (docs/adr/0046-...).
//
// When KRYLO_TEST_FAIL_STATE_RENAME=1, every rename onto a state.json also
// fails, with a non-transient EACCES that withTransientRetry() does not
// retry, so saveState() throws from inside the held run lock.
//
// When KRYLO_TEST_FAIL_READ_LOG is set, each injected failure appends one
// line to that file, so a test can prove the fault actually fired.
import fs from 'node:fs';
import path from 'node:path';

const realReadFileSync = fs.readFileSync;
const realAppendFileSync = fs.appendFileSync;
const realRenameSync = fs.renameSync;
const failStateRename = process.env.KRYLO_TEST_FAIL_STATE_RENAME === '1';
const readsBeforeFault = Number.parseInt(process.env.KRYLO_TEST_STATE_READS_BEFORE_FAULT ?? '1', 10);
const log = process.env.KRYLO_TEST_FAIL_READ_LOG;
let stateReads = 0;
function logFault(line) {
  if (!log) return;
  try {
    realAppendFileSync.call(fs, log, `${line}
`);
  } catch {
    // the log is only evidence; never let it change the injected fault
  }
}
fs.readFileSync = function readFileSyncWithFault(p, ...rest) {
  if (typeof p === 'string' && path.basename(p) === 'state.json') {
    stateReads++;
    if (stateReads > readsBeforeFault) {
      if (log) {
        try {
          realAppendFileSync.call(fs, log, `EISDIR read ${stateReads}\n`);
        } catch {
          // the log is only evidence; never let it change the injected fault
        }
      }
      const err = new Error(`EISDIR: injected by fail-state-rereads.mjs, read '${p}'`);
      err.code = 'EISDIR';
      throw err;
    }
  }
  return realReadFileSync.call(fs, p, ...rest);
};
fs.renameSync = function renameSyncWithFault(from, to) {
  if (failStateRename && typeof to === 'string' && path.basename(to) === 'state.json') {
    logFault('EACCES rename');
    const err = new Error(`EACCES: injected by fail-state-rereads.mjs, rename onto '${to}'`);
    err.code = 'EACCES';
    throw err;
  }
  return realRenameSync.call(fs, from, to);
};
