#!/usr/bin/env node
// KRYLO Cross-Harness runtime CLI (docs/adr/0030-cross-harness-advisory-workers.md):
// the ONLY executable surface a Skill invokes to request an opposite-provider
// advisory worker. Bash/PowerShell invocation of this script is itself the
// require-approval-classified action (production-policy.json's
// "cross-harness-invocation" class) -- by the time this script's main()
// actually runs, the native host has already gated the attempt (Claude:
// permissionDecision "ask"; Codex: deterministic deny before this ever
// executes). This script therefore does not re-check approval state itself;
// it does the work.
//
// The very first thing checked, before any argument parsing, is the
// recursion-prevention environment marker -- so a worker that somehow
// discovers and re-invokes this script directly is refused unconditionally,
// independent of any other logic below.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  isCrossHarnessDepthExceeded,
  buildCrossHarnessRequest,
  buildWorkerSystemPrompt,
  buildWorkerStdinPayload,
  buildContextPacket,
  validateCrossHarnessResult,
  CROSS_HARNESS_RESULT_JSON_SCHEMA,
} from '../lib/cross-harness.mjs';
import { crossHarnessInvocationDir, ensureDir } from '../lib/paths.mjs';
import { deepRedact } from '../lib/redact.mjs';
import { readActiveRunPointer, computeProjectRootHash } from '../lib/state.mjs';
import { bootstrapStorageEnvironment, resolveSessionId, detectHost } from '../lib/host-dispatch.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { detectClaudeWorkerCapability, spawnClaudeWorker, parseClaudeWorkerOutput } from '../host/cross-harness/claude-worker.mjs';
import { detectCodexWorkerCapability, spawnCodexWorker, parseCodexWorkerOutput } from '../host/cross-harness/codex-worker.mjs';

function parseArgs(argv) {
  const args = { role: null, task: '', contextFile: null, session: null, projectDir: null, timeoutMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--role': args.role = argv[++i]; break;
      case '--task': args.task = argv[++i]; break;
      case '--context-file': args.contextFile = argv[++i]; break;
      case '--session': args.session = argv[++i]; break;
      case '--project-dir': args.projectDir = argv[++i]; break;
      case '--timeout-ms': args.timeoutMs = Number(argv[++i]); break;
      default: break;
    }
  }
  return args;
}

