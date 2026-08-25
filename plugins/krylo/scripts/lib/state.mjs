// KRYLO run-state model: creation, hand-written structural validation
// (kept in sync with schemas/run-state.schema.json and evidence.schema.json),
// persistence with corruption recovery, completion evaluation, and the
// current-run pointer.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  ensureDir,
  runStatePath,
  currentRunPointerPath,
  legacyActiveRunPointerPath,
  activeRunPointerPath,
  activeRunsHostDir,
} from './paths.mjs';
import { writeJsonAtomic, readJson } from './atomic.mjs';
import { redactText } from './redact.mjs';
import { HOST_NAMES } from './host-context.mjs';
import { CURRENT_STATE_SCHEMA_VERSION, migrateStateDocument } from './state-migrations.mjs';

export const SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;

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
    'repository-admin',
    'cross-harness-invocation',
    'other',
  ],
  approvalStatus: ['pending', 'approved', 'denied', 'consumed', 'expired'],
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
  'host',
  'delegation',
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

/**
 * `path.resolve` only understands backslash as a separator on Windows: on
 * POSIX it treats a literal `\` as a normal filename character, so a
 * Windows-spelled absolute path (`C:\Users\...`) and its forward-slash
 * equivalent (`C:/Users/...`) resolve to two different, unrelated paths when
 * this runs on Linux/macOS instead of Windows — breaking the project-root
 * hash's one guarantee (the same logical project always hashes the same).
 * Converting `\` to `/` before resolving makes the two spellings identical
 * *before* any OS-specific resolution happens, so the hash is stable
 * regardless of which separator style was used to spell the path, on any OS.
 */
