// Shared, host-neutral Ecosystem Maintenance result model (task Section 4).
// Hand-written validation, matching this repository's existing convention
// (ADR-0017: no schema-validation dependency; JSON Schema files exist as a
// cross-checked reference, not the runtime validator itself).

export const MAINTENANCE_SCHEMA_VERSION = '1.0.0';

export const CHECK_CATEGORIES = [
  'claude-compat',
  'codex-compat',
  'actions-pins',
  'node-runtime',
  'dependencies',
  'internal-drift',
];

export const CHECK_STATUSES = ['ok', 'changed', 'warning', 'blocked', 'unavailable'];
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
export const REPORT_STATUSES = ['ok', 'attention-required', 'blocked'];
export const REPORT_MODES = ['offline', 'live'];

const MAX_EVIDENCE_ENTRIES = 5;
const MAX_EVIDENCE_LENGTH = 300;
const MAX_SCALAR_LENGTH = 200;
const MAX_RECOMMENDED_ACTION_LENGTH = 300;

function boundString(value, max) {
  if (typeof value !== 'string') return String(value ?? '').slice(0, max);
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Build one normalized check result. Never throws -- an invalid `status`/
 * `severity`/`category` is coerced to a safe, explicit failure shape rather
 * than propagating a bad value into the report (a maintenance checker bug
 * must never crash the whole run or silently corrupt the report).
 */
export function buildCheckResult({
  id,
  category,
  status,
  severity,
  current = null,
  observed = null,
  evidence = [],
  recommendedAction = 'none',
  requiresHumanReview = false,
}) {
  const safeCategory = CHECK_CATEGORIES.includes(category) ? category : 'internal-drift';
  const safeStatus = CHECK_STATUSES.includes(status) ? status : 'blocked';
  const safeSeverity = SEVERITIES.includes(severity) ? severity : 'medium';
  const safeEvidence = Array.isArray(evidence)
    ? evidence.slice(0, MAX_EVIDENCE_ENTRIES).map((e) => boundString(e, MAX_EVIDENCE_LENGTH))
    : [];
  return {
    id: boundString(id, 120),
    category: safeCategory,
    status: safeStatus,
    severity: safeSeverity,
    current: current === null ? null : boundString(current, MAX_SCALAR_LENGTH),
    observed: observed === null ? null : boundString(observed, MAX_SCALAR_LENGTH),
    evidence: safeEvidence,
    recommendedAction: boundString(recommendedAction, MAX_RECOMMENDED_ACTION_LENGTH),
    requiresHumanReview: Boolean(requiresHumanReview),
  };
}

/**
 * A high/critical check that is changed/blocked forces top-level
 * "attention-required" (never silently absorbed into "ok"). A "blocked"
 * check caused by the CHECKER's own malfunction (not a detected upstream
 * condition) is the caller's responsibility to mark distinctly -- see
 * check-ecosystem.mjs's own exit-code logic, which is separate from this
 * report-level status.
 */
export function computeReportStatus(checks) {
  const hasBlockingFinding = checks.some(
    (c) => (c.status === 'changed' || c.status === 'blocked') && (c.severity === 'high' || c.severity === 'critical'),
  );
  if (hasBlockingFinding) return 'attention-required';
  const hasAnyChangedOrWarning = checks.some((c) => c.status === 'changed' || c.status === 'warning');
  if (hasAnyChangedOrWarning) return 'attention-required';
  return 'ok';
}

/**
 * Build the full report. `checks` is sorted deterministically by
 * category then id (task Section 4's "deterministic ordering" requirement)
 * -- never insertion order, which could vary between runs/environments.
 */
export function buildMaintenanceReport({ repositoryVersion, mode, checks }) {
  const sorted = [...checks].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repositoryVersion: boundString(repositoryVersion, 40),
    mode: REPORT_MODES.includes(mode) ? mode : 'offline',
    status: computeReportStatus(sorted),
    checks: sorted,
  };
}

/** Exit code semantics (task Section 23), computed from the report alone. */
export function computeExitCode(report) {
  const hasBlockingSeverity = report.checks.some(
    (c) => (c.status === 'changed' || c.status === 'blocked') && (c.severity === 'high' || c.severity === 'critical'),
  );
  return hasBlockingSeverity ? 1 : 0;
}
