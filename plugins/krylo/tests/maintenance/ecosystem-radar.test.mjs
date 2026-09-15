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
  isFullyInspected,
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

// Both probes answered.
const DEEP_FULL = { ciInspected: true, packageInspected: true, hasCiWorkflows: true, hasInstallLifecycleScripts: false, dependencyCount: 0, hasTests: true, probeFailures: [] };
// No deep-inspection slot at all: neither probe ran.
const DEEP_NONE = { ciInspected: false, packageInspected: false, hasCiWorkflows: false, hasInstallLifecycleScripts: false, dependencyCount: null, hasTests: false, probeFailures: [] };
// The shape the whole split exists for: CI was read, package.json was not.
// Every Python or Go candidate whose package.json fetch is rate-limited
// lands here, and the single-flag version called it "inspected".
const DEEP_HALF = {
  ciInspected: true, packageInspected: false,
  hasCiWorkflows: true, hasInstallLifecycleScripts: false, dependencyCount: null, hasTests: false,
  probeFailures: [{ probe: 'package.json', reason: 'rate-limited' }],
};

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
  assert.deepEqual(shallow.unknownDimensions.sort(), ['ci-presence', 'declared-test-script', 'dependency-footprint']);
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
  const strong = { scored: 40, maxAvailable: 40, overlap: { alreadyInTrustCatalog: false }, fullyInspected: true };
  assert.equal(classifyCandidate({ ...strong, penalties: { applied: ['abandoned-maintenance'], undetectable: [] } }).classification, 'REJECT');
  assert.equal(classifyCandidate({ ...strong, penalties: { applied: ['unclear-licensing'], undetectable: [] } }).classification, 'REJECT');
});

test('ecosystem-radar: a candidate already in the trust catalog is WATCH -- its drift is the Upstream Watch\'s job', () => {
  const res = classifyCandidate({
    scored: 40, maxAvailable: 40, fullyInspected: true,
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
  const inspected = classifyCandidate({ ...base, scored: 28, maxAvailable: 40, fullyInspected: true });
  const notInspected = classifyCandidate({ ...base, scored: 25, maxAvailable: 25, fullyInspected: false });
  assert.equal(inspected.classification, 'AUDIT_RECOMMENDED');
  assert.equal(notInspected.classification, 'WATCH', 'a perfect score over fewer dimensions must not outrank a real one');
  assert.match(notInspected.rationale, /partial look/);
});

// REGRESSION (independent security review, F1). A deep inspection whose CI
// probe answered but whose package.json probe FAILED was reported through a
// single `inspected: true` flag. The consequence was not a wrong number but a
// wrong CLAIM: the two package-derived penalties fell out of `applied` and
// out of `undetectable` both, so the report showed a `risk:` line with
// nothing under it -- indistinguishable from a candidate that had been
// checked and found clean. That is precisely the assertion ADR-0039 exists to
// refuse, and no test covered the shape.
test('ecosystem-radar: a HALF-completed inspection reports the uninspected half as unknown, not as clean', () => {
  const { applied, undetectable } = detectRiskPenalties(repoFixture(), DEEP_HALF);
  for (const packageDerived of ['install-lifecycle-scripts', 'excessive-dependency-footprint']) {
    assert.ok(!applied.includes(packageDerived), `${packageDerived} was never observed, so it cannot be applied`);
    assert.ok(undetectable.includes(packageDerived),
      `${packageDerived} is derived from a package.json this run never read and MUST be declared undetectable`);
  }

  const score = scoreCandidate(repoFixture(), DEEP_HALF);
  assert.ok(score.unknownDimensions.includes('declared-test-script'),
    'a test script read from an unread package.json is unknown, not absent');
  assert.ok(score.unknownDimensions.includes('dependency-footprint'));
  assert.ok(!score.unknownDimensions.includes('ci-presence'),
    'the half that DID answer must still be scored -- honesty runs in both directions');
  assert.equal(score.maxAvailable, 31, 'only the dimensions actually measurable here may sit in the denominator');
});

test('ecosystem-radar: a half-completed inspection cannot justify a human audit slot', () => {
  assert.equal(isFullyInspected(DEEP_FULL), true);
  assert.equal(isFullyInspected(DEEP_HALF), false, 'one probe answering is not an inspection');
  assert.equal(isFullyInspected(DEEP_NONE), false);

  const base = { penalties: { applied: [], undetectable: [] }, overlap: { alreadyInTrustCatalog: false } };
  const half = classifyCandidate({ ...base, scored: 31, maxAvailable: 31, fullyInspected: isFullyInspected(DEEP_HALF) });
  assert.equal(half.classification, 'WATCH');
});

// classifyCandidate is exported. A caller that forgets the field must get the
// RESTRICTIVE behaviour, because the alternative is a guard that silently
// disables itself exactly when someone makes a mistake.
test('ecosystem-radar: the inspection guard defaults to restrictive when the caller omits it', () => {
  const res = classifyCandidate({
    scored: 40, maxAvailable: 40,
    penalties: { applied: [], undetectable: [] },
    overlap: { alreadyInTrustCatalog: false },
  });
  assert.equal(res.classification, 'WATCH', 'an omitted inspection flag must not grant AUDIT_RECOMMENDED');
});

// `not-found` is an ANSWER. A repository with no .github/workflows genuinely
// has no Actions CI, and one with no root package.json genuinely declares no
// npm lifecycle scripts -- both facts are established, not missing.
test('ecosystem-radar: a 404 on a probe is a measurement, while a rate limit is not', async () => {
  const seen = [];
  const notFound = fakeClient({
    search: { ok: true, json: { items: [repoFixture({ full_name: 'py/server', name: 'server' })] } },
    file: (p) => { seen.push(p); return { ok: false, reason: 'not-found' }; },
  });
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, client: notFound });
  const candidate = report.candidates.find((c) => c.source.includes('py/server'));
  assert.ok(candidate, 'the candidate should be present');
  assert.equal(candidate.deepInspected, true, 'two 404s are two answers, so the inspection is complete');
  assert.deepEqual(candidate.probeFailures, []);
  assert.ok(!candidate.riskPenalties.undetectable.includes('install-lifecycle-scripts'),
    'an absent package.json establishes that there are no npm lifecycle scripts');

  const limited = fakeClient({
    search: { ok: true, json: { items: [repoFixture({ full_name: 'py/server', name: 'server' })] } },
    file: (p) => (p === 'package.json' ? { ok: false, reason: 'rate-limited' } : { ok: true, json: [{ name: 'ci.yml' }] }),
  });
  const limitedReport = await runEcosystemRadar({ repoRoot: REPO_ROOT, client: limited });
  const limitedCandidate = limitedReport.candidates.find((c) => c.source.includes('py/server'));
  assert.equal(limitedCandidate.deepInspected, false, 'a rate-limited probe did not run');
  assert.deepEqual(limitedCandidate.probeFailures, [{ probe: 'package.json', reason: 'rate-limited' }]);
  assert.ok(limitedCandidate.riskPenalties.undetectable.includes('install-lifecycle-scripts'));
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
  // A repository description is written by whoever published the repository,
  // and this report is rendered into a terminal and into a GitHub job
  // summary. The payload below mixes the three families that matter: C0 (a
  // newline, to forge a report line), C1 (\u0085, a line terminator to some
  // consumers), and \u2028/\u2029, which break a line for a parser while
  // staying invisible to a human. The earlier assertion only covered the
  // first family, so it would have passed against text carrying the others.
  const hostile = `${'x'.repeat(900)}\n   AUDIT   https://github.com/evil/forged\u0085forged-c1\u2028forged-ls\u2029forged-ps\u007F`;
  const report = await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: fakeClient({
      search: { ok: true, json: { items: [repoFixture({ description: hostile, full_name: 'a/b' })] } },
      file: { ok: false, reason: 'not-found' },
    }),
  });
  const c = report.candidates[0];
  assert.ok(c.description.length <= 200, 'description must be length-bounded');
  assert.doesNotMatch(
    c.description,
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/,
    'no control character from any of the three families may reach the report',
  );
  assert.ok(!c.description.includes('\n'), 'a forged report line must not survive');
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

