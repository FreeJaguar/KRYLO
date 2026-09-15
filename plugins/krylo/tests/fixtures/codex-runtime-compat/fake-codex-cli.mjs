#!/usr/bin/env node
// Deterministic fake Codex CLI for runtime-compat probe tests. Behavior is
// selected entirely via environment variables so one small fixture covers
// the whole required failure/success matrix without near-duplicate scripts
// (mirrors tests/fixtures/cross-harness/fake-worker.mjs's own convention).
//
// - FAKE_CODEX_VERSION_OUTPUT: exact stdout to print for `--version`
//   (default 'codex-cli 0.120.0'). Set to something not matching
//   `codex-cli X.Y.Z` to simulate malformed probe output.
// - FAKE_CODEX_EXIT_CODE: process exit code (default 0).
// - FAKE_CODEX_DELAY_MS: milliseconds to sleep before responding, to
//   simulate a probe that exceeds the caller's own timeout budget.

const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS || '0');
const exitCode = Number(process.env.FAKE_CODEX_EXIT_CODE || '0');
const versionOutput = process.env.FAKE_CODEX_VERSION_OUTPUT ?? 'codex-cli 0.120.0';

function respond() {
  if (process.argv.includes('--version')) {
    process.stdout.write(`${versionOutput}\n`);
  }
  process.exit(exitCode);
}

if (delayMs > 0) {
  setTimeout(respond, delayMs);
} else {
  respond();
}
