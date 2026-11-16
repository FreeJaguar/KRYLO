// Test-only preload (node --import): every fs.readFileSync of the exact file
// named by KRYLO_TEST_FAIL_READ_PATH throws KRYLO_TEST_FAIL_READ_CODE
// (default EBUSY). Every other read is untouched, so a test can make one
// run's state.json, or one session's pointer, unreadable while the rest of
// the data root still works (docs/adr/0045-transient-state-io-retry.md).
//
// When KRYLO_TEST_FAIL_READ_LOG is set, each injected failure appends one
// line to that file, so a test can prove the fault actually fired.
import fs from 'node:fs';
import path from 'node:path';

const target = process.env.KRYLO_TEST_FAIL_READ_PATH;
const code = process.env.KRYLO_TEST_FAIL_READ_CODE || 'EBUSY';
const log = process.env.KRYLO_TEST_FAIL_READ_LOG;

function normalize(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

if (target) {
  const wanted = normalize(target);
  const realReadFileSync = fs.readFileSync;
  const realAppendFileSync = fs.appendFileSync;
  fs.readFileSync = function readFileSyncWithFault(p, ...rest) {
    if (typeof p === 'string' && normalize(p) === wanted) {
      if (log) {
        try {
          realAppendFileSync.call(fs, log, `${code}\n`);
        } catch {
          // the log is only evidence; never let it change the injected fault
        }
      }
      const err = new Error(`${code}: injected by fail-reads-of-path.mjs, read '${p}'`);
      err.code = code;
      throw err;
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
}