function normalizeProjectPath(projectDir) {
  const slashified = String(projectDir).replace(/\\/g, '/');
  const resolved = path.resolve(slashified);
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
  hostIdentity,
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
    host: {
      name: hostIdentity.host,
      sessionId: hostIdentity.hostSessionId,
      ...(hostIdentity.hostTurnId ? { turnId: hostIdentity.hostTurnId } : {}),
    },
    delegation: {
      externalWorker: false,
      depth: 0,
    },
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
  if ('runId' in state && (!isString(state.runId) || !/^[A-Za-z0-9_-]{4,64}$/.test(state.runId))) push('runId must match ^[A-Za-z0-9_-]{4,64}$');

  if ('host' in state) {
    const h = state.host;
    if (!isObject(h)) {
      push('host must be an object');
    } else {
      for (const req of ['name', 'sessionId']) if (!(req in h)) push(`host.${req} is required`);
      const allowed = new Set(['name', 'sessionId', 'turnId']);
      for (const k of Object.keys(h)) if (!allowed.has(k)) push(`unexpected field host.${k}`);
      if ('name' in h && !HOST_NAMES.includes(h.name)) push('host.name is not a supported host');
      if ('sessionId' in h && (!isString(h.sessionId) || h.sessionId.length < 1 || h.sessionId.length > 256)) push('host.sessionId must be a non-empty string with maxLength 256');
      if ('turnId' in h && (!isString(h.turnId) || h.turnId.length < 1 || h.turnId.length > 256)) push('host.turnId must be a non-empty string with maxLength 256');
    }
  }

  if ('delegation' in state) {
    const d = state.delegation;
    if (!isObject(d)) {
      push('delegation must be an object');
    } else {
      for (const req of ['externalWorker', 'depth']) if (!(req in d)) push(`delegation.${req} is required`);
      const allowed = new Set(['externalWorker', 'depth', 'parentRunId']);
      for (const k of Object.keys(d)) if (!allowed.has(k)) push(`unexpected field delegation.${k}`);
      if ('externalWorker' in d && !isBoolean(d.externalWorker)) push('delegation.externalWorker must be a boolean');
      if ('depth' in d && (!isInteger(d.depth) || d.depth < 0 || d.depth > 1)) push('delegation.depth must be an integer between 0 and 1');
      if ('parentRunId' in d && (!isString(d.parentRunId) || !/^[A-Za-z0-9_-]{4,64}$/.test(d.parentRunId))) push('delegation.parentRunId must match ^[A-Za-z0-9_-]{4,64}$');
    }
  }

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
        const allowed = new Set([
          'id', 'actionClass', 'status', 'requestedAt', 'resolvedAt', 'summary',
          'projectRootHash', 'runId', 'environment', 'expiresAt', 'consumedAt', 'fingerprint', 'target',
        ]);
        for (const k of Object.keys(r)) if (!allowed.has(k)) push(`unexpected field riskApprovals[${i}].${k}`);
        if ('id' in r && !isString(r.id)) push(`riskApprovals[${i}].id must be a string`);
        if ('actionClass' in r && !ENUMS.actionClass.includes(r.actionClass)) push(`riskApprovals[${i}].actionClass is invalid`);
        if ('status' in r && !ENUMS.approvalStatus.includes(r.status)) push(`riskApprovals[${i}].status is invalid`);
        if ('requestedAt' in r && !isString(r.requestedAt)) push(`riskApprovals[${i}].requestedAt must be a string`);
        if ('resolvedAt' in r && !isStringOrNull(r.resolvedAt)) push(`riskApprovals[${i}].resolvedAt must be a string or null`);
        if ('summary' in r && (!isString(r.summary) || r.summary.length > 200)) push(`riskApprovals[${i}].summary must be a string with maxLength 200`);
        if ('projectRootHash' in r && (!isString(r.projectRootHash) || !/^[a-f0-9]{64}$/.test(r.projectRootHash))) push(`riskApprovals[${i}].projectRootHash must be a 64-char lowercase hex string`);
        if ('runId' in r && !isString(r.runId)) push(`riskApprovals[${i}].runId must be a string`);
        if ('environment' in r && !isStringOrNull(r.environment)) push(`riskApprovals[${i}].environment must be a string or null`);
        if ('expiresAt' in r && !isStringOrNull(r.expiresAt)) push(`riskApprovals[${i}].expiresAt must be a string or null`);
        if ('consumedAt' in r && !isStringOrNull(r.consumedAt)) push(`riskApprovals[${i}].consumedAt must be a string or null`);
        if ('fingerprint' in r && !isStringOrNull(r.fingerprint)) push(`riskApprovals[${i}].fingerprint must be a string or null`);
        if ('target' in r && (!isStringOrNull(r.target) || (isString(r.target) && r.target.length > 300))) push(`riskApprovals[${i}].target must be a string (maxLength 300) or null`);
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

/**
 * Transition one pending risk approval to `denied`. The only legitimate
 * caller is update-state.mjs's CLI `resolve-approval` op (a model backing
 * off its own request is harmless). This function itself refuses any status
 * other than `denied` -- in particular `approved` -- as defense in depth:
 * nothing in the codebase should ever again be able to set `approved`
 * (docs/adr/0025-native-permission-approval.md), since a KRYLO-local
 * approval record can no longer, on its own, authorize execution for any
 * tool, and a future caller must not be able to reintroduce that by simply
 * calling this function with a different status string. `approved` remains
 * a valid enum value in the schema only for backward-compatibility with
 * state persisted before this checkpoint. Called under the same run lock
 * used everywhere else state is mutated. Pure: does not load, save, or lock
 * anything itself.
 */
export function applyApprovalResolution(state, id, status) {
  if (status !== 'denied') return { error: 'invalid-approval-status' };
  const approval = (state.riskApprovals || []).find((a) => a.id === id);
  if (!approval) return { error: 'approval-not-found' };
  if (approval.status !== 'pending') return { error: 'approval-not-pending' };
  approval.status = status;
  approval.resolvedAt = nowIso();
  return { ok: true, approval };
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
 *
 * Version-aware: a real prior-schema document is migrated to the CURRENT
 * schema IN MEMORY ONLY and validated against the current validator. A
 * schema version this build does not know how to migrate is refused
 * (a distinct, non-'corrupted' error) and the original file is left exactly
 * as it was -- never renamed away, never guessed at, never overwritten.
 *
 * loadState() never writes a MIGRATED document to disk -- that is a
 * distinct claim from "never writes at all" (the corrupt/invalid-state
 * preservation write above is a real exception, and remains one). This is
 * deliberate (security-hardening checkpoint, SECURITY BLOCKER 2):
 * persisting a migration is a state.json mutation, and this function is
 * called from many places that hold no lock at all (read-state.mjs,
 * statusline/doctor/stagnation convenience readers, every Hook's initial
 * resolveActiveRun() check). If loadState() itself wrote the migrated
 * document, two concurrent unlocked (or differently-locked) callers could
 * race: one persists a migrated copy computed from a stale read, after
 * another has already locked, loaded, mutated, and saved -- silently
 * reverting that mutation. Since loadState() only ever returns an in-memory
 * migrated value, the one and only place a migration is actually committed
 * to disk is saveState(), which every real mutator already calls from
 * within the run's exclusive lock (scripts/lib/lock.mjs, runLockPath) --
 * see saveState() below.
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

  const migration = migrateStateDocument(result.value);
  if (!migration.ok) {
    // Not corruption: either an already-invalid document shape, or a schema
    // version this build has no migration for. Either way, leave state.json
    // on disk exactly as it is and report a distinct, safe error instead of
    // destructively renaming/overwriting it.
    return { ok: false, error: migration.error, fromVersion: migration.fromVersion ?? null };
  }

  const { valid, errors } = validateState(migration.value);
  if (!valid) {
    return preserveCorruptState(statePath, { error: 'invalid-schema', raw: JSON.stringify(migration.value), validationErrors: errors });
  }

  return { ok: true, value: migration.value };
}

/**
 * Validate then atomically persist a run state, refreshing updatedAt.
 * Never writes state that fails validation.
 *
 * This is the ONLY place a schema migration is ever committed to disk (see
 * loadState() above). If the file currently on disk is at an older schema
 * version than the state being saved, its exact original bytes are backed
 * up first -- a one-time event, since every subsequent save sees a matching
 * schemaVersion and skips it. This happens inside whatever lock the caller
 * is already holding (every real mutator calls saveState() from within
 * withFileLock(runLockPath(runId), ...)), so it is exactly as serialized as
 * every other state mutation -- no separate or recursive lock is acquired
 * here, and none is needed.
 *
 * Migration backup safety: "no prior file exists" (a brand-new run -- there
 * is nothing to back up, and none is attempted) and "the backup write
 * itself failed" (a real I/O error -- permissions, disk full, ...) are
 * deliberately NOT the same code path. Only the read of the existing file is
 * allowed to fail silently (nothing to back up); if a prior file exists and
 * needs backing up but the backup write throws, this refuses the save
 * entirely rather than falling through to overwrite the original -- losing
 * the original after failing to preserve a copy of it would be exactly the
 * data loss the backup exists to prevent.
 */
export function saveState(state) {
  const updated = { ...state, updatedAt: nowIso() };
  const { valid, errors } = validateState(updated);
  if (!valid) {
    return { ok: false, error: 'invalid', errors };
  }
  const statePath = runStatePath(updated.runId);

  let currentRaw = null;
  try {
    currentRaw = fs.readFileSync(statePath, 'utf8');
  } catch {
    // No existing file (a brand-new run): nothing to back up, and the
    // absence of a file is never itself a failure.
    currentRaw = null;
  }

  if (currentRaw !== null) {
    let currentParsed = null;
    try {
      currentParsed = JSON.parse(currentRaw);
    } catch {
      currentParsed = null;
    }
    if (isString(currentParsed?.schemaVersion) && currentParsed.schemaVersion !== updated.schemaVersion) {
      const backupPath = path.join(path.dirname(statePath), `state.pre-migration-${currentParsed.schemaVersion}-${Date.now()}.json`);
      try {
        // Exact original on-disk bytes, not the migrated value, so the
        // backup is a faithful record of what was actually there before
        // this save.
        fs.writeFileSync(backupPath, currentRaw, 'utf8');
      } catch (err) {
        return { ok: false, error: 'backup-failed', details: err?.message || 'unknown' };
      }
    }
  }

  writeJsonAtomic(statePath, updated);
  return { ok: true, value: updated };
}

/**
 * Persist the pointer for one project + host + host-session triple. Two
 * projects never share a path (projectRootHash segment), two hosts never
 * share a path (host segment), and two sessions on the same host in the same
 * project never share a path (session segment), so concurrent runs cannot
 * overwrite each other. The write is atomic (temp file + rename).
 */
export function writeActiveRunPointer({ runId, projectRootHash, host, hostSessionId }) {
  const value = { runId, projectRootHash, host, hostSessionId, updatedAt: nowIso() };
  const pointerPath = activeRunPointerPath(projectRootHash, host, hostSessionId);
  ensureDir(path.dirname(pointerPath));
  writeJsonAtomic(pointerPath, value);
  return value;
}

/** Read every pointer file directly under one project's one host directory. Never scans another host. */
function listHostPointers(projectRootHash, host) {
  const dir = activeRunsHostDir(projectRootHash, host);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json'));
  } catch {
    return [];
  }
  const pointers = [];
  for (const entry of entries) {
    const result = readJson(path.join(dir, entry.name));
    // A corrupted or unreadable pointer file is simply skipped (treated as
    // absent) rather than crashing the caller; it is harmless leftover state.
    if (result.ok && result.value && typeof result.value.runId === 'string') {
      pointers.push(result.value);
    }
  }
  return pointers;
}