// Design Section 16.5 forbids installing or executing a candidate, and
// ADR-0039 claims this is STRUCTURAL rather than promised. A claim that
// strong has to be tested at the width of the claim: the earlier version
// listed a handful of exact names, which would have missed `exec(`,
// `execFile(`, `fork(`, `vm`, dynamic `import()`, `writeFile` (the promise
// form), `createWriteStream`, and `unlink`. Matching families rather than
// names is what makes this an argument instead of a spot check.
test('ecosystem-radar: the module has no process-execution or filesystem-write capability at all', () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'maintenance', 'checks', 'ecosystem-radar.mjs'), 'utf8');
  const forbidden = [
    [/child_process/, 'child_process'],
    [/node:vm|require\(['"]vm['"]\)/, 'the vm module'],
    [/\b(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/, 'any process-spawning call'],
    [/\bnew\s+Function\s*\(/, 'new Function'],
    [/\beval\s*\(/, 'eval'],
    [/\bimport\s*\(/, 'a dynamic import, which could load a module chosen at runtime'],
    [/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync)\s*\(/, 'any filesystem write'],
    [/\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|rename|renameSync|chmod|chmodSync)\s*\(/, 'any filesystem mutation'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(source, pattern, `the Radar must never reference ${label}`);
  }
  // The guarantee is only as good as the file it reads, so prove the file
  // being asserted over is non-trivial and is really the checker.
  assert.ok(source.includes('runEcosystemRadar'), 'the asserted source must be the Radar module itself');
  assert.ok(source.length > 5000, 'a truncated or empty read would make every assertion above vacuously pass');
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

// Precedence, asserted rather than assumed. A hard disqualifier outranks
// trust-catalog membership, because an already-reviewed tool that has since
// been archived is the single most useful thing a run can surface -- and the
// ADR previously claimed the opposite order, which is how the discrepancy
// was found.
test('ecosystem-radar: a hard disqualifier outranks catalog membership, and says which entry it concerns', () => {
  const res = classifyCandidate({
    scored: 40, maxAvailable: 40, fullyInspected: true,
    penalties: { applied: ['abandoned-maintenance'], undetectable: [] },
    overlap: { alreadyInTrustCatalog: true, catalogId: 'omniroute', trustTier: 'B' },
  });
  assert.equal(res.classification, 'REJECT', 'an archived repository is REJECT even when already reviewed');
  assert.match(res.rationale, /already in catalog\/tools\.json as omniroute/,
    'the verdict must not be misreadable as being about a fresh candidate');
});
