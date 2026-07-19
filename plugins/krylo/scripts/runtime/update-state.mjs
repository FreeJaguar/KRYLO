#!/usr/bin/env node
// Apply one or more mutation operations to a run's state, validate, and
// atomically save. Every mutation refreshes updatedAt (via saveState).
// Unknown operations abort before anything is applied.

import {
  loadState,
  saveState,
  readCurrentRunPointer,
  clearCurrentRunPointer,
  completionEval,
  ENUMS,
  validateEvidence,
} from '../lib/state.mjs';
import { deepRedact, redactText } from '../lib/redact.mjs';
import { recordEvent } from '../lib/telemetry.mjs';

function nowIso() {
  return new Date().toISOString();
}

function nextNumericId(list, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const item of list) {
    const m = item && typeof item.id === 'string' ? re.exec(item.id) : null;
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

function fail(error, extra = {}) {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(1);
}

function parseArgv(argv) {
  let runId;
  const ops = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run':
        runId = argv[++i];
        break;
      case '--phase':
        ops.push({ op: 'phase', value: argv[++i] });
        break;
      case '--add-criterion':
        ops.push({ op: 'add-criterion', value: argv[++i] });
        break;
      case '--set-criterion': {
        const value = argv[++i];
        let evidenceIds = [];
        if (argv[i + 1] === '--evidence') {
          evidenceIds = (argv[i + 2] || '').split(',').map((s) => s.trim()).filter(Boolean);
          i += 2;
        }
        ops.push({ op: 'set-criterion', value, evidenceIds });
        break;
      }
      case '--add-evidence':
        ops.push({ op: 'add-evidence', value: argv[++i] });
        break;
      case '--mark-evidence-stale':
        ops.push({ op: 'mark-evidence-stale' });
        break;
      case '--register-agent':
        ops.push({ op: 'register-agent', value: argv[++i] });
        break;
      case '--agent-status':
        ops.push({ op: 'agent-status', value: argv[++i] });
        break;
      case '--count-tool':
        ops.push({ op: 'count-tool', value: argv[++i] });
        break;
      case '--orbit-cycle':
        ops.push({ op: 'orbit-cycle' });
        break;
      case '--note-strategy':
        ops.push({ op: 'note-strategy', value: argv[++i] });
        break;
      case '--require-strategy-change':
        ops.push({ op: 'require-strategy-change', value: argv[++i] });
        break;
      case '--record-progress':
        ops.push({ op: 'record-progress' });
        break;
      case '--record-no-progress':
        ops.push({ op: 'record-no-progress' });
        break;
      case '--add-fingerprint':
        ops.push({ op: 'add-fingerprint', value: argv[++i] });
        break;
      case '--grant-question':
        ops.push({ op: 'grant-question', value: argv[++i] });
        break;
      case '--consume-question':
        ops.push({ op: 'consume-question', value: argv[++i] });
        break;
      case '--request-approval': {
        const actionClass = argv[++i];
        let summary;
        if (argv[i + 1] === '--summary') {
          summary = argv[i + 2];
          i += 2;
        }
        ops.push({ op: 'request-approval', actionClass, summary });
        break;
      }
      case '--resolve-approval':
        ops.push({ op: 'resolve-approval', value: argv[++i] });
        break;
      case '--add-finding':
        ops.push({ op: 'add-finding', value: argv[++i] });
        break;
      case '--set-finding':
        ops.push({ op: 'set-finding', value: argv[++i] });
        break;
      case '--stop-block':
        ops.push({ op: 'stop-block' });
        break;
      case '--terminal':
        ops.push({ op: 'terminal', value: argv[++i] });
        break;
      default:
        ops.push({ op: 'unknown', value: a });
        break;
    }
  }

  return { runId, ops };
}

function clearCurrentRunPointerIfMatches(runId) {
  const pointer = readCurrentRunPointer();
  if (pointer.ok && pointer.value && pointer.value.runId === runId) {
    clearCurrentRunPointer();
  }
}

