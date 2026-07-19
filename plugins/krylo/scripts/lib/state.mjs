// KRYLO run-state model: creation, hand-written structural validation
// (kept in sync with schemas/run-state.schema.json and evidence.schema.json),
// persistence with corruption recovery, completion evaluation, and the
// current-run pointer.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ensureDir, runStatePath, currentRunPointerPath } from './paths.mjs';
import { writeJsonAtomic, readJson } from './atomic.mjs';
import { redactText } from './redact.mjs';

export const SCHEMA_VERSION = '1.0.0';

export const ENUMS = {
  lane: ['PATCH', 'BUILD', 'DESIGN', 'PRODUCT', 'INCIDENT', 'MIGRATION', 'AUDIT', 'AI', 'PERFORMANCE'],
  risk: ['low', 'medium', 'high'],
  complexity: ['trivial', 'normal', 'complex'],
  criterionStatus: ['pending', 'proven', 'failed', 'blocked', 'not-applicable'],
  agentStatus: ['running', 'completed', 'failed', 'stopped', 'cancelled'],
  fingerprintCategory: ['test', 'build', 'lint', 'types', 'runtime', 'tool', 'environment', 'other'],
  questionCategory: [
    'missing-credential',
    'destructive-production-action',
    'material-business-decision',
    'legal-or-compliance',
    'privacy',
    'financial',
    'high-impact-security',
    'no-safe-default',
  ],
  grantStatus: ['available', 'consumed', 'expired'],
  actionClass: [
    'production-deploy',
    'production-data-write',
    'destructive-operation',
    'package-publish',
    'release',
    'git-push',
    'git-force',
    'merge',
    'iam-or-secrets',
    'payment',
    'external-message',
    'external-write',
    'other',
  ],
  approvalStatus: ['pending', 'approved', 'denied'],
  findingSeverity: ['critical', 'high', 'medium', 'low', 'info'],
  findingStatus: ['open', 'resolved', 'accepted', 'invalid'],
  evidenceType: [
    'test',
    'build',
    'lint',
    'types',
    'format',
    'migration',
    'runtime',
    'browser',
    'screenshot',
    'performance',
    'security-scan',
    'review',
    'diff-inspection',
    'command',
    'other',
  ],
  evidenceResult: ['pass', 'fail', 'partial', 'blocked', 'info'],
  phase: [
    'INITIALIZING',
    'CLASSIFYING',
    'PLANNING',
    'EXECUTING',
    'VERIFYING',
    'REVIEWING',
    'CORRECTING',
    'COMPLETING',
    'BLOCKED',
    'AWAITING_DECISION',
    'AWAITING_RISK_APPROVAL',
    'ITERATION_LIMIT',
  ],
  terminalState: [
    'VERIFIED_COMPLETE',
    'SAFE_BLOCKED',
    'USER_DECISION_REQUIRED',
    'RISK_APPROVAL_REQUIRED',
    'ITERATION_LIMIT_REACHED',
    'CANCELLED_BY_USER',
  ],
};

export const REQUIRED_TOP_LEVEL = [
  'schemaVersion',
  'kryloVersion',
  'sessionId',
  'runId',
  'project',
  'goal',
  'acceptanceCriteria',
  'agents',
  'toolCounters',
  'orbit',
  'questionGate',
  'riskApprovals',
  'findings',
  'evidence',
  'phase',
  'terminalState',
  'createdAt',
  'updatedAt',
];

const RISK_BUDGETS = { low: 3, medium: 5, high: 7 };

function nowIso() {
  return new Date().toISOString();
}

function isString(v) {
  return typeof v === 'string';
}
function isBoolean(v) {
  return typeof v === 'boolean';
}
function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isArray(v) {
  return Array.isArray(v);
}
function isStringOrNull(v) {
  return v === null || isString(v);
}

function normalizeProjectPath(projectDir) {
  const resolved = path.resolve(projectDir);
  return resolved.split(path.sep).join('/').toLowerCase();
}

