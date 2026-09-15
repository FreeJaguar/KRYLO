import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RADAR_CLASSIFICATIONS,
  HUMAN_JUDGEMENT_DIMENSIONS,
  scoreCandidate,
  detectRiskPenalties,
  classifyCandidate,
  computeOverlap,
  runEcosystemRadar,
  computeRadarExitCode,
} from '../../scripts/maintenance/checks/ecosystem-radar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

const NOW = new Date().toISOString();

function repoFixture(over = {}) {
  return {
    full_name: 'someone/thing',
    name: 'thing',
    owner: { login: 'someone', type: 'User' },
    description: 'a thing',
    pushed_at: NOW,
    archived: false,
    license: { spdx_id: 'MIT' },
    topics: ['claude-code-plugin'],
    default_branch: 'main',
    stargazers_count: 5,
    ...over,
  };
}

const DEEP_FULL = { inspected: true, hasInstallLifecycleScripts: false, dependencyCount: 0, hasCiWorkflows: true, hasTests: true };
const DEEP_NONE = { inspected: false, hasInstallLifecycleScripts: false, dependencyCount: null, hasCiWorkflows: false, hasTests: false };

function fakeClient({ search, file } = {}) {
  return {
    searchGithubRepositories: async (q) => (typeof search === 'function' ? search(q) : (search ?? { ok: false, reason: 'not-found' })),
    getGithubFileContent: async (o, r, p) => (typeof file === 'function' ? file(p) : (file ?? { ok: false, reason: 'not-found' })),
  };
}

test('ecosystem-radar: only design Section 16.5\'s three classifications exist', () => {
  assert.deepEqual(RADAR_CLASSIFICATIONS, ['REJECT', 'WATCH', 'AUDIT_RECOMMENDED']);
});

// The core honesty property: design Section 16.4's two largest dimensions are
// pure human judgement and cannot be computed. They must be declared, not
// quietly scored as zero, which would make every candidate look worse than
// the evidence supports while presenting a number that looks complete.
test('ecosystem-radar: the human-judgement dimensions are declared with their weights, never scored', () => {
  assert.deepEqual(Object.keys(HUMAN_JUDGEMENT_DIMENSIONS).sort(), [
    'cross-platform-support', 'engineering-value', 'krylo-architectural-fit', 'security-and-least-privilege',
  ]);
  const { maxAvailable } = scoreCandidate(repoFixture(), DEEP_FULL);
  const humanTotal = Object.values(HUMAN_JUDGEMENT_DIMENSIONS).reduce((a, b) => a + b, 0);
  assert.equal(maxAvailable, 40, 'only the measurable dimensions may contribute to the denominator');
  assert.equal(humanTotal, 60, 'the declared human-judgement half must account for the rest of the 100-point model');
});

// An unknown and a zero are different things. Excluding an unmeasured
// dimension from BOTH sides is what keeps the ratio meaningful.
test('ecosystem-radar: an unmeasured dimension is excluded from numerator AND denominator, never scored as zero', () => {
  const full = scoreCandidate(repoFixture(), DEEP_FULL);
  const shallow = scoreCandidate(repoFixture(), DEEP_NONE);
  assert.equal(full.maxAvailable, 40);
  assert.equal(shallow.maxAvailable, 25, 'testing and dependency-footprint drop out of the denominator when not inspected');
  assert.deepEqual(shallow.unknownDimensions.sort(), ['dependency-footprint', 'testing-and-ci-quality']);
});

test('ecosystem-radar: an undetectable risk penalty is reported as undetectable, never as absent', () => {
  const { applied, undetectable } = detectRiskPenalties(repoFixture(), DEEP_NONE);
  assert.ok(!applied.includes('install-lifecycle-scripts'));
  assert.ok(undetectable.includes('install-lifecycle-scripts'), 'a penalty that could not be checked must say so');
  for (const behavioural of ['broad-secret-access', 'unexplained-source-code-egress', 'remote-code-execution-or-unsafe-downloads']) {
    assert.ok(undetectable.includes(behavioural), `${behavioural} needs real behaviour, which the Radar never inspects`);
  }
});