function applyOp(state, op, runId) {
  switch (op.op) {
    case 'phase': {
      if (!ENUMS.phase.includes(op.value)) return { error: 'invalid-phase' };
      state.phase = op.value;
      return {};
    }

    case 'add-criterion': {
      const id = nextNumericId(state.acceptanceCriteria, 'AC');
      state.acceptanceCriteria.push({
        id,
        description: redactText(String(op.value ?? '')).slice(0, 300),
        status: 'pending',
        evidenceRefs: [],
      });
      return {};
    }

    case 'set-criterion': {
      const [id, status] = String(op.value ?? '').split('=');
      if (!ENUMS.criterionStatus.includes(status)) return { error: 'invalid-criterion-status' };
      const criterion = state.acceptanceCriteria.find((c) => c.id === id);
      if (!criterion) return { error: 'criterion-not-found' };
      criterion.status = status;
      if (op.evidenceIds && op.evidenceIds.length > 0) {
        criterion.evidenceRefs = Array.from(new Set([...(criterion.evidenceRefs || []), ...op.evidenceIds]));
      }
      return {};
    }

    case 'add-evidence': {
      let parsed;
      try {
        parsed = JSON.parse(op.value);
      } catch {
        return { error: 'invalid-evidence-json' };
      }
      const id = nextNumericId(state.evidence, 'EV');
      const record = deepRedact({
        id,
        type: parsed.type,
        label: parsed.label,
        timestamp: nowIso(),
        sourceTool: parsed.sourceTool,
        result: parsed.result,
        summary: parsed.summary,
        artifactPath: parsed.artifactPath ?? null,
        stale: false,
        ...(parsed.criterionRefs ? { criterionRefs: parsed.criterionRefs } : {}),
      });
      const errs = validateEvidence(record);
      if (errs.length > 0) return { error: 'invalid-evidence', details: errs };
      state.evidence.push(record);
      return {};
    }

    case 'mark-evidence-stale': {
      state.evidence = state.evidence.map((e) => ({ ...e, stale: true }));
      return {};
    }

    case 'register-agent': {
      let parsed;
      try {
        parsed = JSON.parse(op.value);
      } catch {
        return { error: 'invalid-agent-json' };
      }
      if (!parsed.type || !parsed.configuredModel) return { error: 'agent-requires-type-and-model' };
      const id = nextNumericId(state.agents, 'agent');
      const status = ENUMS.agentStatus.includes(parsed.status) ? parsed.status : 'running';
      state.agents.push(deepRedact({
        id,
        type: parsed.type,
        configuredModel: parsed.configuredModel,
        resolvedModel: parsed.resolvedModel ?? null,
        status,
        startedAt: nowIso(),
        endedAt: null,
        ...(parsed.taskLabel ? { taskLabel: String(parsed.taskLabel).slice(0, 120) } : {}),
      }));
      return {};
    }

    case 'agent-status': {
      const [id, status] = String(op.value ?? '').split('=');
      if (!ENUMS.agentStatus.includes(status)) return { error: 'invalid-agent-status' };
      const agent = state.agents.find((a) => a.id === id);
      if (!agent) return { error: 'agent-not-found' };
      agent.status = status;
      if (['completed', 'failed', 'stopped', 'cancelled'].includes(status)) {
        agent.endedAt = nowIso();
      }
      return {};
    }

    case 'count-tool': {
      const name = op.value;
      if (!name) return { error: 'tool-name-required' };
      state.toolCounters[name] = (state.toolCounters[name] || 0) + 1;
      recordEvent(runId, { ts: nowIso(), event: 'tool-count', toolName: name });
      return {};
    }

    case 'orbit-cycle': {
      state.orbit.cycle += 1;
      return {};
    }

    case 'note-strategy': {
      state.orbit.lastStrategy = redactText(String(op.value ?? '')).slice(0, 200);
      state.orbit.strategyChanges += 1;
      return {};
    }

    case 'require-strategy-change': {
      if (op.value !== 'true' && op.value !== 'false') return { error: 'invalid-boolean' };
      state.orbit.requiredStrategyChange = op.value === 'true';
      return {};
    }

    case 'record-progress': {
      state.orbit.stagnation.cyclesWithoutProgress = 0;
      state.orbit.stagnation.lastProgressCycle = state.orbit.cycle;
      return {};
    }

    case 'record-no-progress': {
      state.orbit.stagnation.cyclesWithoutProgress += 1;
      return {};
    }

    case 'add-fingerprint': {
      const raw = String(op.value ?? '');
      const idx = raw.indexOf(':');
      if (idx < 0) return { error: 'invalid-fingerprint-format' };
      const category = raw.slice(0, idx);
      const hash = raw.slice(idx + 1);
      if (!ENUMS.fingerprintCategory.includes(category)) return { error: 'invalid-fingerprint-category' };
      if (!/^[a-f0-9]{16,64}$/.test(hash)) return { error: 'invalid-fingerprint-hash' };
      const existing = state.orbit.fingerprints.find((f) => f.hash === hash);
      if (existing) {
        existing.count += 1;
        existing.lastSeenCycle = state.orbit.cycle;
      } else {
        state.orbit.fingerprints.push({
          hash,
          category,
          count: 1,
          firstSeenCycle: state.orbit.cycle,
          lastSeenCycle: state.orbit.cycle,
        });
      }
      return {};
    }

    case 'grant-question': {
      const category = op.value;
      if (!ENUMS.questionCategory.includes(category)) return { error: 'invalid-question-category' };
      if (state.questionGate.used >= state.questionGate.budget) return { error: 'question-budget-exhausted' };
      const id = nextNumericId(state.questionGate.grants, 'qg');
      state.questionGate.grants.push({ id, category, status: 'available', grantedAt: nowIso(), consumedAt: null });
      state.questionGate.used += 1;
      return {};
    }

    case 'consume-question': {
      const grant = state.questionGate.grants.find((g) => g.id === op.value);
      if (!grant) return { error: 'grant-not-found' };
      if (grant.status !== 'available') return { error: 'grant-not-available' };
      grant.status = 'consumed';
      grant.consumedAt = nowIso();
      return {};
    }

    case 'request-approval': {
      if (!ENUMS.actionClass.includes(op.actionClass)) return { error: 'invalid-action-class' };
      const id = nextNumericId(state.riskApprovals, 'ra');
      state.riskApprovals.push(deepRedact({
        id,
        actionClass: op.actionClass,
        status: 'pending',
        requestedAt: nowIso(),
        resolvedAt: null,
        ...(op.summary ? { summary: op.summary.slice(0, 200) } : {}),
      }));
      return {};
    }

    case 'resolve-approval': {
      const [id, status] = String(op.value ?? '').split('=');
      if (!['approved', 'denied'].includes(status)) return { error: 'invalid-approval-status' };
      const approval = state.riskApprovals.find((a) => a.id === id);
      if (!approval) return { error: 'approval-not-found' };
      approval.status = status;
      approval.resolvedAt = nowIso();
      return {};
    }

    case 'add-finding': {
      let parsed;
      try {
        parsed = JSON.parse(op.value);
      } catch {
        return { error: 'invalid-finding-json' };
      }
      if (!ENUMS.findingSeverity.includes(parsed.severity)) return { error: 'invalid-finding-severity' };
      const id = typeof parsed.id === 'string' ? parsed.id : nextNumericId(state.findings, 'finding');
      state.findings.push(deepRedact({
        id,
        severity: parsed.severity,
        status: 'open',
        summary: parsed.summary,
        ...(parsed.source ? { source: parsed.source } : {}),
      }));
      return {};
    }

    case 'set-finding': {
      const [id, status] = String(op.value ?? '').split('=');
      if (!ENUMS.findingStatus.includes(status)) return { error: 'invalid-finding-status' };
      const finding = state.findings.find((f) => f.id === id);
      if (!finding) return { error: 'finding-not-found' };
      finding.status = status;
      return {};
    }

    case 'stop-block': {
      state.orbit.stopBlocks += 1;
      return {};
    }

    case 'terminal': {
      if (!ENUMS.terminalState.includes(op.value)) return { error: 'invalid-terminal-state' };
      if (op.value === 'VERIFIED_COMPLETE') {
        const evalResult = completionEval(state);
        if (!evalResult.complete) return { error: 'completion-gate-failed', details: evalResult.reasons };
      }
      state.terminalState = op.value;
      const phaseByTerminal = {
        VERIFIED_COMPLETE: 'COMPLETING',
        SAFE_BLOCKED: 'BLOCKED',
        USER_DECISION_REQUIRED: 'AWAITING_DECISION',
        RISK_APPROVAL_REQUIRED: 'AWAITING_RISK_APPROVAL',
        ITERATION_LIMIT_REACHED: 'ITERATION_LIMIT',
      };
      state.phase = phaseByTerminal[op.value] || state.phase;
      clearCurrentRunPointerIfMatches(runId);
      return {};
    }

    default:
      return { error: 'unknown-op' };
  }
}

function main() {
  const { runId: explicitRunId, ops } = parseArgv(process.argv.slice(2));

  let runId = explicitRunId;
  if (!runId) {
    const pointer = readCurrentRunPointer();
    if (!pointer.ok || !pointer.value || !pointer.value.runId) {
      fail('no-current-run');
      return;
    }
    runId = pointer.value.runId;
  }

  const loaded = loadState(runId);
  if (!loaded.ok) {
    fail('load-failed', { details: loaded.error });
    return;
  }
  const state = loaded.value;

  const applied = [];
  for (const op of ops) {
    const result = applyOp(state, op, runId);
    if (result && result.error) {
      fail(result.error, { op: op.op, details: result.details });
      return;
    }
    applied.push(op.op);
  }

  const saveResult = saveState(state);
  if (!saveResult.ok) {
    fail('invalid-state', { details: saveResult.errors });
    return;
  }

  console.log(JSON.stringify({ ok: true, runId, applied }));
  process.exit(0);
}

main();
