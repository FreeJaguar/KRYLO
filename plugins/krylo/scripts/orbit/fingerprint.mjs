#!/usr/bin/env node
// KRYLO failure fingerprinting (PostToolUseFailure hook).
//
// Builds a redacted, normalized failure signature, hashes it, and records the
// fingerprint in run state. Raw error text is NEVER persisted or printed.
// When the same fingerprint repeats, the run is marked as requiring a
// strategy change (docs/03-orbit-loop.md).
//
// Fail mode: fail OPEN (telemetry-style hook) — always exit 0.

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { readStdinJson, resolveActiveRun } from '../lib/hook-utils.mjs';
import { normalizeClaudeHookPayload, allowClaudeSilently } from '../host/claude/hook-transport.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { redactText } from '../lib/redact.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

const CATEGORY_RULES = [
  { category: 'test', pattern: /\b(jest|vitest|mocha|pytest|node --test|node:test|playwright test|rspec|junit|test(s)?( run)? failed|expect(ed)?)\b|\.test\.|\.spec\./i },
  { category: 'build', pattern: /\b(build|compile|webpack|vite|rollup|esbuild|tsc --build|gradle|maven|cargo build|go build)\b/i },
  { category: 'lint', pattern: /\b(eslint|ruff|flake8|pylint|clippy|golangci|prettier|lint)\b/i },
  { category: 'types', pattern: /\b(tsc|typecheck|type error|mypy|ts\d{4})\b/i },
  { category: 'environment', pattern: /\b(enoent|eacces|eperm|not found|not recognized|permission denied|command not found|no such file)\b/i },
];

function extractFailureText(payload) {
  const candidates = [payload.error, payload.tool_response, payload.output, payload.stderr];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
    if (c && typeof c === 'object') {
      try { return JSON.stringify(c); } catch { /* ignore */ }
    }
  }
  return '';
}

function normalizeSignature(toolName, text) {
  const redacted = redactText(String(text));
  const normalized = redacted
    .toLowerCase()
    // strip absolute paths, both separator styles
    .replace(/[a-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/[^\s'":]+/g, '<path>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${toolName}|${normalized}`;
}

function categorize(toolName, text) {
  const haystack = `${toolName} ${text}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  if (/bash/i.test(toolName)) return 'tool';
  return 'other';
}

/**
 * Record one failure's fingerprint against an already-resolved active run.
 * Exported (rather than folded into main()) so a test can drive it directly
 * against an isolated fixture without needing a real stdin/subprocess to
 * exercise a saveState() failure deterministically.
 *
 * Only records the telemetry event if the mutation was actually persisted
 * (saveState() returned ok) -- otherwise this would claim a fingerprint was
 * recorded (a "failure" telemetry event, cycle number and all) for a
 * mutation that a lock timeout, a failed reload, or (security-hardening
 * checkpoint) a failed pre-migration backup write actually discarded.
 */
export function recordFailureFingerprint(runId, toolName, failureText) {
  const signature = normalizeSignature(toolName, failureText);
  const hash = crypto.createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 16);
  const category = categorize(toolName, failureText);

  let cycleForEvent = null;
  try {
    withFileLock(runLockPath(runId), () => {
      const reloaded = loadState(runId);
      if (!reloaded.ok) return;
      const state = reloaded.value;
      const existing = state.orbit.fingerprints.find((f) => f.hash === hash);
      if (existing) {
        existing.count += 1;
        existing.lastSeenCycle = state.orbit.cycle;
        if (existing.count >= 2) state.orbit.requiredStrategyChange = true;
      } else {
        state.orbit.fingerprints.push({
          hash,
          category,
          count: 1,
          firstSeenCycle: state.orbit.cycle,
          lastSeenCycle: state.orbit.cycle,
        });
      }
      const saved = saveState(state);
      if (saved.ok) cycleForEvent = state.orbit.cycle;
    });
  } catch {
    // Fail open: fingerprinting must never block or crash the tool call.
  }

  if (cycleForEvent !== null) recordEvent(runId, { event: 'failure', category, hash, cycle: cycleForEvent });
}

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowClaudeSilently();
  const normalized = normalizeClaudeHookPayload(input.value);
  if (!normalized.ok) allowClaudeSilently();
  const payload = normalized.payload;

  const run = resolveActiveRun({
    projectRoot: normalized.identity.projectRoot,
    host: normalized.identity.host,
    hostSessionId: normalized.identity.hostSessionId,
  });
  if (!run.active) allowClaudeSilently();

  const toolName = String(payload.tool_name ?? 'unknown');
  const failureText = extractFailureText(payload);
  recordFailureFingerprint(run.state.runId, toolName, failureText);
  allowClaudeSilently();
}

// Only auto-run when this file is executed directly as the Hook entrypoint
// (`node fingerprint.mjs`), never when it is imported for
// recordFailureFingerprint() -- otherwise importing this module (e.g. from a
// test) would itself start reading the importing process's real stdin and
// hang waiting for input that never arrives.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => allowClaudeSilently());
}