/**
 * Lazy migration, Claude only: a pre-0.2.0 install may still have the flat
 * 0.1.1 pointer `active-runs/<project>/<session>.json` (no host segment). If
 * it exists, matches this project, and a hostSessionId is known, adopt it
 * into the new `active-runs/<project>/claude/<session>.json` layout and
 * remove the legacy file only once the new pointer is safely written.
 * Best-effort; never throws.
 */
function migrateLegacyFlatPointer(projectRootHash, hostSessionId) {
  if (!hostSessionId) return null;
  const legacyPath = legacyActiveRunPointerPath(projectRootHash, hostSessionId);
  const legacy = readJson(legacyPath);
  if (!legacy.ok || !legacy.value || typeof legacy.value.runId !== 'string') return null;
  if (legacy.value.projectRootHash && legacy.value.projectRootHash !== projectRootHash) return null;

  const value = {
    runId: legacy.value.runId,
    projectRootHash,
    host: 'claude',
    hostSessionId,
    updatedAt: isString(legacy.value.updatedAt) ? legacy.value.updatedAt : nowIso(),
  };
  try {
    const newPointerPath = activeRunPointerPath(projectRootHash, 'claude', hostSessionId);
    ensureDir(path.dirname(newPointerPath));
    writeJsonAtomic(newPointerPath, value);
    fs.rmSync(legacyPath, { force: true });
  } catch {
    // Migration is best-effort: the legacy pointer is still returned below
    // even if adopting it into the new layout did not succeed.
  }
  return value;
}