/** SHA-256 hash of the resolved project path, normalized to lowercase forward slashes. */
export function computeProjectRootHash(projectDir) {
  const normalized = normalizeProjectPath(projectDir);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function normalizeGoalText(goalText) {
  const collapsed = String(goalText ?? '').replace(/\s+/g, ' ').trim();
  const redacted = redactText(collapsed);
  return redacted.length > 300 ? redacted.slice(0, 300) : redacted;
}

/**
 * Build a fresh, schema-valid run state.
 * `git` (optional) may carry { branch, headShaShort, dirtyAtStart } detected
 * fail-soft by the caller; absent fields are simply omitted.
 */
export function createInitialState({
  goalText,
  sessionId,
  projectDir,
  lane,
  risk,
  complexity,
  budget,
  kryloVersion,
  runId,
  git,
}) {
  const ts = nowIso();
  const resolvedRunId = runId || `run-${crypto.randomBytes(6).toString('hex')}`;

  const project = { rootHash: computeProjectRootHash(projectDir) };
  if (git && typeof git === 'object') {
    if (isString(git.branch)) project.branch = git.branch;
    if (isString(git.headShaShort)) project.headShaShort = git.headShaShort.slice(0, 16);
    if (isBoolean(git.dirtyAtStart)) project.dirtyAtStart = git.dirtyAtStart;
  }

  const resolvedBudget = isInteger(budget) ? budget : (RISK_BUDGETS[risk] ?? RISK_BUDGETS.medium);

  return {
    schemaVersion: SCHEMA_VERSION,
    kryloVersion: kryloVersion || 'unknown',
    sessionId,
    runId: resolvedRunId,
    project,
    goal: {
      normalized: normalizeGoalText(goalText),
      lane,
      risk,
      ...(complexity ? { complexity } : {}),
    },
    acceptanceCriteria: [],
    agents: [],
    toolCounters: {},
    orbit: {
      budget: resolvedBudget,
      cycle: 0,
      stopBlocks: 0,
      fingerprints: [],
      stagnation: { cyclesWithoutProgress: 0, lastProgressCycle: 0 },
      strategyChanges: 0,
      requiredStrategyChange: false,
    },
    questionGate: { budget: 1, used: 0, grants: [] },
    riskApprovals: [],
    findings: [],
    evidence: [],
    phase: 'INITIALIZING',
    terminalState: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Validate one evidence record against evidence.schema.json. Returns an array of error strings. */
export function validateEvidence(e) {
  const errors = [];
  if (!isObject(e)) return ['must be an object'];

  const required = ['id', 'type', 'label', 'timestamp', 'sourceTool', 'result', 'summary', 'stale'];
  for (const req of required) if (!(req in e)) errors.push(`${req} is required`);

  const allowed = new Set([
    'id', 'type', 'label', 'timestamp', 'sourceTool', 'result', 'summary', 'artifactPath', 'stale', 'criterionRefs',
  ]);
  for (const k of Object.keys(e)) if (!allowed.has(k)) errors.push(`unexpected field ${k}`);

  if ('id' in e && (!isString(e.id) || !/^EV-\d{1,4}$/.test(e.id))) errors.push('id must match ^EV-\\d{1,4}$');
  if ('type' in e && !ENUMS.evidenceType.includes(e.type)) errors.push('type is not a valid evidence type');
  if ('label' in e && (!isString(e.label) || e.label.length > 120)) errors.push('label must be a string with maxLength 120');
  if ('timestamp' in e && !isString(e.timestamp)) errors.push('timestamp must be a string');
  if ('sourceTool' in e && (!isString(e.sourceTool) || e.sourceTool.length > 60)) errors.push('sourceTool must be a string with maxLength 60');
  if ('result' in e && !ENUMS.evidenceResult.includes(e.result)) errors.push('result is not a valid evidence result');
  if ('summary' in e && (!isString(e.summary) || e.summary.length > 300)) errors.push('summary must be a string with maxLength 300');
  if ('artifactPath' in e && !isStringOrNull(e.artifactPath)) errors.push('artifactPath must be a string or null');
  if ('stale' in e && !isBoolean(e.stale)) errors.push('stale must be a boolean');
  if ('criterionRefs' in e && (!isArray(e.criterionRefs) || !e.criterionRefs.every(isString))) {
    errors.push('criterionRefs must be an array of strings');
  }

  return errors;
}

/**
 * Hand-written structural validator kept in exact sync with
 * schemas/run-state.schema.json (cross-checked at runtime by
 * scripts/validation/validate-runtime.mjs).
 */
export function validateState(state) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (!isObject(state)) {
    return { valid: false, errors: ['state must be an object'] };
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in state)) push(`missing required field: ${key}`);
  }
  const allowedTop = new Set(REQUIRED_TOP_LEVEL);
  for (const key of Object.keys(state)) {
    if (!allowedTop.has(key)) push(`unexpected top-level field: ${key}`);
  }

  if ('schemaVersion' in state && (!isString(state.schemaVersion) || !/^\d+\.\d+\.\d+$/.test(state.schemaVersion))) {
    push('schemaVersion must match ^\\d+\\.\\d+\\.\\d+$');
  }
  if ('kryloVersion' in state && !isString(state.kryloVersion)) push('kryloVersion must be a string');
  if ('sessionId' in state && (!isString(state.sessionId) || state.sessionId.length < 1)) push('sessionId must be a non-empty string');
  if ('runId' in state && (!isString(state.runId) || !/^[A-Za-z0-9_-]{4,64}$/.test(state.runId))) push('runId must match ^[A-Za-z0-9_-]{4,64}$');

  if ('project' in state) {
    const p = state.project;
    if (!isObject(p)) {
      push('project must be an object');
    } else {
      if (!('rootHash' in p)) push('project.rootHash is required');
      else if (!isString(p.rootHash) || !/^[a-f0-9]{64}$/.test(p.rootHash)) push('project.rootHash must be a 64-char lowercase hex string');
      const allowed = new Set(['rootHash', 'branch', 'headShaShort', 'dirtyAtStart']);
      for (const k of Object.keys(p)) if (!allowed.has(k)) push(`unexpected field project.${k}`);
      if ('branch' in p && !isString(p.branch)) push('project.branch must be a string');
      if ('headShaShort' in p && (!isString(p.headShaShort) || p.headShaShort.length > 16)) push('project.headShaShort must be a string with maxLength 16');
      if ('dirtyAtStart' in p && !isBoolean(p.dirtyAtStart)) push('project.dirtyAtStart must be a boolean');
    }
  }

  if ('goal' in state) {
    const g = state.goal;
    if (!isObject(g)) {
      push('goal must be an object');
    } else {
      for (const req of ['normalized', 'lane', 'risk']) if (!(req in g)) push(`goal.${req} is required`);
      const allowed = new Set(['normalized', 'lane', 'risk', 'complexity']);
      for (const k of Object.keys(g)) if (!allowed.has(k)) push(`unexpected field goal.${k}`);
      if ('normalized' in g && (!isString(g.normalized) || g.normalized.length > 300)) push('goal.normalized must be a string with maxLength 300');
      if ('lane' in g && !ENUMS.lane.includes(g.lane)) push('goal.lane is not a valid lane');
      if ('risk' in g && !ENUMS.risk.includes(g.risk)) push('goal.risk is not a valid risk');
      if ('complexity' in g && !ENUMS.complexity.includes(g.complexity)) push('goal.complexity is not a valid complexity');
    }
  }

  if ('acceptanceCriteria' in state) {
    if (!isArray(state.acceptanceCriteria)) {
      push('acceptanceCriteria must be an array');
    } else {
      state.acceptanceCriteria.forEach((c, i) => {
        if (!isObject(c)) { push(`acceptanceCriteria[${i}] must be an object`); return; }
        for (const req of ['id', 'description', 'status']) if (!(req in c)) push(`acceptanceCriteria[${i}].${req} is required`);
        const allowed = new Set(['id', 'description', 'status', 'evidenceRefs']);
        for (const k of Object.keys(c)) if (!allowed.has(k)) push(`unexpected field acceptanceCriteria[${i}].${k}`);
        if ('id' in c && (!isString(c.id) || !/^AC-\d{1,3}$/.test(c.id))) push(`acceptanceCriteria[${i}].id must match ^AC-\\d{1,3}$`);
        if ('description' in c && (!isString(c.description) || c.description.length > 300)) push(`acceptanceCriteria[${i}].description must be a string with maxLength 300`);
        if ('status' in c && !ENUMS.criterionStatus.includes(c.status)) push(`acceptanceCriteria[${i}].status is invalid`);
        if ('evidenceRefs' in c && (!isArray(c.evidenceRefs) || !c.evidenceRefs.every(isString))) push(`acceptanceCriteria[${i}].evidenceRefs must be an array of strings`);
      });
    }
  }

  for (const field of ['constraints', 'nonGoals']) {
    if (field in state) {
      if (!isArray(state[field]) || !state[field].every((s) => isString(s) && s.length <= 300)) {
        push(`${field} must be an array of strings with maxLength 300`);
      }
    }
  }

  if ('agents' in state) {
    if (!isArray(state.agents)) {
      push('agents must be an array');
    } else {
      state.agents.forEach((a, i) => {
        if (!isObject(a)) { push(`agents[${i}] must be an object`); return; }
        for (const req of ['id', 'type', 'configuredModel', 'status']) if (!(req in a)) push(`agents[${i}].${req} is required`);
        const allowed = new Set(['id', 'type', 'configuredModel', 'resolvedModel', 'status', 'startedAt', 'endedAt', 'taskLabel']);
        for (const k of Object.keys(a)) if (!allowed.has(k)) push(`unexpected field agents[${i}].${k}`);
        if ('id' in a && !isString(a.id)) push(`agents[${i}].id must be a string`);
        if ('type' in a && !isString(a.type)) push(`agents[${i}].type must be a string`);
        if ('configuredModel' in a && !isString(a.configuredModel)) push(`agents[${i}].configuredModel must be a string`);
        if ('resolvedModel' in a && !isStringOrNull(a.resolvedModel)) push(`agents[${i}].resolvedModel must be a string or null`);
        if ('status' in a && !ENUMS.agentStatus.includes(a.status)) push(`agents[${i}].status is invalid`);
        if ('taskLabel' in a && (!isString(a.taskLabel) || a.taskLabel.length > 120)) push(`agents[${i}].taskLabel must be a string with maxLength 120`);
      });
    }
  }

  if ('toolCounters' in state) {
    if (!isObject(state.toolCounters)) {
      push('toolCounters must be an object');
    } else {
      for (const [k, v] of Object.entries(state.toolCounters)) {
        if (!isInteger(v) || v < 0) push(`toolCounters.${k} must be a non-negative integer`);
      }
    }
  }

  if ('orbit' in state) {
    const o = state.orbit;
    if (!isObject(o)) {
      push('orbit must be an object');
    } else {
      for (const req of ['budget', 'cycle', 'stopBlocks', 'fingerprints', 'stagnation']) if (!(req in o)) push(`orbit.${req} is required`);
      const allowed = new Set(['budget', 'cycle', 'stopBlocks', 'fingerprints', 'stagnation', 'strategyChanges', 'lastStrategy', 'requiredStrategyChange']);
      for (const k of Object.keys(o)) if (!allowed.has(k)) push(`unexpected field orbit.${k}`);
      if ('budget' in o && (!isInteger(o.budget) || o.budget < 1 || o.budget > 10)) push('orbit.budget must be an integer between 1 and 10');
      if ('cycle' in o && (!isInteger(o.cycle) || o.cycle < 0)) push('orbit.cycle must be a non-negative integer');
      if ('stopBlocks' in o && (!isInteger(o.stopBlocks) || o.stopBlocks < 0)) push('orbit.stopBlocks must be a non-negative integer');
      if ('fingerprints' in o) {
        if (!isArray(o.fingerprints)) {
          push('orbit.fingerprints must be an array');
        } else {
          o.fingerprints.forEach((f, i) => {
            if (!isObject(f)) { push(`orbit.fingerprints[${i}] must be an object`); return; }
            for (const req of ['hash', 'category', 'count', 'firstSeenCycle', 'lastSeenCycle']) if (!(req in f)) push(`orbit.fingerprints[${i}].${req} is required`);
            const allowedF = new Set(['hash', 'category', 'count', 'firstSeenCycle', 'lastSeenCycle']);
            for (const k of Object.keys(f)) if (!allowedF.has(k)) push(`unexpected field orbit.fingerprints[${i}].${k}`);
            if ('hash' in f && (!isString(f.hash) || !/^[a-f0-9]{16,64}$/.test(f.hash))) push(`orbit.fingerprints[${i}].hash must match ^[a-f0-9]{16,64}$`);
            if ('category' in f && !ENUMS.fingerprintCategory.includes(f.category)) push(`orbit.fingerprints[${i}].category is invalid`);
            if ('count' in f && (!isInteger(f.count) || f.count < 1)) push(`orbit.fingerprints[${i}].count must be an integer >= 1`);
            if ('firstSeenCycle' in f && (!isInteger(f.firstSeenCycle) || f.firstSeenCycle < 0)) push(`orbit.fingerprints[${i}].firstSeenCycle must be a non-negative integer`);
            if ('lastSeenCycle' in f && (!isInteger(f.lastSeenCycle) || f.lastSeenCycle < 0)) push(`orbit.fingerprints[${i}].lastSeenCycle must be a non-negative integer`);
          });
        }
      }
      if ('stagnation' in o) {
        const s = o.stagnation;
        if (!isObject(s)) {
          push('orbit.stagnation must be an object');
        } else {
          for (const req of ['cyclesWithoutProgress', 'lastProgressCycle']) if (!(req in s)) push(`orbit.stagnation.${req} is required`);
          const allowedS = new Set(['cyclesWithoutProgress', 'lastProgressCycle']);
          for (const k of Object.keys(s)) if (!allowedS.has(k)) push(`unexpected field orbit.stagnation.${k}`);
          if ('cyclesWithoutProgress' in s && (!isInteger(s.cyclesWithoutProgress) || s.cyclesWithoutProgress < 0)) push('orbit.stagnation.cyclesWithoutProgress must be a non-negative integer');
          if ('lastProgressCycle' in s && (!isInteger(s.lastProgressCycle) || s.lastProgressCycle < 0)) push('orbit.stagnation.lastProgressCycle must be a non-negative integer');
        }
      }
      if ('strategyChanges' in o && (!isInteger(o.strategyChanges) || o.strategyChanges < 0)) push('orbit.strategyChanges must be a non-negative integer');
      if ('lastStrategy' in o && (!isString(o.lastStrategy) || o.lastStrategy.length > 200)) push('orbit.lastStrategy must be a string with maxLength 200');
      if ('requiredStrategyChange' in o && !isBoolean(o.requiredStrategyChange)) push('orbit.requiredStrategyChange must be a boolean');
    }
  }

  if ('questionGate' in state) {
    const q = state.questionGate;
    if (!isObject(q)) {
      push('questionGate must be an object');
    } else {
      for (const req of ['budget', 'used', 'grants']) if (!(req in q)) push(`questionGate.${req} is required`);
      const allowed = new Set(['budget', 'used', 'grants']);
      for (const k of Object.keys(q)) if (!allowed.has(k)) push(`unexpected field questionGate.${k}`);
      if ('budget' in q && (!isInteger(q.budget) || q.budget < 0 || q.budget > 3)) push('questionGate.budget must be an integer between 0 and 3');
      if ('used' in q && (!isInteger(q.used) || q.used < 0)) push('questionGate.used must be a non-negative integer');
      if ('grants' in q) {
        if (!isArray(q.grants)) {
          push('questionGate.grants must be an array');
        } else {
          q.grants.forEach((g, i) => {
            if (!isObject(g)) { push(`questionGate.grants[${i}] must be an object`); return; }
            for (const req of ['id', 'category', 'status', 'grantedAt']) if (!(req in g)) push(`questionGate.grants[${i}].${req} is required`);
            const allowedG = new Set(['id', 'category', 'status', 'grantedAt', 'consumedAt']);
            for (const k of Object.keys(g)) if (!allowedG.has(k)) push(`unexpected field questionGate.grants[${i}].${k}`);
            if ('id' in g && !isString(g.id)) push(`questionGate.grants[${i}].id must be a string`);
            if ('category' in g && !ENUMS.questionCategory.includes(g.category)) push(`questionGate.grants[${i}].category is invalid`);
            if ('status' in g && !ENUMS.grantStatus.includes(g.status)) push(`questionGate.grants[${i}].status is invalid`);
            if ('grantedAt' in g && !isString(g.grantedAt)) push(`questionGate.grants[${i}].grantedAt must be a string`);
            if ('consumedAt' in g && !isStringOrNull(g.consumedAt)) push(`questionGate.grants[${i}].consumedAt must be a string or null`);
          });
        }
      }
    }
  }

  if ('riskApprovals' in state) {
    if (!isArray(state.riskApprovals)) {
      push('riskApprovals must be an array');
    } else {
      state.riskApprovals.forEach((r, i) => {
        if (!isObject(r)) { push(`riskApprovals[${i}] must be an object`); return; }
        for (const req of ['id', 'actionClass', 'status', 'requestedAt']) if (!(req in r)) push(`riskApprovals[${i}].${req} is required`);
        const allowed = new Set(['id', 'actionClass', 'status', 'requestedAt', 'resolvedAt', 'summary']);
        for (const k of Object.keys(r)) if (!allowed.has(k)) push(`unexpected field riskApprovals[${i}].${k}`);
        if ('id' in r && !isString(r.id)) push(`riskApprovals[${i}].id must be a string`);
        if ('actionClass' in r && !ENUMS.actionClass.includes(r.actionClass)) push(`riskApprovals[${i}].actionClass is invalid`);
        if ('status' in r && !ENUMS.approvalStatus.includes(r.status)) push(`riskApprovals[${i}].status is invalid`);
        if ('requestedAt' in r && !isString(r.requestedAt)) push(`riskApprovals[${i}].requestedAt must be a string`);
        if ('resolvedAt' in r && !isStringOrNull(r.resolvedAt)) push(`riskApprovals[${i}].resolvedAt must be a string or null`);
        if ('summary' in r && (!isString(r.summary) || r.summary.length > 200)) push(`riskApprovals[${i}].summary must be a string with maxLength 200`);
      });
    }
  }

  if ('findings' in state) {
    if (!isArray(state.findings)) {
      push('findings must be an array');
    } else {
      state.findings.forEach((f, i) => {
        if (!isObject(f)) { push(`findings[${i}] must be an object`); return; }
        for (const req of ['id', 'severity', 'status', 'summary']) if (!(req in f)) push(`findings[${i}].${req} is required`);
        const allowed = new Set(['id', 'severity', 'status', 'summary', 'source']);
        for (const k of Object.keys(f)) if (!allowed.has(k)) push(`unexpected field findings[${i}].${k}`);
        if ('id' in f && !isString(f.id)) push(`findings[${i}].id must be a string`);
        if ('severity' in f && !ENUMS.findingSeverity.includes(f.severity)) push(`findings[${i}].severity is invalid`);
        if ('status' in f && !ENUMS.findingStatus.includes(f.status)) push(`findings[${i}].status is invalid`);
        if ('summary' in f && (!isString(f.summary) || f.summary.length > 300)) push(`findings[${i}].summary must be a string with maxLength 300`);
        if ('source' in f && (!isString(f.source) || f.source.length > 60)) push(`findings[${i}].source must be a string with maxLength 60`);
      });
    }
  }

  if ('evidence' in state) {
    if (!isArray(state.evidence)) {
      push('evidence must be an array');
    } else {
      state.evidence.forEach((e, i) => {
        for (const err of validateEvidence(e)) push(`evidence[${i}].${err}`);
      });
    }
  }

  if ('phase' in state && !ENUMS.phase.includes(state.phase)) push('phase is invalid');

  if ('terminalState' in state) {
    if (state.terminalState !== null && !ENUMS.terminalState.includes(state.terminalState)) push('terminalState is invalid');
  }

  for (const field of ['createdAt', 'updatedAt']) {
    if (field in state && !isString(state[field])) push(`${field} must be a string`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate whether a run may be declared VERIFIED_COMPLETE.
 * Complete only when:
 *  - there is at least one acceptance criterion,
 *  - every criterion is proven or not-applicable,
 *  - no critical/high finding is open,
 *  - no risk approval is pending,
 *  - every proven criterion has at least one evidenceRef pointing to a
 *    non-stale evidence record with result "pass".
 */
export function completionEval(state) {
  const reasons = [];
  const criteria = isArray(state.acceptanceCriteria) ? state.acceptanceCriteria : [];

  if (criteria.length === 0) {
    reasons.push('no acceptance criteria are defined');
  }

  for (const c of criteria) {
    if (!['proven', 'not-applicable'].includes(c.status)) {
      reasons.push(`criterion ${c.id} has status "${c.status}" (must be proven or not-applicable)`);
    }
  }

  const findings = isArray(state.findings) ? state.findings : [];
  for (const f of findings) {
    if ((f.severity === 'critical' || f.severity === 'high') && f.status === 'open') {
      reasons.push(`finding ${f.id} is open with severity ${f.severity}`);
    }
  }

  const approvals = isArray(state.riskApprovals) ? state.riskApprovals : [];
  for (const a of approvals) {
    if (a.status === 'pending') {
      reasons.push(`risk approval ${a.id} is pending`);
    }
  }

  const evidenceById = new Map();
  for (const e of isArray(state.evidence) ? state.evidence : []) {
    evidenceById.set(e.id, e);
  }
  for (const c of criteria) {
    if (c.status !== 'proven') continue;
    const refs = isArray(c.evidenceRefs) ? c.evidenceRefs : [];
    const hasValidEvidence = refs.some((refId) => {
      const ev = evidenceById.get(refId);
      return Boolean(ev) && ev.stale === false && ev.result === 'pass';
    });
    if (!hasValidEvidence) {
      reasons.push(`criterion ${c.id} is proven but has no non-stale passing evidence reference`);
    }
  }

  return { complete: reasons.length === 0, reasons };
}

function preserveCorruptState(statePath, failure) {
  const epoch = Date.now();
  const corruptPath = path.join(path.dirname(statePath), `state.corrupt-${epoch}.json`);
  try {
    if (fs.existsSync(statePath)) {
      fs.copyFileSync(statePath, corruptPath);
    } else if (isString(failure.raw)) {
      fs.writeFileSync(corruptPath, failure.raw, 'utf8');
    }
  } catch {
    // Preservation is best-effort; it must never crash the caller.
  }
  return {
    ok: false,
    error: 'corrupted',
    recovered: true,
    corruptPath,
    details: failure.error || 'unknown',
  };
}

/**
 * Load a run's state. Never throws. Corrupted or schema-invalid state is
 * preserved as state.corrupt-<epoch>.json beside the original and reported
 * via a recovery indicator instead of being trusted.
 */
export function loadState(runId) {
  const statePath = runStatePath(runId);
  const result = readJson(statePath);

  if (!result.ok) {
    if (result.error === 'not-found') {
      return { ok: false, error: 'not-found' };
    }
    return preserveCorruptState(statePath, result);
  }

  const { valid, errors } = validateState(result.value);
  if (!valid) {
    return preserveCorruptState(statePath, { error: 'invalid-schema', raw: JSON.stringify(result.value), validationErrors: errors });
  }

  return { ok: true, value: result.value };
}

/**
 * Validate then atomically persist a run state, refreshing updatedAt.
 * Never writes state that fails validation.
 */
export function saveState(state) {
  const updated = { ...state, updatedAt: nowIso() };
  const { valid, errors } = validateState(updated);
  if (!valid) {
    return { ok: false, error: 'invalid', errors };
  }
  const statePath = runStatePath(updated.runId);
  writeJsonAtomic(statePath, updated);
  return { ok: true, value: updated };
}

export function readCurrentRunPointer() {
  const result = readJson(currentRunPointerPath());
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: result.value };
}

export function writeCurrentRunPointer({ runId, projectRootHash, sessionId }) {
  const value = { runId, projectRootHash, sessionId, updatedAt: nowIso() };
  ensureDir(path.dirname(currentRunPointerPath()));
  writeJsonAtomic(currentRunPointerPath(), value);
  return value;
}

export function clearCurrentRunPointer() {
  try {
    fs.rmSync(currentRunPointerPath(), { force: true });
  } catch {
    // ignore: pointer may already be absent
  }
}
