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

import { readStdinJson, resolveActiveRun, allowSilently } from '../lib/hook-utils.mjs';
import { saveState } from '../lib/state.mjs';
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

async function main() {
  const input = await readStdinJson();
  if (!input.ok) allowSilently();
  const payload = input.value;

  const run = resolveActiveRun(payload);
  if (!run.active) allowSilently();

  const state = run.state;
  const toolName = String(payload.tool_name ?? 'unknown');
  const failureText = extractFailureText(payload);
  const signature = normalizeSignature(toolName, failureText);
  const hash = crypto.createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 16);
  const category = categorize(toolName, failureText);

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

  saveState(state);
  recordEvent(state.runId, { event: 'failure', category, hash, cycle: state.orbit.cycle });
  allowSilently();
}

main().catch(() => allowSilently());