/**
 * One-time legacy migration attempt: a pre-0.1.1 install may still have a
 * single global current-run.json. If it matches this project, adopt it into
 * the claude host directory and remove the legacy file. Best-effort; never
 * throws.
 */
function migrateLegacyGlobalPointer(projectRootHash, hostSessionId) {
  const legacy = readJson(currentRunPointerPath());
  if (!legacy.ok || !legacy.value || legacy.value.projectRootHash !== projectRootHash) {
    return null;
  }
  const legacySessionId = isString(legacy.value.sessionId) ? legacy.value.sessionId : null;
  // The legacy pointer names its own session. If the caller's explicit
  // session is a different, identifiable session, adopting the pointer under
  // the caller would silently hand it another session's run -- refuse instead
  // and leave the legacy pointer exactly as it is for its rightful session.
  if (hostSessionId && legacySessionId && legacySessionId !== hostSessionId) {
    return null;
  }
  const adoptedSessionId = hostSessionId || legacySessionId || 'legacy';
  const value = {
    runId: legacy.value.runId,
    projectRootHash,
    host: 'claude',
    hostSessionId: adoptedSessionId,
    updatedAt: isString(legacy.value.updatedAt) ? legacy.value.updatedAt : nowIso(),
  };
  try {
    const newPointerPath = activeRunPointerPath(projectRootHash, 'claude', adoptedSessionId);
    ensureDir(path.dirname(newPointerPath));
    writeJsonAtomic(newPointerPath, value);
    fs.rmSync(currentRunPointerPath(), { force: true });
  } catch {
    // Migration is best-effort: the legacy pointer is still returned below
    // even if adopting it into the new layout did not succeed.
  }
  return value;
}

