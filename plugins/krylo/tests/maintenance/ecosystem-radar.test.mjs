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
  BEHAVIOURAL_PENALTIES,
} from '../../scripts/maintenance/checks/ecosystem-radar.mjs';
import { renderText } from '../../scripts/maintenance/check-ecosystem-radar.mjs';

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
const DEEP_FULL = { ciInspected: true, packageInspected: true, packagePresent: true, scopeLimited: false, hasCiWorkflows: true, hasInstallLifecycleScripts: false, dependencyCount: 0, hasTests: true, probeFailures: [] };
// No deep-inspection slot at all: neither probe ran.
const DEEP_NONE = { ciInspected: false, packageInspected: false, packagePresent: false, scopeLimited: false, hasCiWorkflows: false, hasInstallLifecycleScripts: false, dependencyCount: null, hasTests: false, probeFailures: [] };
// The shape the whole split exists for: CI was read, package.json was not.
// Every Python or Go candidate whose package.json fetch is rate-limited
// lands here, and the single-flag version called it "inspected".
const DEEP_HALF = {
  ciInspected: true, packageInspected: false, packagePresent: false, scopeLimited: false,
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
test('ecosystem-radar: a 404 answers the REQUEST without measuring the candidate, while a rate limit answers nothing', async () => {
  const seen = [];
  const notFound = fakeClient({
    search: { ok: true, json: { items: [repoFixture({ full_name: 'py/server', name: 'server' })] } },
    file: (p) => { seen.push(p); return { ok: false, reason: 'not-found' }; },
  });
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, client: notFound });
  const candidate = report.candidates.find((c) => c.source.includes('py/server'));
  assert.ok(candidate, 'the candidate should be present');
  assert.equal(candidate.deepInspected, true, 'two 404s are two answered probes, so the inspection ran to completion');
  assert.deepEqual(candidate.probeFailures, [], 'nothing failed: the answer was "there is nothing here"');
  // Corrected from the inverse assertion, which encoded the very over-claim a
  // second review caught (S1): a completed inspection is not the same as a
  // measured candidate. An absent ROOT package.json leaves the npm-derived
  // penalties unmeasured, and the report must say so.
  assert.ok(candidate.riskPenalties.undetectable.includes('install-lifecycle-scripts'),
    'an absent ROOT package.json does not establish that the repository declares no install hooks');

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


// REGRESSION (second independent review, S1). The FIRST fix for F1 treated a
// 404 on package.json as a measurement: it set dependencyCount to 0, which
// awarded a full 5/5 for "zero runtime dependencies" to a repository whose
// dependencies had never been read, and dropped both package-derived
// penalties out of `applied` and `undetectable` alike -- F1's exact
// signature, reintroduced in a narrower and more confident form. A missing
// ROOT package.json is not a missing manifest: monorepos, Python and Go
// candidates all take this path, and `topic:mcp-server` is a shipped query.
const DEEP_NO_MANIFEST = {
  ciInspected: true, packageInspected: true, packagePresent: false, scopeLimited: false,
  hasCiWorkflows: true, hasInstallLifecycleScripts: false, dependencyCount: null, hasTests: false,
  probeFailures: [],
};

test('ecosystem-radar: an absent root package.json establishes nothing about dependencies or install hooks', () => {
  const { applied, undetectable } = detectRiskPenalties(repoFixture(), DEEP_NO_MANIFEST);
  for (const packageDerived of ['install-lifecycle-scripts', 'excessive-dependency-footprint']) {
    assert.ok(!applied.includes(packageDerived));
    assert.ok(undetectable.includes(packageDerived),
      `a repository with no ROOT manifest may still declare ${packageDerived} elsewhere; it must be reported unchecked`);
  }

  const score = scoreCandidate(repoFixture(), DEEP_NO_MANIFEST);
  assert.ok(score.unknownDimensions.includes('dependency-footprint'),
    'crediting "zero runtime dependencies" for an unread manifest is a fabricated positive');
  assert.ok(score.unknownDimensions.includes('declared-test-script'),
    'and charging 0/4 for an unread manifest is the mirror-image fabricated negative');
  assert.ok(!score.unknownDimensions.includes('ci-presence'), 'the CI half was genuinely measured');
});

test('ecosystem-radar: a non-Node candidate is still fully inspected and can still earn an audit', () => {
  // Honesty must not degrade into uselessness: the absence of a manifest is
  // not a failed inspection, so such a candidate is still ranked on what was
  // actually measured rather than being held at WATCH for being non-Node.
  assert.equal(isFullyInspected(DEEP_NO_MANIFEST), true);
  const score = scoreCandidate(repoFixture(), DEEP_NO_MANIFEST);
  const res = classifyCandidate({
    ...score, penalties: detectRiskPenalties(repoFixture(), DEEP_NO_MANIFEST),
    overlap: { alreadyInTrustCatalog: false }, fullyInspected: true,
  });
  assert.ok(['WATCH', 'AUDIT_RECOMMENDED'].includes(res.classification));
});

// S3. Bidi overrides and zero-width characters do not merely forge a line;
// they change what a human READS while the bytes say something else. The
// report is the only input to the decision about where to spend an audit
// slot, so a publisher name that renders as a different publisher is the
// most consequential possible corruption of it.
test('ecosystem-radar: bidi overrides, isolates and zero-width characters never reach the report', async () => {
  const payload = `evil\u202Eelbaton-lacitirc\u200B\u2066anthropics\u2069\uFEFF`;
  const report = await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: fakeClient({
      search: { ok: true, json: { items: [repoFixture({ description: payload, full_name: 'a/b' })] } },
      file: { ok: false, reason: 'not-found' },
    }),
  });
  const c = report.candidates[0];
  const forbidden = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  assert.doesNotMatch(c.description, forbidden, 'no bidi or zero-width character may reach the report');
  assert.doesNotMatch(c.publisher, forbidden);
});