function output(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const UPDATE_STATE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-state.mjs');

// A fresh independent Reviewer found the original version of this function
// recorded a worker's own reported severity verbatim -- since findingStatus
// blocks VERIFIED_COMPLETE on any OPEN critical/high finding, an untrusted,
// possibly hallucinating or prompt-injected worker could report 32 "critical"
// findings and unilaterally hold the native run's completion hostage, with
// no code path forcing independent confirmation first. This directly
// violates the task's own explicit requirement (Section 16): "Critical/High
// findings from a cross-provider worker must be independently checked by the
// native host before they are treated as confirmed." Recorded severity is
// therefore capped at 'medium' (never blocking on its own) regardless of
// what the worker reported; the native host that reads the finding and
// agrees it is genuinely critical/high must re-file it itself via its own
// --add-finding call, which is what "independently checked... before being
// treated as confirmed" means in practice. The worker's OWN reported
// severity is preserved in the summary text so nothing is lost, only
// demoted from auto-blocking to advisory.
const NON_BLOCKING_SEVERITY_CAP = 'medium';

function cappedSeverity(reportedSeverity) {
  return ['critical', 'high'].includes(reportedSeverity) ? NON_BLOCKING_SEVERITY_CAP : reportedSeverity;
}

/**
 * Record a Cross-Harness result into the run's own canonical state via the
 * SAME runtime CLI the Skill itself uses (--add-evidence/--add-finding/
 * --mark-external-worker) -- reuses the one validated, locked mutation path
 * rather than a second, parallel state-writing implementation. A recording
 * failure never changes the CrossHarnessResult already returned to the
 * caller (task Section 16 -- a worker's findings are advisory evidence for
 * the native host to act on, never an authority that can itself decide
 * anything) -- but, unlike an earlier version a fresh independent Reviewer
 * found silently discarded every failure despite its own comment claiming
 * otherwise, a failure here IS now recorded to telemetry and reflected in
 * the returned `recorded` flag, so the caller/model can tell state
 * bookkeeping did not land rather than wrongly assuming it did.
 */
function recordResultAsEvidence({ runId, session, projectDir, request, result }) {
  const baseArgs = ['--run', runId, ...(session ? ['--session', session] : []), ...(projectDir ? ['--project-dir', projectDir] : [])];
  const run = (extra) => spawnSync(process.execPath, [UPDATE_STATE_CLI, ...baseArgs, ...extra], { encoding: 'utf8', timeout: 15_000 });
  const ok = (res) => res.status === 0 && !res.error;

  let recorded = true;

  const markResult = run(['--mark-external-worker']);
  if (!ok(markResult)) recorded = false;

  const evidence = {
    type: 'review',
    label: `cross-harness ${request.role} (${request.workerProvider})`,
    sourceTool: `cross-harness:${request.workerProvider}:${request.role}`,
    result: result.status === 'completed' ? 'info' : 'blocked',
    summary: result.summary.slice(0, 300),
  };
  const evidenceResult = run(['--add-evidence', JSON.stringify(evidence)]);
  if (!ok(evidenceResult)) recorded = false;

  for (const finding of result.findings) {
    const findingResult = run(['--add-finding', JSON.stringify({
      severity: cappedSeverity(finding.severity),
      summary: `[cross-harness:${request.workerProvider}:${request.role}, worker-reported severity: ${finding.severity}, unconfirmed] ${finding.title}`.slice(0, 300),
      source: `cross-harness:${request.workerProvider}:${request.role}`,
    })]);
    if (!ok(findingResult)) recorded = false;
  }

  if (!recorded) {
    recordEvent(runId, { event: 'cross-harness', provider: request.workerProvider, role: request.role, status: 'failed', category: 'evidence-record-failed' });
  }
  return recorded;
}

async function main() {
  // Recursion prevention: checked before anything else, unconditionally.
  if (isCrossHarnessDepthExceeded(process.env)) {
    output({ ok: false, failureCode: 'DEPTH_LIMIT', error: 'Cross-Harness cannot be invoked from inside a Cross-Harness worker.' });
    process.exit(0);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  bootstrapStorageEnvironment();

  const projectRoot = path.resolve(args.projectDir || process.cwd());
  const projectRootHash = computeProjectRootHash(projectRoot);
  const nativeHost = detectHost();
  const hostSessionId = resolveSessionId({ explicitSessionId: args.session }) || undefined;
  const pointer = readActiveRunPointer({ projectRootHash, host: nativeHost, hostSessionId });
  if (!pointer.ok || !pointer.value?.runId) {
    output({ ok: false, failureCode: 'INVALID_ROLE', error: 'no-current-run' });
    process.exit(1);
    return;
  }
  const runId = pointer.value.runId;

  const built = buildCrossHarnessRequest({
    nativeHost,
    nativeSessionId: hostSessionId || runId,
    runId,
    projectRootHash,
    role: args.role,
    task: args.task,
  });
  if (!built.ok) {
    output({ ok: false, failureCode: built.failureCode, error: built.error });
    process.exit(0);
    return;
  }
  const request = built.request;

  // Overridable ONLY when KRYLO_CROSS_HARNESS_TEST_MODE=1 is ALSO set --
  // both fresh independent Reviewers found the earlier, unconditional
  // version of this override genuinely reachable in a production
  // invocation (nothing gated it), meaning an attacker who could smuggle
  // an env-var assignment ahead of the already-approved
  // cross-harness-run.mjs command (e.g. `KRYLO_CROSS_HARNESS_CODEX_CLI=./evil.sh
  // node .../cross-harness-run.mjs ...`) could substitute an arbitrary,
  // completely unsandboxed binary for the worker the human believed they
  // were approving. Requiring a SECOND, distinctly-named sentinel alongside
  // the override raises the bar (an attacker now needs the human-visible
  // approved command to carry two suspicious env assignments, not one) --
  // disclosed honestly as defense-in-depth, not a strong guarantee: no
  // env-var gate is a true security boundary against a compromised local
  // command line. The real security boundary remains the native-ask/deny
  // gate on invoking this script at all. tests/hooks/cross-harness-run.test.mjs
  // sets both variables explicitly for every fixture-driven test.
  const testModeEnabled = process.env.KRYLO_CROSS_HARNESS_TEST_MODE === '1';
  const codexCliPath = (testModeEnabled && process.env.KRYLO_CROSS_HARNESS_CODEX_CLI) || 'codex';
  const claudeCliPath = (testModeEnabled && process.env.KRYLO_CROSS_HARNESS_CLAUDE_CLI) || 'claude';

  const capability = request.workerProvider === 'codex'
    ? detectCodexWorkerCapability({ cliPath: codexCliPath })
    : detectClaudeWorkerCapability({ cliPath: claudeCliPath });
  if (!capability.available) {
    recordEvent(runId, { event: 'cross-harness', provider: request.workerProvider, role: request.role, status: 'unavailable', category: capability.reason });
    output({ ok: false, failureCode: capability.reason, error: `${request.workerProvider} worker CLI is unavailable.` });
    process.exit(0);
    return;
  }

  let contextInput = {};
  if (args.contextFile) {
    try {
      contextInput = JSON.parse(fs.readFileSync(path.resolve(args.contextFile), 'utf8'));
    } catch {
      output({ ok: false, failureCode: 'EGRESS_CONTENT_BLOCKED', error: 'context-file could not be read or parsed as JSON.' });
      process.exit(0);
      return;
    }
  }
  const packetResult = buildContextPacket({ task: request.task, ...contextInput });
  if (!packetResult.ok) {
    output({ ok: false, failureCode: packetResult.failureCode, error: packetResult.error });
    process.exit(0);
    return;
  }

  const invocationId = `chi-${crypto.randomBytes(6).toString('hex')}`;
  const invocationDir = crossHarnessInvocationDir(runId, invocationId);
  ensureDir(invocationDir);
  const outputSchemaPath = path.join(invocationDir, 'result-schema.json');
  fs.writeFileSync(outputSchemaPath, JSON.stringify(CROSS_HARNESS_RESULT_JSON_SCHEMA), 'utf8');

  const systemPrompt = buildWorkerSystemPrompt(request.role);
  const stdinPayload = buildWorkerStdinPayload({ role: request.role, packet: packetResult.packet });

  // NOTE: process.exit() terminates synchronously and does NOT run a
  // pending try/finally -- every exit point below explicitly calls
  // cleanupDir(invocationDir) itself via finish() rather than relying on a
  // finally block, which would silently never run.
  function finish(payload) {
    cleanupDir(invocationDir);
    output(payload);
    process.exit(0);
  }

  const spawnResult = request.workerProvider === 'codex'
    ? spawnCodexWorker({ cliPath: codexCliPath, cwd: invocationDir, outputSchemaPath, stdinPayload: `${systemPrompt}\n\n${stdinPayload}`, runId, timeoutMs: args.timeoutMs || undefined })
    : spawnClaudeWorker({ cliPath: claudeCliPath, cwd: invocationDir, systemPrompt, jsonSchema: CROSS_HARNESS_RESULT_JSON_SCHEMA, stdinPayload, runId, timeoutMs: args.timeoutMs || undefined });

  if (!spawnResult.ok) {
    recordEvent(runId, { event: 'cross-harness', provider: request.workerProvider, role: request.role, status: 'failed', category: spawnResult.failureCode });
    finish({ ok: false, failureCode: spawnResult.failureCode, error: `Worker invocation failed: ${spawnResult.failureCode}` });
    return;
  }

  const raw = request.workerProvider === 'codex'
    ? parseCodexWorkerOutput(spawnResult.stdout)
    : parseClaudeWorkerOutput(spawnResult.stdout);
  if (raw === null) {
    recordEvent(runId, { event: 'cross-harness', provider: request.workerProvider, role: request.role, status: 'failed', category: 'INVALID_OUTPUT' });
    finish({ ok: false, failureCode: 'INVALID_OUTPUT', error: 'Worker output could not be parsed.' });
    return;
  }

  const validated = validateCrossHarnessResult(raw);
  if (!validated.ok) {
    recordEvent(runId, { event: 'cross-harness', provider: request.workerProvider, role: request.role, status: 'failed', category: validated.failureCode });
    finish({ ok: false, failureCode: validated.failureCode, error: validated.error });
    return;
  }

  recordEvent(runId, {
    event: 'cross-harness',
    provider: request.workerProvider,
    role: request.role,
    status: 'completed',
    category: validated.result.status,
    inputBytes: packetResult.approxBytes,
    outputBytes: Buffer.byteLength(spawnResult.stdout, 'utf8'),
    findingCount: validated.result.findings.length,
  });

  const recorded = recordResultAsEvidence({ runId, session: args.session, projectDir: args.projectDir, request, result: validated.result });

  // A fresh independent Security Reviewer correctly noted the worker's own
  // result (returned here to the orchestrating model's own context, not
  // just to canonical state) had never been redacted -- unlike the copy
  // recordResultAsEvidence() persists to state.json, which update-state.mjs
  // already deepRedacts. A prompt-injected worker could otherwise address
  // the parent model directly through an unredacted summary/recommendation/
  // description field. deepRedact() here matches the exact same masking
  // already applied everywhere else untrusted content reaches persisted or
  // displayed KRYLO output.
  finish({ ok: true, runId, invocationId, recorded, result: deepRedact(validated.result) });
}

main().catch((err) => {
  output({ ok: false, failureCode: 'SPAWN_FAILED', error: String(err?.message || err) });
  process.exit(0);
});