/**
 * Resolve the active run pointer for a project + host.
 *
 * When `hostSessionId` is explicitly known, ONLY that exact session's own
 * pointer (or its own legacy-migrated equivalent) is ever resolved. If it is
 * missing or corrupt, this returns not-found -- it never falls back to a
 * sibling session's pointer just because the requested one is unavailable.
 * An explicitly named session must never silently read or mutate a
 * different active session's run (see ADR-0020 and the multi-host Foundation
 * security-hardening checkpoint that tightened this).
 *
 * When `hostSessionId` is unknown (falsy/undefined), resolution falls back
 * to the single most recently updated pointer inside that host's directory
 * only (never another host's) -- ADR-0020's documented convenience default
 * for callers that genuinely do not know a session identity -- then to
 * one-time lazy migration of a pre-existing Claude pointer.
 *
 * `host` is required: a caller with no known host must not silently assume
 * Claude.
 */
export function readActiveRunPointer({ projectRootHash, host, hostSessionId } = {}) {
  if (!host) return { ok: false, error: 'host-required' };

  if (hostSessionId) {
    const direct = readJson(activeRunPointerPath(projectRootHash, host, hostSessionId));
    if (direct.ok) return direct;

    if (host === 'claude') {
      const migratedFlat = migrateLegacyFlatPointer(projectRootHash, hostSessionId);
      if (migratedFlat) return { ok: true, value: migratedFlat };

      const migratedGlobal = migrateLegacyGlobalPointer(projectRootHash, hostSessionId);
      if (migratedGlobal && migratedGlobal.hostSessionId === hostSessionId) return { ok: true, value: migratedGlobal };
    }

    // The exact session was named but has no pointer of its own (missing or
    // corrupt): fail safely. Do NOT fall through to another session's
    // pointer below.
    return { ok: false, error: 'not-found' };
  }

  const pointers = listHostPointers(projectRootHash, host);
  if (pointers.length > 0) {
    const best = pointers.reduce((a, b) => (String(b.updatedAt) > String(a.updatedAt) ? b : a));
    return { ok: true, value: best };
  }

  if (host === 'claude') {
    const migratedFlat = migrateLegacyFlatPointer(projectRootHash, hostSessionId);
    if (migratedFlat) return { ok: true, value: migratedFlat };

    const migratedGlobal = migrateLegacyGlobalPointer(projectRootHash, hostSessionId);
    if (migratedGlobal) return { ok: true, value: migratedGlobal };
  }

  return { ok: false, error: 'not-found' };
}

/**
 * Convenience wrapper for callers (statusline, doctor, stagnation CLI) that
 * only know a working directory, not a structured project/session pair.
 * `host` is required; a caller that knows no host must not silently assume
 * Claude inside Shared Core.
 */
export function readActiveRunPointerForCwd(cwd = process.cwd(), { host, hostSessionId } = {}) {
  if (!host) return { ok: false, error: 'host-required' };
  return readActiveRunPointer({
    projectRootHash: computeProjectRootHash(cwd),
    host,
    hostSessionId,
  });
}

/** Clear the pointer for a project + host + host-session triple, but only if it still names `runId`. */
export function clearActiveRunPointer({ projectRootHash, host, hostSessionId, runId }) {
  try {
    const pointerPath = activeRunPointerPath(projectRootHash, host, hostSessionId);
    const current = readJson(pointerPath);
    if (current.ok && current.value && (!runId || current.value.runId === runId)) {
      fs.rmSync(pointerPath, { force: true });
    }
  } catch {
    // ignore: pointer may already be absent
  }
}