// S4. The renderer is the SUBJECT of the F2 fix and had no test at all,
// which is precisely where that defect returns unnoticed.
test('ecosystem-radar report: an unchecked penalty is visible in the text a human actually reads', () => {
  const report = {
    mode: 'live',
    sources: [{ id: 'q', status: 'ok', found: 1 }],
    candidates: [{
      classification: 'WATCH', source: 'https://github.com/a/b', publisher: 'a', publisherType: 'User',
      license: 'MIT', stars: 1, maintenanceSignal: 'pushed 0d ago', description: 'x', rationale: 'y',
      deepInspected: false,
      score: { scored: 10, maxAvailable: 25, unknownDimensions: ['dependency-footprint'] },
      riskPenalties: { applied: [], undetectable: ['install-lifecycle-scripts', ...BEHAVIOURAL_PENALTIES] },
      probeFailures: [{ probe: 'package.json', reason: 'rate-limited' }],
      overlap: { alreadyInTrustCatalog: false },
    }],
    summary: { total: 1, auditRecommended: 0, watch: 1, rejected: 0, sourcesUnavailable: 0 },
  };
  const text = renderText(report);
  assert.match(text, /^ +not checked on this candidate: install-lifecycle-scripts$/m,
    'a penalty unchecked for THIS candidate must appear beside its entry');
  assert.match(text, /inspection incomplete: package\.json \(rate-limited\)/,
    'a probe that did not run must be named, not silently omitted');
  assert.match(text, /not measurable here: dependency-footprint/);
  for (const behavioural of BEHAVIOURAL_PENALTIES) {
    assert.ok(text.includes(behavioural), `${behavioural} must still appear somewhere in the report`);
  }
  // The constant set is stated ONCE, not repeated under every candidate.
  assert.equal(text.split('broad-secret-access').length - 1, 1);
  assert.match(text, /No candidate above has been cleared of them/);
});

