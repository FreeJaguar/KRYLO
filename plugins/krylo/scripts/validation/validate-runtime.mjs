#!/usr/bin/env node
// Runtime self-check.
// --syntax-only: `node --check` every .mjs under scripts/.
// Full mode additionally verifies the data dir is writable via a real
// write+read+validate scratch run, and cross-checks validateState's enums
// and required-field lists against the actual JSON schema files so the two
// can never silently drift apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { getDataRoot, ensureDir } from '../lib/paths.mjs';
import { createInitialState, validateState, saveState, loadState, ENUMS, REQUIRED_TOP_LEVEL } from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.resolve(__dirname, '..');
const SCHEMAS_ROOT = path.resolve(__dirname, '..', '..', 'schemas');

function parseArgs(argv) {
  return { syntaxOnly: argv.includes('--syntax-only') };
}

function listMjsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMjsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      results.push(full);
    }
  }
  return results;
}

function checkSyntax(files) {
  return files.map((file) => {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return {
      file: path.relative(SCRIPTS_ROOT, file).split(path.sep).join('/'),
      pass: res.status === 0,
      error: res.status === 0 ? undefined : (res.stderr || '').trim(),
    };
  });
}

function sortedEqual(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return JSON.stringify(sa) === JSON.stringify(sb);
}

function crossCheckSchema() {
  const errors = [];
  const runStateSchema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'run-state.schema.json'), 'utf8'));
  const evidenceSchema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'evidence.schema.json'), 'utf8'));

  const schemaRequired = runStateSchema.required || [];
  const missingInValidator = schemaRequired.filter((f) => !REQUIRED_TOP_LEVEL.includes(f));
  const extraInValidator = REQUIRED_TOP_LEVEL.filter((f) => !schemaRequired.includes(f));
  if (missingInValidator.length) errors.push(`validator is missing required top-level fields: ${missingInValidator.join(', ')}`);
  if (extraInValidator.length) errors.push(`validator has extra required top-level fields not in schema: ${extraInValidator.join(', ')}`);

  const enumChecks = [
    ['goal.lane', runStateSchema.properties.goal.properties.lane.enum, ENUMS.lane],
    ['goal.risk', runStateSchema.properties.goal.properties.risk.enum, ENUMS.risk],
    ['goal.complexity', runStateSchema.properties.goal.properties.complexity.enum, ENUMS.complexity],
    ['acceptanceCriteria.status', runStateSchema.properties.acceptanceCriteria.items.properties.status.enum, ENUMS.criterionStatus],
    ['agents.status', runStateSchema.properties.agents.items.properties.status.enum, ENUMS.agentStatus],
    ['orbit.fingerprints.category', runStateSchema.properties.orbit.properties.fingerprints.items.properties.category.enum, ENUMS.fingerprintCategory],
    ['questionGate.grants.category', runStateSchema.properties.questionGate.properties.grants.items.properties.category.enum, ENUMS.questionCategory],
    ['questionGate.grants.status', runStateSchema.properties.questionGate.properties.grants.items.properties.status.enum, ENUMS.grantStatus],
    ['riskApprovals.actionClass', runStateSchema.properties.riskApprovals.items.properties.actionClass.enum, ENUMS.actionClass],
    ['riskApprovals.status', runStateSchema.properties.riskApprovals.items.properties.status.enum, ENUMS.approvalStatus],
    ['findings.severity', runStateSchema.properties.findings.items.properties.severity.enum, ENUMS.findingSeverity],
    ['findings.status', runStateSchema.properties.findings.items.properties.status.enum, ENUMS.findingStatus],
    ['phase', runStateSchema.properties.phase.enum, ENUMS.phase],
    ['terminalState', runStateSchema.properties.terminalState.enum.filter((v) => v !== null), ENUMS.terminalState],
    ['evidence.type', evidenceSchema.properties.type.enum, ENUMS.evidenceType],
    ['evidence.result', evidenceSchema.properties.result.enum, ENUMS.evidenceResult],
  ];

  for (const [name, schemaEnum, validatorEnum] of enumChecks) {
    if (!sortedEqual(schemaEnum, validatorEnum)) {
      errors.push(`enum mismatch for ${name}: schema=${JSON.stringify([...schemaEnum].sort())} validator=${JSON.stringify([...validatorEnum].sort())}`);
    }
  }

  return errors;
}

// Governance guard for the multi-host foundation (ADR-0023): Shared Core
// library modules must stay host-neutral. Only the Claude host adapter
// (scripts/host/claude/**) may read CLAUDE_-prefixed environment or Hook
// fields directly; everything else consumes normalized KRYLO_* values.
const ISOLATED_SHARED_FILES = [
  path.join(SCRIPTS_ROOT, 'lib'),
];

function checkHostIsolation() {
  const errors = [];
  for (const root of ISOLATED_SHARED_FILES) {
    for (const file of listMjsFiles(root)) {
      const contents = fs.readFileSync(file, 'utf8');
      if (/CLAUDE_/.test(contents)) {
        errors.push(`${path.relative(SCRIPTS_ROOT, file).split(path.sep).join('/')} must not reference CLAUDE_-prefixed identifiers; Shared Core is host-neutral`);
      }
    }
  }
  return errors;
}

function runtimeSmokeTest() {
  const errors = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-validate-'));
  const prevDataRoot = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempRoot;
  try {
    ensureDir(getDataRoot());

    const state = createInitialState({
      goalText: 'validation smoke test goal',
      sessionId: 'validate-session',
      projectDir: tempRoot,
      lane: 'BUILD',
      risk: 'low',
      complexity: 'trivial',
      budget: 3,
      kryloVersion: '0.0.0-validate',
    });

    const { valid, errors: stateErrors } = validateState(state);
    if (!valid) errors.push(...stateErrors.map((e) => `scratch state invalid: ${e}`));

    const saveResult = saveState(state);
    if (!saveResult.ok) errors.push(`scratch state save failed: ${JSON.stringify(saveResult.errors)}`);

    const loaded = loadState(state.runId);
    if (!loaded.ok) errors.push(`scratch state reload failed: ${loaded.error}`);
  } catch (err) {
    errors.push(`runtime smoke test threw: ${err && err.message}`);
  } finally {
    if (prevDataRoot === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevDataRoot;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = listMjsFiles(SCRIPTS_ROOT);
  const syntaxResults = checkSyntax(files);
  const syntaxPass = syntaxResults.every((r) => r.pass);

  if (args.syntaxOnly) {
    console.log(JSON.stringify({ ok: syntaxPass, mode: 'syntax-only', results: syntaxResults }));
    process.exit(syntaxPass ? 0 : 1);
    return;
  }

  const schemaErrors = crossCheckSchema();
  const isolationErrors = checkHostIsolation();
  const smokeErrors = runtimeSmokeTest();
  const ok = syntaxPass && schemaErrors.length === 0 && isolationErrors.length === 0 && smokeErrors.length === 0;

  console.log(JSON.stringify({
    ok,
    mode: 'full',
    syntax: { pass: syntaxPass, results: syntaxResults },
    schemaConsistency: { pass: schemaErrors.length === 0, errors: schemaErrors },
    hostIsolation: { pass: isolationErrors.length === 0, errors: isolationErrors },
    runtimeSmoke: { pass: smokeErrors.length === 0, errors: smokeErrors },
  }));
  process.exit(ok ? 0 : 1);
}

main();