/** Clear a run's own pointer using the identity recorded in its state (no external args needed). */
export function clearActiveRunPointerForState(state) {
  clearActiveRunPointer({
    projectRootHash: state.project.rootHash,
    host: state.host.name,
    hostSessionId: state.host.sessionId,
    runId: state.runId,
  });
}

/**
 * Remove pointer files whose run no longer exists or has reached a terminal
 * state. Best-effort; never throws. Traverses the nested
 * `active-runs/<project>/<host>/*.json` layout, one host directory at a
 * time, so pruning one host's stale pointers can never touch (let alone
 * remove) another host's active pointer -- each host directory is examined
 * in complete isolation from every other. Never follows a symlinked
 * directory (Dirent entries reflect lstat, so a symlinked directory already
 * fails `isDirectory()`; `!isSymbolicLink()` is kept as an explicit,
 * self-documenting guard). Also detects and safely handles stale pre-host-
 * scoping (0.1.1) flat pointer files sitting directly under a project
 * directory: a still-active one is migrated into the `claude` host
 * directory rather than discarded; a genuinely stale one is removed.
 */
export function pruneStaleActiveRunPointers(activeRunsRoot) {
  const removed = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(activeRunsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink());
  } catch {
    return removed;
  }
  for (const projectEntry of projectDirs) {
    const projectDir = path.join(activeRunsRoot, projectEntry.name);
    let projectEntries;
    try {
      projectEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const legacyFiles = projectEntries.filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.json'));
    for (const fileEntry of legacyFiles) {
      const pointerPath = path.join(projectDir, fileEntry.name);
      const pointer = readJson(pointerPath);
      const runId = pointer.ok && pointer.value ? pointer.value.runId : null;
      const loaded = typeof runId === 'string' ? loadState(runId) : { ok: false };
      const isActive = Boolean(pointer.ok && runId && loaded.ok && loaded.value.terminalState === null);
      if (isActive) {
        const sessionId = typeof pointer.value.sessionId === 'string' && pointer.value.sessionId.trim() !== ''
          ? pointer.value.sessionId
          : path.basename(fileEntry.name, '.json');
        try {
          const newPointerPath = activeRunPointerPath(projectEntry.name, 'claude', sessionId);
          ensureDir(path.dirname(newPointerPath));
          writeJsonAtomic(newPointerPath, {
            runId,
            projectRootHash: projectEntry.name,
            host: 'claude',
            hostSessionId: sessionId,
            updatedAt: isString(pointer.value.updatedAt) ? pointer.value.updatedAt : nowIso(),
          });
          fs.rmSync(pointerPath, { force: true });
        } catch {
          // best-effort: if migration fails, leave the legacy pointer in
          // place rather than losing track of a still-active run.
        }
      } else {
        try {
          fs.rmSync(pointerPath, { force: true });
          removed.push(path.join(projectEntry.name, fileEntry.name));
        } catch {
          // best-effort
        }
      }
    }

    const hostDirs = projectEntries.filter((e) => e.isDirectory() && !e.isSymbolicLink());
    for (const hostEntry of hostDirs) {
      const hostDir = path.join(projectDir, hostEntry.name);
      let pointerFiles;
      try {
        pointerFiles = fs.readdirSync(hostDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.json'));
      } catch {
        continue;
      }
      for (const fileEntry of pointerFiles) {
        const pointerPath = path.join(hostDir, fileEntry.name);
        const pointer = readJson(pointerPath);
        const runId = pointer.ok && pointer.value ? pointer.value.runId : null;
        const loaded = typeof runId === 'string' ? loadState(runId) : { ok: false };
        const isStale = !pointer.ok || !runId || !loaded.ok || loaded.value.terminalState !== null;
        if (isStale) {
          try {
            fs.rmSync(pointerPath, { force: true });
            removed.push(path.join(projectEntry.name, hostEntry.name, fileEntry.name));
          } catch {
            // best-effort
          }
        }
      }
    }
  }
  return removed;
}
