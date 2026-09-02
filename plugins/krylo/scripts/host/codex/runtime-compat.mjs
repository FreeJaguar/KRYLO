// Codex Runtime Compatibility Gate (docs/adr/0034-codex-runtime-compatibility-gate.md).
// Local, deterministic admission control for a full autonomous $krylo-run on
// Codex: a reviewed compatibility contract (plugins/krylo/policies/
// codex-runtime-compatibility.json) plus a single bounded local probe
// (`codex --version`, resolved through the same shim-aware
// scripts/lib/spawn-platform.mjs machinery already proven for
// scripts/host/cross-harness/codex-worker.mjs's detectCodexWorkerCapability()).
// No network access, no model invocation, no repository source ever leaves
// this process. Every failure path -- missing contract, malformed contract,
// unrecognized contract schema, missing/unresolvable executable, non-zero
// exit, timeout, malformed version output -- resolves to `trusted: false`;
// there is no code path in this module capable of converting any of those
// into `trusted: true`, by construction.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { platformSpawnTarget } from '../../lib/spawn-platform.mjs';
import { parseCodexVersion } from '../../lib/version-compare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTRACT_PATH = path.resolve(HERE, '..', '..', '..', 'policies', 'codex-runtime-compatibility.json');

// Only this exact schema version is understood this checkpoint. A future
// schema change ships as a deliberate, reviewed bump plus updated parsing
// code -- never silently accepted as "close enough."
const SUPPORTED_CONTRACT_SCHEMA_VERSION = 1;

// `$krylo-run` invocations are rare (roughly once per session); this probe
// runs once per invocation, never per ordinary prompt (see the bootstrap
// hook's own call site) -- a 5s bound is generous without risking a long
// stall on a genuinely hung/unresponsive binary.
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;

/**
 * Read and schema-validate the compatibility contract. Never throws; every
 * failure returns { ok: false, reason } -- a malformed or unrecognized
 * contract is evidence for "not trusted," never "no restrictions apply."
 */
export function loadCompatibilityContract({ contractPath = DEFAULT_CONTRACT_PATH } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(contractPath, 'utf8');
  } catch {
    return { ok: false, reason: 'contract-unreadable' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'contract-invalid-json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'contract-invalid-shape' };
  }
  if (parsed.contractSchemaVersion !== SUPPORTED_CONTRACT_SCHEMA_VERSION) {
    return { ok: false, reason: 'contract-unknown-schema-version' };
  }
  if (!Array.isArray(parsed.supported) || !Array.isArray(parsed.blocked)) {
    return { ok: false, reason: 'contract-invalid-shape' };
  }
  for (const entry of [...parsed.supported, ...parsed.blocked]) {
    if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string' || entry.version.trim() === '') {
      return { ok: false, reason: 'contract-invalid-entry' };
    }
  }

  return { ok: true, contract: parsed };
}

/**
 * The sole local runtime probe: `codex --version`, resolved via the same
 * portable, shim-aware executable resolution already proven for
 * detectCodexWorkerCapability() (scripts/host/cross-harness/codex-worker.mjs).
 * `cliPath`/`env` are injectable so this stays fully testable without a real
 * Codex installation -- production callers resolve `cliPath` from
 * env.KRYLO_CODEX_CLI_PATH (default 'codex'), never from prompt content.
 * Never throws; every failure returns { ok: false, reason }.
 */
export function probeCodexVersion({ cliPath = 'codex', env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const target = platformSpawnTarget(cliPath, ['--version']);
    if (!target) return { ok: false, reason: 'probe-executable-unresolved' };

    const res = spawnSync(target.command, target.args, {
      encoding: 'utf8',
      shell: false,
      timeout: timeoutMs,
      maxBuffer: PROBE_MAX_BUFFER_BYTES,
      env,
    });

    if (res.error) {
      const isTimeout = res.error.code === 'ETIMEDOUT' || Boolean(res.signal);
      return { ok: false, reason: isTimeout ? 'probe-timeout' : 'probe-process-error' };
    }
    if (res.signal) return { ok: false, reason: 'probe-timeout' };
    if (res.status !== 0 || typeof res.stdout !== 'string') return { ok: false, reason: 'probe-nonzero-exit' };

    const firstLine = res.stdout.trim().split('\n')[0] ?? '';
    const parsedVersion = parseCodexVersion(firstLine);
    if (!parsedVersion.ok) return { ok: false, reason: 'probe-malformed-version', observed: firstLine.slice(0, 80) };

    return {
      ok: true,
      version: `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`,
      executablePath: target.command,
      raw: firstLine,
    };
  } catch {
    return { ok: false, reason: 'probe-process-error' };
  }
}

function findExactVersion(entries, version) {
  return entries.find((e) => e.version === version);
}

/**
 * The full decision: contract first (a malformed/unreadable/unrecognized-
 * schema contract fails safe immediately, before any probe even runs), then
 * the version probe, then an EXACT-match lookup -- no version ranges, no
 * "compatible-looking" trust, matching this checkpoint's own explicit
 * instruction. Returns { trusted, status, reason, version?, executablePath? }.
 * `status` is one of: 'supported' (the only trusted:true case), 'blocked',
 * 'unverified', 'probe-failed', 'contract-malformed'.
 */
export function evaluateCodexRuntimeCompatibility({ cliPath = 'codex', env = process.env, contractPath, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const contractResult = loadCompatibilityContract({ contractPath });
  if (!contractResult.ok) {
    return {
      trusted: false,
      status: 'contract-malformed',
      reason: `KRYLO's own Codex compatibility contract could not be read or is malformed (${contractResult.reason}). `
        + 'Codex runtime compatibility cannot be determined; treated as not trusted, never as unrestricted.',
    };
  }

  const probe = probeCodexVersion({ cliPath, env, timeoutMs });
  if (!probe.ok) {
    return {
      trusted: false,
      status: 'probe-failed',
      reason: `KRYLO could not determine the installed Codex runtime version (${probe.reason}`
        + `${probe.observed ? `: "${probe.observed}"` : ''}). A full autonomous KRYLO run requires a reviewed, verified Codex runtime.`,
    };
  }

  const { contract } = contractResult;
  const blockedEntry = findExactVersion(contract.blocked, probe.version);
  if (blockedEntry) {
    return {
      trusted: false,
      status: 'blocked',
      version: probe.version,
      executablePath: probe.executablePath,
      reason: `Installed Codex runtime ${probe.version} is explicitly blocked: ${blockedEntry.reason || 'known incompatible with KRYLO.'}`,
    };
  }

  const supportedEntry = findExactVersion(contract.supported, probe.version);
  if (supportedEntry) {
    return {
      trusted: true,
      status: 'supported',
      version: probe.version,
      executablePath: probe.executablePath,
      reason: `Installed Codex runtime ${probe.version} is a reviewed, supported version.`,
    };
  }

  return {
    trusted: false,
    status: 'unverified',
    version: probe.version,
    executablePath: probe.executablePath,
    reason: `Installed Codex runtime ${probe.version} has not been reviewed against KRYLO's compatibility contract `
      + '(plugins/krylo/policies/codex-runtime-compatibility.json). A full autonomous KRYLO run requires a reviewed, verified Codex runtime.',
  };
}