test('ecosystem-radar report: a clean candidate is not made to look checked for what was not checked', () => {
  const text = renderText({
    mode: 'live', sources: [], summary: {},
    candidates: [{
      classification: 'AUDIT_RECOMMENDED', source: 'https://github.com/a/b', publisher: 'a',
      publisherType: 'User', license: 'MIT', stars: 1, maintenanceSignal: 'pushed 0d ago',
      description: '', rationale: 'y', deepInspected: true,
      score: { scored: 36, maxAvailable: 40, unknownDimensions: [] },
      riskPenalties: { applied: [], undetectable: [...BEHAVIOURAL_PENALTIES] },
      probeFailures: [], overlap: { alreadyInTrustCatalog: false },
    }],
  });
  // Anchored to the RENDERED candidate line, indentation and all: the footer
  // legend quotes the same phrase, and a looser pattern matched that instead
  // of the thing under test.
  assert.doesNotMatch(text, /^ +not checked on this candidate:/m,
    'with nothing candidate-specific unchecked, the line must be absent rather than empty');
  assert.match(text, /No candidate above has been cleared of them/,
    'but the always-behavioural caveat must still apply to it');
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
  // BOTH files, because the one the scheduled workflow actually invokes is
  // the entrypoint, and an earlier version of this test scanned only the
  // checker -- asserting the property of a module while the executable half
  // of the same subsystem went unexamined.
  const source = [
    path.join(PLUGIN_ROOT, 'scripts', 'maintenance', 'checks', 'ecosystem-radar.mjs'),
    path.join(PLUGIN_ROOT, 'scripts', 'maintenance', 'check-ecosystem-radar.mjs'),
  ].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const forbidden = [
    [/child_process/, 'child_process'],
    [/node:vm|require\(['"]vm['"]\)/, 'the vm module'],
    // Anchored to a module binding rather than a bare name: a bare /exec\(/
    // also matches RegExp.prototype.exec, and a false positive on a
    // legitimate call is how a future maintainer gets pushed into weakening
    // a security test, which this repository forbids outright.
    [/(?:child_process|cp|proc)\s*\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/, 'a process-spawning call on a child_process binding'],
    [/(?:^|[^.\w])(execSync|execFileSync|spawnSync)\s*\(/m, 'a bare synchronous process call'],
    [/\bnew\s+Function\s*\(/, 'new Function'],
    [/\beval\s*\(/, 'eval'],
    // `import(` only where it is a call, not inside prose: the comments in
    // these files legitimately discuss imports.
    [/(?:^|[^\w.'"`])import\s*\(\s*[^)'"`\s]/m, 'a dynamic import, which could load a module chosen at runtime'],
    [/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync)\s*\(/, 'any filesystem write'],
    [/\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|rename|renameSync|chmod|chmodSync)\s*\(/, 'any filesystem mutation'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(source, pattern, `the Radar must never reference ${label}`);
  }
  // The guarantee is only as good as the file it reads, so prove the file
  // being asserted over is non-trivial and is really the checker.
  assert.ok(source.includes('runEcosystemRadar'), 'the asserted source must be the Radar checker');
  assert.ok(source.includes('renderText'), 'and must include the entrypoint the workflow actually runs');
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


// ---------------------------------------------------------------------------
// REGRESSIONS from the THIRD independent review, which ran on a different
// model family. It found the SAME over-claim family in five more places,
// none of which the two prior reviews had reached. Each test below is one of
// them, and each was reproduced against the shipped code before being fixed.
//
// The unifying rule, now encoded once in the checker's validator helpers
// instead of being improvised at each call site: transport success is not
// data validity, a successful parse is not a schema check, and an absent
// field is not a zero.
// ---------------------------------------------------------------------------

/** Drive a full run with a chosen package.json body and repo metadata. */
async function runWith({ pkg = '{}', repo: over = {}, ci = [{ name: 'ci.yml' }] } = {}) {
  const client = {
    searchGithubRepositories: async () => ({ ok: true, json: { items: [repoFixture(over)] } }),
    getGithubFileContent: async (o, r, p) => (p === 'package.json'
      ? (pkg === null
        ? { ok: false, reason: 'not-found' }
        : { ok: true, json: { content: Buffer.from(pkg).toString('base64'), encoding: 'base64' } })
      : { ok: true, json: ci }),
  };
  const report = await runEcosystemRadar({ repoRoot: REPO_ROOT, client });
  return report.candidates[0];
}

// A publisher controls their own package.json byte for byte. All four of
// these parse cleanly, and the old `typeof x === 'object'` guards then
// substituted `{}` and reported a confident "zero runtime dependencies"
// worth a full 5/5, plus a measured "declares no test script".
test('ecosystem-radar: a package.json that PARSES but is not a valid manifest measures nothing', async () => {
  for (const body of ['null', 'false', '[]', '{"dependencies":false,"scripts":42}']) {
    const c = await runWith({ pkg: body });
    assert.ok(c.score.unknownDimensions.includes('dependency-footprint'), `${body}: footprint must be unknown`);
    assert.ok(c.score.unknownDimensions.includes('declared-test-script'), `${body}: test script must be unknown`);
    for (const penalty of ['install-lifecycle-scripts', 'excessive-dependency-footprint']) {
      assert.ok(c.riskPenalties.undetectable.includes(penalty), `${body}: ${penalty} must be undetectable`);
      assert.ok(!c.riskPenalties.applied.includes(penalty), `${body}: ${penalty} cannot be applied`);
    }
  }
});

// A workspace root is a valid manifest describing the repository's LAYOUT.
// Its own empty dependency list says nothing about packages/*, which this
// Radar never fetches -- yet it scored a perfect 5/5.
test('ecosystem-radar: a workspace root manifest does not measure the repository it points at', async () => {
  const c = await runWith({ pkg: '{"private":true,"workspaces":["packages/*"]}' });
  assert.ok(c.score.unknownDimensions.includes('dependency-footprint'));
  assert.ok(c.riskPenalties.undetectable.includes('install-lifecycle-scripts'),
    'a postinstall hook in packages/server is not excluded by an empty root manifest');
  assert.match(c.score.breakdown['dependency-footprint'].signal, /workspaces/);
});

// optionalDependencies are installed by default and run the same install
// hooks, so excluding them let 31 of them score as dependency-free.
test('ecosystem-radar: optionalDependencies count toward the dependency footprint', async () => {
  const pkg = JSON.stringify({ optionalDependencies: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`d${i}`, '1.0.0'])) });
  const c = await runWith({ pkg });
  assert.equal(c.score.breakdown['dependency-footprint'].points, 0);
  assert.match(c.score.breakdown['dependency-footprint'].signal, /31 runtime dependencies/);
  assert.ok(c.riskPenalties.applied.includes('excessive-dependency-footprint'),
    'the penalty must be APPLIED, not merely reflected in a lower score');
});

// The signal string said "unknown-last-push" while the points sat in the
// denominator as a measured zero. Printing the word does not repair the sum.
test('ecosystem-radar: an unusable last-push date is unknown, not a measured zero', async () => {
  for (const pushed_at of [undefined, null, 'not-a-date']) {
    const c = await runWith({ repo: { pushed_at } });
    assert.ok(c.score.unknownDimensions.includes('maintenance-activity'), `pushed_at=${pushed_at}`);
    assert.ok(c.score.maxAvailable < 40, 'an unmeasured dimension must leave the denominator');
  }
});

// `{spdx_id: {}}` scored 2/5 as "declared ([object Object])" AND cleared the
// unclear-licensing penalty: points and a clean bill for an unreadable value.
test('ecosystem-radar: malformed licence metadata earns no points and clears no penalty', async () => {
  for (const license of [{ spdx_id: {} }, { spdx_id: 42 }, { spdx_id: [] }]) {
    const c = await runWith({ repo: { license } });
    assert.ok(c.score.unknownDimensions.includes('license-and-provenance'), JSON.stringify(license));
    assert.ok(c.riskPenalties.undetectable.includes('unclear-licensing'),
      'an unreadable licence is not a licence we checked');
    assert.ok(!c.riskPenalties.applied.includes('unclear-licensing'),
      'nor is it a licence we established to be missing');
  }
});

// GitHub sends `license: null` for a genuinely unlicensed repository. That
// IS an answer, and must stay a REJECT rather than becoming unknown --
// honesty about ignorance must not erase the facts actually established.
test('ecosystem-radar: an explicit null licence remains a measured disqualifier', async () => {
  const c = await runWith({ repo: { license: null } });
  assert.ok(c.riskPenalties.applied.includes('unclear-licensing'));
  assert.equal(c.classification, 'REJECT');
  assert.ok(!c.score.unknownDimensions.includes('license-and-provenance'));
});

test('ecosystem-radar: absent topics and an absent archived flag are unknowns, not negatives', async () => {
  const noTopics = await runWith({ repo: { topics: undefined } });
  assert.ok(noTopics.score.unknownDimensions.includes('host-compatibility'),
    'a topics array we never received is not a repository that declared no host');

  const noArchived = await runWith({ repo: { archived: undefined } });
  assert.ok(noArchived.riskPenalties.undetectable.includes('abandoned-maintenance'),
    'an absent archived flag does not establish that a repository is maintained');
  assert.ok(!noArchived.riskPenalties.applied.includes('abandoned-maintenance'));
});

// The client validates JSON syntax, not schema. A 200 carrying the wrong
// shape was read as data: a measured absence of CI, and a source that
// "found zero results" while `sourcesUnavailable` stayed at zero.
test('ecosystem-radar: a valid response of the wrong SHAPE is a failed probe, not a measurement', async () => {
  const c = await runWith({ ci: { unexpected: true } });
  assert.ok(c.score.unknownDimensions.includes('ci-presence'));
  assert.ok(c.probeFailures.some((f) => f.reason === 'unexpected-response-shape'));

  const report = await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: {
      searchGithubRepositories: async () => ({ ok: true, json: { unexpected: true } }),
      getGithubFileContent: async () => ({ ok: false, reason: 'not-found' }),
    },
  });
  assert.equal(report.candidates.length, 0);
  assert.ok(report.summary.sourcesUnavailable > 0,
    'a source that returned something unreadable is unavailable, not empty');
  assert.ok(report.sources.every((s) => s.status === 'SOURCE_UNAVAILABLE'));
});

// A bidi override survived into JSON.stringify(report) through the licence
// breakdown signal while the top-level `license` beside it was sanitised.
test('ecosystem-radar: every breakdown signal is sanitised and bounded, including in JSON output', async () => {
  const RLO = '\u202E';
  const report = await runEcosystemRadar({
    repoRoot: REPO_ROOT,
    client: {
      searchGithubRepositories: async () => ({
        ok: true,
        json: { items: [repoFixture({ license: { spdx_id: `MIT${RLO}${'word '.repeat(200)}` } })] },
      }),
      getGithubFileContent: async () => ({ ok: false, reason: 'not-found' }),
    },
  });
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes(RLO), 'no bidi override may reach the JSON output');
  for (const r of Object.values(report.candidates[0].score.breakdown)) {
    assert.ok(r.signal.length <= 90, 'every signal must be bounded');
  }
});

// The code words host points as "declares ... as a target" precisely to mark
// them as self-reported intent. That qualification lived only in a field the
// report never printed.
test('ecosystem-radar report: the per-dimension signals reach the text a human reads', async () => {
  const client = {
    searchGithubRepositories: async () => ({ ok: true, json: { items: [repoFixture()] } }),
    getGithubFileContent: async (o, r, p) => (p === 'package.json'
      ? { ok: true, json: { content: Buffer.from('{"scripts":{"test":"node --test"}}').toString('base64'), encoding: 'base64' } }
      : { ok: true, json: [{ name: 'ci.yml' }] }),
  };
  const text = renderText(await runEcosystemRadar({ repoRoot: REPO_ROOT, client }));
  assert.match(text, /host-compatibility: {0,2}\d+ \(declares Claude as a target/,
    'ten points of SELF-DECLARED host affinity must not render as an unqualified total');
  assert.match(text, /ci-presence: 6 \(CI workflows present\)/);
});
