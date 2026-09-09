// TDD category H (task Section 19.H): result schema -- deterministic
// ordering, valid status/severity, bounded strings, no raw response body,
// no secret-bearing values.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCheckResult,
  buildMaintenanceReport,
  computeReportStatus,
  computeExitCode,
  CHECK_STATUSES,
  SEVERITIES,
} from '../../scripts/lib/maintenance-schema.mjs';

test('deterministic ordering: checks are sorted by category then id regardless of insertion order', () => {
  const a = buildCheckResult({ id: 'z-check', category: 'node-runtime', status: 'ok', severity: 'info' });
  const b = buildCheckResult({ id: 'a-check', category: 'claude-compat', status: 'ok', severity: 'info' });
  const c = buildCheckResult({ id: 'm-check', category: 'claude-compat', status: 'ok', severity: 'info' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'offline', checks: [a, b, c] });
  assert.deepEqual(
    report.checks.map((x) => `${x.category}:${x.id}`),
    ['claude-compat:a-check', 'claude-compat:m-check', 'node-runtime:z-check'],
  );
});

test('an invalid status/severity/category is coerced to a safe explicit value, never propagated', () => {
  const result = buildCheckResult({ id: 'x', category: 'not-a-real-category', status: 'not-a-real-status', severity: 'not-a-real-severity' });
  assert.ok(CHECK_STATUSES.includes(result.status));
  assert.ok(SEVERITIES.includes(result.severity));
  assert.equal(result.status, 'blocked');
});

test('evidence and scalar fields are bounded, never allowed to carry an unbounded blob', () => {
  const hugeString = 'x'.repeat(10_000);
  const result = buildCheckResult({
    id: 'x',
    category: 'claude-compat',
    status: 'ok',
    severity: 'info',
    current: hugeString,
    observed: hugeString,
    evidence: Array.from({ length: 50 }, () => hugeString),
    recommendedAction: hugeString,
  });
  assert.ok(result.current.length <= 200);
  assert.ok(result.observed.length <= 200);
  assert.ok(result.evidence.length <= 5);
  for (const e of result.evidence) assert.ok(e.length <= 300);
  assert.ok(result.recommendedAction.length <= 300);
});

test('a high/critical changed/blocked check forces top-level "attention-required"', () => {
  const highChanged = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'changed', severity: 'high' });
  assert.equal(computeReportStatus([highChanged]), 'attention-required');
});

test('an info-severity changed check surfaces attention but never a failing exit code', () => {
  const infoChanged = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'changed', severity: 'info' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'live', checks: [infoChanged] });
  assert.equal(report.status, 'attention-required');
  assert.equal(computeExitCode(report), 0, 'an informational-only finding must never itself produce exit 1');
});

test('a high-severity changed check produces exit code 1', () => {
  const highChanged = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'changed', severity: 'high' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'live', checks: [highChanged] });
  assert.equal(computeExitCode(report), 1);
});

test('all-ok checks produce top-level "ok" and exit code 0', () => {
  const ok = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'ok', severity: 'info' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'live', checks: [ok] });
  assert.equal(report.status, 'ok');
  assert.equal(computeExitCode(report), 0);
});

test('an unavailable check alone never produces "attention-required" or a failing exit code', () => {
  const unavailable = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'unavailable', severity: 'info' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'offline', checks: [unavailable] });
  assert.equal(report.status, 'ok');
  assert.equal(computeExitCode(report), 0);
});

test('the report never carries a field shaped like a raw upstream response body or secret', () => {
  const result = buildCheckResult({ id: 'x', category: 'claude-compat', status: 'ok', severity: 'info', current: 'sk-fake-not-a-real-secret-shape' });
  const report = buildMaintenanceReport({ repositoryVersion: '0.1.1', mode: 'live', checks: [result] });
  const serialized = JSON.stringify(report);
  // Structural guarantee: the report schema has exactly the fields defined
  // in buildCheckResult -- no arbitrary upstream-response passthrough
  // field exists for a raw body to leak through even if a caller tried.
  const allowedTopLevelKeys = ['schemaVersion', 'generatedAt', 'repositoryVersion', 'mode', 'status', 'checks'];
  assert.deepEqual(Object.keys(report).sort(), allowedTopLevelKeys.sort());
  const allowedCheckKeys = ['id', 'category', 'status', 'severity', 'current', 'observed', 'evidence', 'recommendedAction', 'requiresHumanReview'];
  assert.deepEqual(Object.keys(report.checks[0]).sort(), allowedCheckKeys.sort());
  assert.ok(serialized.length < 2000);
});