test('ecosystem-radar: detectable penalties are applied from real signals', () => {
  assert.ok(detectRiskPenalties(repoFixture({ archived: true }), DEEP_FULL).applied.includes('abandoned-maintenance'));
  assert.ok(detectRiskPenalties(repoFixture({ license: null }), DEEP_FULL).applied.includes('unclear-licensing'));
  assert.ok(detectRiskPenalties(repoFixture(), { ...DEEP_FULL, hasInstallLifecycleScripts: true }).applied.includes('install-lifecycle-scripts'));
  assert.ok(detectRiskPenalties(repoFixture(), { ...DEEP_FULL, dependencyCount: 99 }).applied.includes('excessive-dependency-footprint'));
});

test('ecosystem-radar: hard disqualifiers REJECT, and nothing outweighs them', () => {
  const strong = { scored: 40, maxAvailable: 40, overlap: { alreadyInTrustCatalog: false }, deepInspected: true };
  assert.equal(classifyCandidate({ ...strong, penalties: { applied: ['abandoned-maintenance'], undetectable: [] } }).classification, 'REJECT');
  assert.equal(classifyCandidate({ ...strong, penalties: { applied: ['unclear-licensing'], undetectable: [] } }).classification, 'REJECT');
});

test('ecosystem-radar: a candidate already in the trust catalog is WATCH -- its drift is the Upstream Watch\'s job', () => {
  const res = classifyCandidate({
    scored: 40, maxAvailable: 40, deepInspected: true,
    penalties: { applied: [], undetectable: [] },
    overlap: { alreadyInTrustCatalog: true, catalogId: 'omniroute' },
  });
  assert.equal(res.classification, 'WATCH');
  assert.match(res.rationale, /already present/);
});

// Without this the scoring model rewards knowing LESS: a ratio computed over
// three dimensions is far easier to max out than one over five, so
// un-inspected candidates outranked fully-inspected better ones. Observed
// live before the guard existed.
test('ecosystem-radar: a high ratio earned without a deep inspection cannot reach AUDIT_RECOMMENDED', () => {
  const base = { penalties: { applied: [], undetectable: [] }, overlap: { alreadyInTrustCatalog: false } };
  const inspected = classifyCandidate({ ...base, scored: 28, maxAvailable: 40, deepInspected: true });
  const notInspected = classifyCandidate({ ...base, scored: 25, maxAvailable: 25, deepInspected: false });
  assert.equal(inspected.classification, 'AUDIT_RECOMMENDED');
  assert.equal(notInspected.classification, 'WATCH', 'a perfect score over fewer dimensions must not outrank a real one');
  assert.match(notInspected.rationale, /partial look/);
});

test('ecosystem-radar: overlap with the trust catalog is detected by source', () => {
  const tools = { tools: [{ id: 'omniroute', source: 'https://github.com/diegosouzapw/OmniRoute', trustTier: 'B' }] };
  const hit = computeOverlap({ full_name: 'diegosouzapw/OmniRoute' }, tools);
  assert.equal(hit.alreadyInTrustCatalog, true);
  assert.equal(hit.catalogId, 'omniroute');
  assert.equal(computeOverlap({ full_name: 'someone/else' }, tools).alreadyInTrustCatalog, false);
});

// A source that could not be read must never collapse into "no candidates
// found", which renders identically to a clean radar.
test('ecosystem-radar: a failed search is reported SOURCE_UNAVAILABLE, not as an empty result', async () => {
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, client: fakeClient({ search: { ok: false, reason: 'rate-limited' } }) });
  assert.ok(report.sources.length > 0);
  for (const s of report.sources) {
    assert.equal(s.status, 'SOURCE_UNAVAILABLE');
    assert.match(s.detail, /rate-limited/);
  }
  assert.equal(report.summary.sourcesUnavailable, report.sources.length);
  assert.equal(report.candidates.length, 0);
});

