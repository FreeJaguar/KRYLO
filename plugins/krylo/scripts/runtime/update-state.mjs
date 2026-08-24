#!/usr/bin/env node
// Apply one or more mutation operations to a run's state, validate, and
// atomically save. Every mutation refreshes updatedAt (via saveState).
// Unknown operations abort before anything is applied.

import path from 'node:path';

import {
  loadState,
  saveState,
  readActiveRunPointer,
  clearActiveRunPointerForState,
  completionEval,
  computeProjectRootHash,
  applyApprovalResolution,
  ENUMS,
  validateEvidence,
} from '../lib/state.mjs';
import { deepRedact, redactText, redactAndTruncate } from '../lib/redact.mjs';
import { fingerprintText } from '../lib/action-fingerprint.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { runLockPath } from '../lib/paths.mjs';
import { bootstrapClaudeStorageEnvironment, resolveClaudeSessionId } from '../host/claude/context.mjs';

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
  let session;
  let projectDir;
  const ops = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run':
        runId = argv[++i];
        break;
      case '--session':
        session = argv[++i];
        break;
      case '--project-dir':
        projectDir = argv[++i];
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
        let target;
        while (argv[i + 1] === '--summary' || argv[i + 1] === '--target') {
          if (argv[i + 1] === '--summary') summary = argv[i + 2];
          else target = argv[i + 2];
          i += 2;
        }
        ops.push({ op: 'request-approval', actionClass, summary, target });
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

  return { runId, session, projectDir, ops };
}

function applyOp(state, op) {
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
      const environment = process.env.KRYLO_SECURITY_PROFILE || null;
      // Only `summary`/`target` are free text a caller could embed a secret
      // in; the rest are structural identifiers (a 64-hex project hash would
      // itself be mistaken for an opaque token and mangled by deepRedact).
      // An optional --target pre-binds this approval to the exact action:
      // the risk gate only lets a retry whose own fingerprint matches spend
      // it (scripts/lib/action-fingerprint.mjs). Without --target, any
      // action in this actionClass may consume it once (untargeted, still
      // single-use).
      state.riskApprovals.push({
        id,
        actionClass: op.actionClass,
        status: 'pending',
        requestedAt: nowIso(),
        resolvedAt: null,
        projectRootHash: state.project.rootHash,
        runId: state.runId,
        environment,
        expiresAt: null,
        consumedAt: null,
        fingerprint: op.target ? fingerprintText(op.target) : null,
        target: op.target ? redactAndTruncate(op.target, 300) : null,
        ...(op.summary ? { summary: redactText(op.summary).slice(0, 200) } : {}),
      });
      return {};
    }

    case 'resolve-approval': {
      // This CLI is model-accessible (any Bash call can invoke it), so it
      // must never be able to turn its own pending request into an approved
      // human authorization. Denial (the model backing off its own request)
      // is harmless and remains allowed here. Nothing in the codebase grants
      // `approved` any more (docs/adr/0025-native-permission-approval.md):
      // for the Bash tool, authorization now happens live through Claude
      // Code's own native permission prompt, not through this record.
      const [id, status] = String(op.value ?? '').split('=');
      if (status === 'approved') return { error: 'model-approval-forbidden' };
      if (status !== 'denied') return { error: 'invalid-approval-status' };
      const result = applyApprovalResolution(state, id, status);
      if (result.error) return { error: result.error };
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
      // The active-run pointer is cleared in loadApplySave(), after a
      // confirmed successful save -- not here. Clearing it before the save
      // is even attempted would leave a run with no persisted terminal
      // state (if the save then failed) invisible to resolveActiveRun(),
      // silently disabling every KRYLO gate for the rest of the session
      // while state.json still says the run is active.
      return {};
    }

    default:
      return { error: 'unknown-op' };
  }
}

/**
 * Load, apply every op, and save, all under the run's exclusive file lock
 * (the same lock scripts/security/risk-gate.mjs holds while consuming a
 * risk approval). Without this, a concurrent CLI mutation and an in-flight
 * approval consumption could both load-modify-save the same state.json and
 * lose one side's update (e.g. a resolved approval reverting to "pending").
 * Returns a plain result object instead of exiting, so the lock is always
 * released (via withFileLock's finally) before the process reports and exits.
 */
function loadApplySave(runId, ops) {
  return withFileLock(runLockPath(runId), () => {
    const loaded = loadState(runId);
    if (!loaded.ok) return { ok: false, error: 'load-failed', details: loaded.error };
    const state = loaded.value;

    const applied = [];
    for (const op of ops) {
      const result = applyOp(state, op);
      if (result && result.error) {
        return { ok: false, error: result.error, op: op.op, details: result.details };
      }
      applied.push(op.op);
    }

    const saveResult = saveState(state);
    if (!saveResult.ok) return { ok: false, error: saveResult.error, details: saveResult.errors ?? saveResult.details };

    // Only now, after a confirmed successful save, clear the pointer for a
    // run that just reached a terminal state (see applyOp()'s 'terminal'
    // case for why this must not happen any earlier).
    if (state.terminalState !== null) clearActiveRunPointerForState(state);

    return { ok: true, applied };
  });
}

function main() {
  const { runId: explicitRunId, session, projectDir, ops } = parseArgv(process.argv.slice(2));

  // The data root must be bootstrapped before any state/pointer access, even
  // when a session id is not (yet) known: --run bypasses pointer lookup
  // entirely, but still needs the correct KRYLO_DATA_ROOT resolved from the
  // Claude-specific env vars (and KRYLO_SECURITY_PROFILE mapped from the
  // current userConfig option, read by the request-approval op above).
  bootstrapClaudeStorageEnvironment();

  let runId = explicitRunId;
  if (!runId) {
    const projectRootHash = computeProjectRootHash(path.resolve(projectDir || process.cwd()));
    const hostSessionId = resolveClaudeSessionId({ explicitSessionId: session }) || undefined;
    const pointer = readActiveRunPointer({ projectRootHash, host: 'claude', hostSessionId });
    if (!pointer.ok || !pointer.value || !pointer.value.runId) {
      fail('no-current-run');
      return;
    }
    runId = pointer.value.runId;
  }

  let result;
  try {
    result = loadApplySave(runId, ops);
  } catch (err) {
    // withFileLock throws (never rejects) when its retry budget is exhausted
    // under heavy concurrent contention for the same run's lock. Report it
    // the same way every other failure here is reported -- a clean JSON
    // error on stdout with exit 1 -- instead of an unhandled-exception stack
    // dump, so a caller (or a concurrency test) gets a diagnosable result.
    fail('lock-timeout', { details: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!result.ok) {
    fail(result.error, { op: result.op, details: result.details });
    return;
  }

  console.log(JSON.stringify({ ok: true, runId, applied: result.applied }));
  process.exit(0);
}

main();
