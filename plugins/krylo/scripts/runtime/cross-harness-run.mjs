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
  buildContextPacket,
  validateCrossHarnessResult,
} from '../lib/cross-harness.mjs';
import { crossHarnessInvocationDir, ensureDir } from '../lib/paths.mjs';
import { readActiveRunPointer, computeProjectRootHash } from '../lib/state.mjs';
import { bootstrapStorageEnvironment, resolveSessionId, detectHost } from '../lib/host-dispatch.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { detectClaudeWorkerCapability, spawnClaudeWorker, parseClaudeWorkerOutput } from '../host/cross-harness/claude-worker.mjs';
import { detectCodexWorkerCapability, spawnCodexWorker, parseCodexWorkerOutput } from '../host/cross-harness/codex-worker.mjs';

const RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'status', 'provider', 'role', 'summary', 'filesModified', 'findings', 'limitations'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    status: { enum: ['completed', 'incomplete'] },
    provider: { enum: ['claude', 'codex'] },
    role: { enum: ['verifier', 'reviewer', 'security-reviewer', 'architect'] },
    summary: { type: 'string', maxLength: 2000 },
    filesModified: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string', maxLength: 200 },
          confidence: { enum: ['high', 'medium', 'low'] },
          recommendation: { type: 'string', maxLength: 1000 },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                line: { type: 'integer', minimum: 1 },
                description: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
    },
    limitations: { type: 'array', items: { type: 'string', maxLength: 500 } },
  },
};

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

/**
 * Record a Cross-Harness result into the run's own canonical state via the
 * SAME runtime CLI the Skill itself uses (--add-evidence/--add-finding/
 * --mark-external-worker) -- reuses the one validated, locked mutation path
 * rather than a second, parallel state-writing implementation. Best-effort:
 * a failure here never changes the CrossHarnessResult already returned to
 * the caller (task Section 16 -- a worker's findings are advisory evidence
 * for the native host to act on, not an authority that can itself decide
 * anything, so a bookkeeping failure here is logged, never fatal).
 */
function recordResultAsEvidence({ runId, session, projectDir, request, result }) {
  const baseArgs = ['--run', runId, ...(session ? ['--session', session] : []), ...(projectDir ? ['--project-dir', projectDir] : [])];
  const run = (extra) => spawnSync(process.execPath, [UPDATE_STATE_CLI, ...baseArgs, ...extra], { encoding: 'utf8', timeout: 15_000 });

  run(['--mark-external-worker']);

  const evidence = {
    type: 'review',
    label: `cross-harness ${request.role} (${request.workerProvider})`,
    sourceTool: `cross-harness:${request.workerProvider}:${request.role}`,
    result: result.status === 'completed' ? 'info' : 'blocked',
    summary: result.summary.slice(0, 300),
  };
  run(['--add-evidence', JSON.stringify(evidence)]);

  for (const finding of result.findings) {
    run(['--add-finding', JSON.stringify({
      severity: finding.severity,
      summary: `[cross-harness:${request.workerProvider}:${request.role}] ${finding.title}`.slice(0, 300),
      source: `cross-harness:${request.workerProvider}:${request.role}`,
    })]);
  }
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

  // Overridable only for deterministic fake-worker tests
  // (tests/fixtures/cross-harness/) -- a real KRYLO run never sets these,
  // so production behavior always resolves the real "codex"/"claude" on
  // PATH.
  const codexCliPath = process.env.KRYLO_CROSS_HARNESS_CODEX_CLI || 'codex';
  const claudeCliPath = process.env.KRYLO_CROSS_HARNESS_CLAUDE_CLI || 'claude';

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
  fs.writeFileSync(outputSchemaPath, JSON.stringify(RESULT_JSON_SCHEMA), 'utf8');

  const systemPrompt = buildWorkerSystemPrompt(request.role);
  const stdinPayload = JSON.stringify({ role: request.role, packet: packetResult.packet });

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
    : spawnClaudeWorker({ cliPath: claudeCliPath, cwd: invocationDir, systemPrompt, stdinPayload, runId, timeoutMs: args.timeoutMs || undefined });

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

  recordResultAsEvidence({ runId, session: args.session, projectDir: args.projectDir, request, result: validated.result });

  finish({ ok: true, runId, invocationId, result: validated.result });
}

main().catch((err) => {
  output({ ok: false, failureCode: 'SPAWN_FAILED', error: String(err?.message || err) });
  process.exit(0);
});