// The offline path previously returned no summary at all, so the renderer
// printed "0 sources unavailable" directly beneath a list of unavailable
// sources -- a report that contradicted itself and read as clean.
test('ecosystem-radar: the offline report counts its own unavailable sources', async () => {
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, offline: true });
  assert.equal(report.mode, 'offline');
  assert.ok(report.sources.length > 0);
  assert.equal(report.summary.sourcesUnavailable, report.sources.length);
  assert.equal(computeRadarExitCode(report), 0, 'finding nothing is not a failure');
});

test('ecosystem-radar: an unreadable catalog is an internal failure (exit 2), not a silent empty radar', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-radar-empty-'));
  try {
    const report = await runEcosystemRadar({ repoRoot: empty });
    assert.equal(report.error, 'catalog-unreadable');
    assert.equal(computeRadarExitCode(report), 2);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('ecosystem-radar: candidate text from upstream is bounded and control characters neutralized', async () => {
  const hostile = `${'x'.repeat(900)}\n   AUDIT   https://github.com/evil/forged`;
  const report = await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: fakeClient({
      search: { ok: true, json: { items: [repoFixture({ description: hostile, full_name: 'a/b' })] } },
      file: { ok: false, reason: 'not-found' },
    }),
  });
  const c = report.candidates[0];
  assert.ok(c.description.length <= 200, 'description must be length-bounded');
  assert.doesNotMatch(c.description, /[\u0000-\u001F\u007F]/, 'no control character may reach the report');
});

test('ecosystem-radar: a real run never writes to the trust catalog or the source policy', async () => {
  const toolsPath = path.join(PLUGIN_ROOT, 'catalog', 'tools.json');
  const sourcesPath = path.join(PLUGIN_ROOT, 'catalog', 'radar-sources.json');
  const beforeTools = fs.readFileSync(toolsPath, 'utf8');
  const beforeSources = fs.readFileSync(sourcesPath, 'utf8');

  await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: fakeClient({ search: { ok: true, json: { items: [repoFixture()] } }, file: { ok: false, reason: 'not-found' } }),
  });

  assert.equal(fs.readFileSync(toolsPath, 'utf8'), beforeTools, 'discovery must never mutate the trust catalog');
  assert.equal(fs.readFileSync(sourcesPath, 'utf8'), beforeSources, 'the Radar must never rewrite its own source policy');
});

// Design Section 16.5 forbids installing or executing a candidate. Asserted
// structurally: a module that cannot spawn a process cannot run one.
test('ecosystem-radar: the module has no process-execution capability at all', () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'maintenance', 'checks', 'ecosystem-radar.mjs'), 'utf8');
  for (const forbidden of ['child_process', 'execSync', 'execFileSync', 'spawnSync', 'spawn(']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the Radar must never reference ${forbidden}`);
  }
  for (const write of ['writeFileSync', 'appendFileSync', 'rmSync', 'mkdirSync']) {
    assert.doesNotMatch(source, new RegExp(write), `the Radar must never reference ${write}`);
  }
});

test('ecosystem-radar: every shipped query declares a rationale, so the source policy stays reviewable', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'catalog', 'radar-sources.json'), 'utf8'));
  assert.ok(policy.queries.length > 0);
  for (const q of policy.queries) {
    for (const field of ['id', 'category', 'query', 'rationale']) {
      assert.ok(typeof q[field] === 'string' && q[field].trim() !== '', `query ${q.id} must declare ${field}`);
    }
  }
  assert.ok(Number.isInteger(policy.limits.maxResultsPerQuery), 'the policy must bound results per query');
  assert.ok(Number.isInteger(policy.limits.maxDeepInspections), 'the policy must bound deep inspections');
});
