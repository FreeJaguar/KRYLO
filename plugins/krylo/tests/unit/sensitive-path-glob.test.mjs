// Focused RED-then-GREEN tests for the glob-aware sensitive-path bypass
// (Foundation glob-closure checkpoint, HEAD 76c9194). Before this
// checkpoint's fix, KRYLO's sensitivePaths patterns matched an EXACT
// secret filename/extension but never recognized that a filesystem glob
// expression (Bash `*`/`?`/`[...]`, PowerShell equivalents, or a Glob/Grep
// path-shaped field) can EXPAND, at shell/tool level, to that same exact
// name -- so `cat .e*` in a directory containing a real `.env` reads it,
// while `.env` itself (no glob chars) was already correctly denied.
//
// classifyRiskAction() is called directly (no Hook process spawn), same
// convention as risk-policy.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { classifyRiskAction } from '../../scripts/security/risk-policy.mjs';

function tempDataRoot() {
  return path.join(os.tmpdir(), 'krylo-glob-test-data-root');
}

test('real isolated shell fixture: Bash genuinely expands ".e*" to a real ".env" file (proves the underlying threat is real, not hypothetical)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-glob-fixture-'));
  try {
    // Never a real secret or real user directory: a throwaway temp dir with
    // a placeholder value, deleted at the end of this test.
    fs.writeFileSync(path.join(dir, '.env'), 'FAKE_TEST_TOKEN=not-a-real-secret\n');
    let expanded;
    try {
      expanded = execFileSync('bash', ['-c', 'cd "$1" && echo .e*', 'bash-fixture', dir], { encoding: 'utf8' }).trim();
    } catch {
      // A real Bash is not available on this machine/CI image -- skip
      // rather than fail the suite on an unrelated environment gap.
      return;
    }
    assert.equal(expanded, '.env', 'Bash must have expanded ".e*" to the literal ".env" filename in this directory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared risk policy denies Bash glob expressions that can expand to a real dotenv file', () => {
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat .e*',
    'cat .en?',
    'cat .[e]nv',
    'cat .*env',
    'cat **/.env',
    'cat **/.e*',
    'cat **/.[e]nv',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path', `expected sensitive-path category for: ${command}`);
  }
});

test('shared risk policy denies Bash glob expressions that can expand to a real SSH-key-style private-key file', () => {
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat id_rsa*',
    'cat id_[r]sa',
    'cat id_ed25519',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path', `expected sensitive-path category for: ${command}`);
  }

  // "id_r?" is a 5-character glob (i,d,_,r,?) and cannot fully match any
  // real 6-character protected key name (id_rsa, id_dsa) under correct,
  // standard glob semantics ("?" matches exactly one character) -- this is
  // proven-correct pass-through, not a gap: no real file it could expand
  // to is one of KRYLO's protected key names.
  const noRealMatch = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat id_r?' }, cwd: process.cwd(), dataRoot });
  assert.equal(noRealMatch.action, 'pass', '"id_r?" (5 chars) cannot glob-match any 6-character protected key name');

  // "id_rs?" (6 chars) DOES fully match "id_rsa" under correct semantics.
  const realMatch = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat id_rs?' }, cwd: process.cwd(), dataRoot });
  assert.equal(realMatch.action, 'deny');
  assert.equal(realMatch.category, 'sensitive-path');
});

test('shared risk policy denies Bash glob expressions that can expand to a sensitive-extension file', () => {
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat prod.pem',
    'cat *.pem',
    'cat *.[p]em',
    'cat backup.key',
    'cat *.key',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path', `expected sensitive-path category for: ${command}`);
  }
});

test('shared risk policy: exact .env.example-style templates remain allowed even though the general dotenv wildcard is denied', () => {
  const dataRoot = tempDataRoot();
  const allowed = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
  ];
  for (const file_path of allowed) {
    const result = classifyRiskAction({ toolName: 'Read', toolInput: { file_path }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass for exact template: ${file_path}`);
  }

  // A GLOB that can ALSO match the real .env (not just the template) must
  // still be denied, even though it happens to also match .env.example --
  // the template exception only protects the EXACT, literal template
  // name, never a wildcard that reaches the real secret too.
  const stillDenied = [
    'cat .env*',
    'cat .e*',
    'cat .[e]nv',
  ];
  for (const command of stillDenied) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny (reaches real .env too): ${command}`);
  }
});

test('shared risk policy denies PowerShell wildcard equivalents for the same bypass', () => {
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'Get-Content .e*',
    'Get-Content .en?',
    'Get-Content .[e]nv',
    'Get-Content id_rsa*',
    'Get-Content *.pem',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'PowerShell', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path', `expected sensitive-path category for: ${command}`);
  }
});

test('shared risk policy denies a Glob pattern capable of matching a real dotenv or private-key file', () => {
  const dataRoot = tempDataRoot();
  const mustDeny = [
    { pattern: '.e*' },
    { pattern: '**/.e*' },
    { pattern: '.[e]nv' },
    { pattern: 'id_rsa*' },
    { pattern: '*.pem' },
  ];
  for (const toolInput of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Glob', toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for Glob(${JSON.stringify(toolInput)})`);
    assert.equal(result.category, 'sensitive-path');
  }
});

test('shared risk policy denies a Grep "glob"/"path" field capable of matching a real dotenv file, but never treats "pattern" (content search) as a path', () => {
  const dataRoot = tempDataRoot();
  const globField = classifyRiskAction({ toolName: 'Grep', toolInput: { pattern: 'TOKEN', glob: '.e*' }, cwd: process.cwd(), dataRoot });
  assert.equal(globField.action, 'deny');
  assert.equal(globField.category, 'sensitive-path');

  const pathField = classifyRiskAction({ toolName: 'Grep', toolInput: { pattern: 'TOKEN', path: '.[e]nv' }, cwd: process.cwd(), dataRoot });
  assert.equal(pathField.action, 'deny');
  assert.equal(pathField.category, 'sensitive-path');

  // Grep's `pattern` is the content regex being searched FOR, never a path
  // -- searching source files for the literal text ".e*" must not deny.
  const contentSearch = classifyRiskAction({ toolName: 'Grep', toolInput: { pattern: '.e*', glob: '**/*.js' }, cwd: process.cwd(), dataRoot });
  assert.equal(contentSearch.action, 'pass', 'Grep pattern text must never be treated as a filesystem path');
});

test('shared risk policy denies Write/Edit/NotebookEdit targets that are glob expressions capable of matching a real sensitive path', () => {
  const dataRoot = tempDataRoot();
  const write = classifyRiskAction({ toolName: 'Write', toolInput: { file_path: '.e*', content: 'x' }, cwd: process.cwd(), dataRoot });
  assert.equal(write.action, 'deny');
  assert.equal(write.category, 'sensitive-path');

  const edit = classifyRiskAction({ toolName: 'Edit', toolInput: { file_path: 'id_[r]sa', old_string: 'a', new_string: 'b' }, cwd: process.cwd(), dataRoot });
  assert.equal(edit.action, 'deny');
  assert.equal(edit.category, 'sensitive-path');
});

test('shared risk policy: an ordinary benign wildcard command that cannot reach any protected name still passes', () => {
  const dataRoot = tempDataRoot();
  const benign = [
    'cat *.txt',
    'cat notes?.md',
    'cat [a-z]og.txt',
    'ls -la *.js',
    'cat report.pem.backup.txt', // does not END in a protected extension
    // A fresh independent Reviewer found a Critical over-block regression
    // in the SAME extension-suffix search that closes the real bypass: it
    // only guarded the FULL pattern for "no specific-name signal", not
    // each individual suffix slice tried inside the search loop, so an
    // ordinary "prefix*" command (real discriminating content overall,
    // like "build") still matched via its degenerate trailing-star-only
    // slice, denying routine wildcard commands with no approval path.
    'ls build*',
    'cat README*',
    'ls -la ~/proj*',
    'tar -czf out.tgz dist*',
  ];
  for (const command of benign) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass for benign command: ${command}`);
  }

  // Contrast: a prefix-then-star that DOES end up reaching a real
  // protected extension must still deny -- the fix narrows the false
  // positive without losing the true positive.
  const stillDenied = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat build*.pem' }, cwd: process.cwd(), dataRoot });
  assert.equal(stillDenied.action, 'deny');
  assert.equal(stillDenied.category, 'sensitive-path');
});

test('shared risk policy: a bare wildcard filename under an already-confirmed protected directory is denied, without widening the context-free bare-wildcard exemption', () => {
  // A fresh independent Reviewer found a real bypass: ".aws/*", ".kube/*",
  // and ".config/gh/*" all passed, because a bare-wildcard FINAL segment
  // was rejected by the same guard that (correctly) rejects a bare
  // wildcard with no directory context at all. Once every LEADING segment
  // has matched the exact protected directory name with real
  // discriminating content, a bare-wildcard final segment legitimately
  // does reach the specific protected filename too -- the directory
  // context already confirms it, the way it would in a real shell.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat .aws/*',
    'cat .kube/*',
    'cat .config/gh/*',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path');
  }

  // Must NOT widen the context-free bare-wildcard exemption: no known
  // protected directory in play, still passes.
  const stillPasses = [
    'cat *',
    'ls -la **',
  ];
  for (const command of stillPasses) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass (no directory context): ${command}`);
  }
  const globStillPasses = classifyRiskAction({ toolName: 'Glob', toolInput: { pattern: '**/*.js' }, cwd: process.cwd(), dataRoot });
  assert.equal(globStillPasses.action, 'pass');
});

test('shared risk policy: a brace-only expansion (no other glob metacharacter) still reaches a real dotenv file', () => {
  // A fresh independent Reviewer found expandSimpleBraceGroup() was
  // unreachable for a pattern containing ONLY a brace group and no other
  // glob metacharacter (the top-level gate checked for */?/[ but not {),
  // even though a real shell expands `.{env,x}` unconditionally.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat .{env,x}',
    'cat .en{v,w}',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path');
  }

  // A brace group with no dangerous branch must still pass.
  const benign = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat notes.{txt,md}' }, cwd: process.cwd(), dataRoot });
  assert.equal(benign.action, 'pass');
});

test('shared risk policy: MULTIPLE brace groups in one candidate are all expanded, not just the first (regression found by a fresh independent Security Reviewer)', () => {
  // The original single-pass expandSimpleBraceGroup() only ever expanded
  // the FIRST `{...}` group, leaving a SECOND group in the output with
  // its literal `{`/`}` characters still present -- which then matched
  // nothing, even though a real shell expands every group in a word.
  // Fixed with an iterative, fixed-point expander bounded by
  // MAX_BRACE_GROUPS rounds and a hard MAX_TOTAL_BRACE_CANDIDATES ceiling
  // (so multiple groups cannot combine into a combinatorial explosion).
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat .e{n,m}{v,w}',
    'cat {.,x}{env,y}',
    'cat .{e,f}{n,m}v',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path');
  }

  // A group beyond MAX_BRACE_BRANCHES (33 here) is a disclosed, explicit
  // bound -- left as literal text. Confirms this is a stable, intentional
  // limit rather than an accidental crash/hang.
  const overBoundBranches = '.{env,' + Array.from({ length: 32 }, (_, i) => `z${i}`).join(',') + '}';
  const overBound = classifyRiskAction({ toolName: 'Bash', toolInput: { command: `cat ${overBoundBranches}` }, cwd: process.cwd(), dataRoot });
  assert.equal(overBound.action, 'pass');

  // Two benign groups must still pass.
  const benign = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat notes.{txt,md}.{v1,v2}' }, cwd: process.cwd(), dataRoot });
  assert.equal(benign.action, 'pass');
});

test('shared risk policy: brace expansion combined with a dense bracket-class candidate does not compound into a multi-second stall (regression found by a fresh independent Security Reviewer: measured 40-60 seconds before this fix)', () => {
  // Each candidate segment was being re-parsed from scratch once per
  // globProtectedPaths entry PLUS once per protected extension (~22
  // times), which, stacked with brace expansion producing up to
  // MAX_BRACE_BRANCHES candidates each carrying a dense bracket-class
  // body, multiplied into hundreds of millions of redundant operations --
  // far worse than the single-candidate stall this same fix round's
  // MAX_CLASS_SET_SIZE bound was meant to close, since that bound only
  // limits the cost of ONE parse, not how many times the same segment
  // gets re-parsed. Fixed by parsing each segment's atoms exactly once
  // per candidate and reusing them across every check.
  const dataRoot = tempDataRoot();
  const denseClass = '[Ā-￿]'.repeat(796);
  const braceGroup = `{${Array.from({ length: 32 }, (_, i) => `a${i}`).join(',')}}`;
  const payload = braceGroup + denseClass;

  const start1 = Date.now();
  const result1 = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: payload }, cwd: process.cwd(), dataRoot });
  const elapsed1 = Date.now() - start1;
  assert.ok(elapsed1 < 1000, `Read classification took ${elapsed1}ms, expected under 1000ms (was 40-60s before this fix)`);
  assert.equal(result1.action, 'pass');

  const start2 = Date.now();
  const result2 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: `cat ${payload}` }, cwd: process.cwd(), dataRoot });
  const elapsed2 = Date.now() - start2;
  assert.ok(elapsed2 < 1000, `Bash classification took ${elapsed2}ms, expected under 1000ms (was 40-60s before this fix)`);
  assert.equal(result2.action, 'pass');
});

test('shared risk policy: a bare wildcard with no discriminating literal content ("*", "**") does not match every protected name -- the fix must not turn every wildcard command into a blanket deny', () => {
  // A lone star (or any run of consecutive stars, which collapse to one
  // star atom) fully matches ANY literal by construction -- without an
  // explicit guard against this, `cat *` would "match" .env, id_rsa, every
  // sensitive extension, and everything else in the policy, exactly the
  // over-blocking this checkpoint's own task explicitly warns against.
  // Caught in this checkpoint's own review before shipping (a genuine
  // Glob/Grep recursive-glob false positive: "**/*.js" was denied as
  // "could reach .ssh", since a bare "**" directory segment trivially
  // "matches" the literal ".ssh" the same way it matches anything).
  const dataRoot = tempDataRoot();
  const mustPass = [
    ['Bash', { command: 'cat *' }],
    ['Bash', { command: 'ls -la **' }],
    ['Glob', { pattern: '**/*.js' }],
    ['Glob', { pattern: '**/*.test.mjs' }],
    ['Grep', { pattern: 'TODO', glob: '**/*.js' }],
    ['Read', { file_path: '*' }],
  ];
  for (const [toolName, toolInput] of mustPass) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass (bare wildcard, no specific target) for ${toolName}(${JSON.stringify(toolInput)})`);
  }

  // Contrast: a directory-scoped protection (.ssh/*) still correctly
  // denies when the directory segment is a wildcard that DOES carry
  // discriminating content specifically resembling ".ssh" (not a bare
  // wildcard) -- proving the guard above narrows correctly rather than
  // disabling this class of protection entirely.
  const stillDenied = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat .s?h/config' }, cwd: process.cwd(), dataRoot });
  assert.equal(stillDenied.action, 'deny');
  assert.equal(stillDenied.category, 'sensitive-path');
});

test('shared risk policy glob-aware check is bounded: a very long adversarial wildcard/class input near the command-size limit classifies quickly and correctly, with no ReDoS-style stall', () => {
  const dataRoot = tempDataRoot();

  // Long runs of the SAME metacharacter, near the 10,000-char Bash command
  // guard, must not cause a multi-second stall (measured, not merely
  // asserted) and must still resolve correctly.
  const longStarRun = `cat ${'*'.repeat(4000)}.pem`;
  const start1 = Date.now();
  const result1 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: longStarRun }, cwd: process.cwd(), dataRoot });
  const elapsed1 = Date.now() - start1;
  assert.ok(elapsed1 < 1000, `long star-run classification took ${elapsed1}ms, expected under 1000ms`);
  assert.equal(result1.action, 'deny');
  assert.equal(result1.category, 'sensitive-path');

  // Alternating metacharacters (does not collapse the way repeated `*`
  // does -- each "?" is a separate atom requiring its own mandatory
  // character) must still classify quickly. 2000 mandatory "?" atoms
  // cannot be satisfied by a 4-character literal (".env"), so this
  // correctly resolves to "pass", not "deny" -- the point of this case is
  // the bounded TIMING, not a forced match.
  const longAlternating = `cat ${'*?'.repeat(2000)}.env`;
  const start2 = Date.now();
  const result2 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: longAlternating }, cwd: process.cwd(), dataRoot });
  const elapsed2 = Date.now() - start2;
  assert.ok(elapsed2 < 1000, `long alternating-metachar classification took ${elapsed2}ms, expected under 1000ms`);
  assert.equal(result2.action, 'pass');

  // A very long bracket-class body, still bounded.
  const longClass = `cat .[${'e'.repeat(3000)}]nv`;
  const start3 = Date.now();
  const result3 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: longClass }, cwd: process.cwd(), dataRoot });
  const elapsed3 = Date.now() - start3;
  assert.ok(elapsed3 < 1000, `long bracket-class classification took ${elapsed3}ms, expected under 1000ms`);
  assert.equal(result3.action, 'deny');

  // A benign, very long wildcard command that does NOT reach any
  // protected name must also classify quickly and pass.
  const longBenign = `cat ${'a'.repeat(5000)}*.txt`;
  const start4 = Date.now();
  const result4 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: longBenign }, cwd: process.cwd(), dataRoot });
  const elapsed4 = Date.now() - start4;
  assert.ok(elapsed4 < 1000, `long benign classification took ${elapsed4}ms, expected under 1000ms`);
  assert.equal(result4.action, 'pass');

  // A genuinely adversarial shape that DOES match (many alternating
  // literal-then-star atoms is the classic pathological input for a
  // naive backtracking wildcard matcher) must resolve just as quickly.
  const worstCaseMatching = `cat ${'a?'.repeat(2500)}.pem`;
  const start5 = Date.now();
  const result5 = classifyRiskAction({ toolName: 'Bash', toolInput: { command: worstCaseMatching }, cwd: process.cwd(), dataRoot });
  const elapsed5 = Date.now() - start5;
  assert.ok(elapsed5 < 1000, `worst-case matching classification took ${elapsed5}ms, expected under 1000ms`);
  assert.equal(result5.action, 'deny');
  assert.equal(result5.category, 'sensitive-path');
});

test('shared risk policy: an oversized bracket-class body on a Read/Write/Glob/Grep path field (no MAX_BASH_COMMAND_LENGTH-style guard on those tools) does not cause a multi-second stall, and correctly DENIES rather than being silently skipped (regression found by a fresh independent Security Reviewer: measured ~19 seconds before this fix)', () => {
  // Bash/PowerShell commands are bounded by MAX_BASH_COMMAND_LENGTH, but
  // Read/Write/Edit/NotebookEdit/Glob/Grep path-shaped fields had no
  // equivalent cap. A bracket class body packed with hundreds of
  // thousands of individually-bounded range specs (each already capped at
  // 1024 codepoints) had no limit on how MANY such ranges one class could
  // contain, driving total work into the hundreds of millions of Set
  // insertions -- independently measured at ~19 seconds for a real,
  // reachable ~990,000-character candidate (well within the 1MB Hook-
  // stdin size limit). Fixed with a total distinct-character budget per
  // bracket class (MAX_CLASS_SET_SIZE) plus a cap on how many bracket-
  // class occurrences one pattern is parsed for at all
  // (MAX_CLASS_ATOMS_PER_PATTERN) -- NOT an overall candidate-length cap,
  // which a further review found was itself a fail-open bypass (see the
  // dedicated padding-bypass test below).
  const dataRoot = tempDataRoot();

  const hugeCandidate = `.[${'\u0000-\uffff'.repeat(330000)}]nv`;
  const start1 = Date.now();
  const result1 = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: hugeCandidate }, cwd: process.cwd(), dataRoot });
  const elapsed1 = Date.now() - start1;
  assert.ok(elapsed1 < 1000, `oversized bracket-class candidate took ${elapsed1}ms, expected under 1000ms (was ~19000ms before this fix)`);
  assert.equal(result1.action, 'deny', 'the oversized candidate must be correctly DENIED, not merely fast -- a test that only measures elapsed time would silently accept a fail-open bypass');
  assert.equal(result1.category, 'sensitive-path');

  // A dense-but-shorter bracket body must also resolve quickly and still
  // correctly deny.
  const denseButUnderCap = `.[${'\u0000-\uffff'.repeat(500)}]nv`;
  const start2 = Date.now();
  const result2 = classifyRiskAction({ toolName: 'Glob', toolInput: { pattern: denseButUnderCap }, cwd: process.cwd(), dataRoot });
  const elapsed2 = Date.now() - start2;
  assert.ok(elapsed2 < 1000, `dense bracket-class candidate took ${elapsed2}ms, expected under 1000ms`);
  assert.equal(result2.action, 'deny');
  assert.equal(result2.category, 'sensitive-path');

  // A legitimate, ordinary bracket class must still work correctly.
  const legitimate = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: '.[e]nv' }, cwd: process.cwd(), dataRoot });
  assert.equal(legitimate.action, 'deny');
  assert.equal(legitimate.category, 'sensitive-path');
});

test('shared risk policy: padding a candidate with harmless leading segments does not bypass the glob check (regression found by a fresh independent Reviewer: an earlier overall-length cap was itself a fail-open bypass)', () => {
  // An earlier fix for the oversized-bracket-body stall (above) added a
  // whole-candidate length cap that skipped the glob-aware check entirely
  // for anything past it. A fresh Reviewer found this was itself a real,
  // trivially reachable bypass: padding a candidate with harmless leading
  // segments just past the cap evaded detection completely, even though
  // the real danger (".e*") was still right there at the end. Fixed by
  // removing the length cap entirely and instead only ever examining the
  // TRAILING segments a protected path can possibly match against (the
  // longest protected path needs 3), so neither the number nor the length
  // of any leading segments has any bearing on whether the real danger at
  // the end is caught.
  const dataRoot = tempDataRoot();
  const padding = './'.repeat(2100);

  const start = Date.now();
  const result = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: `${padding}.e*` }, cwd: process.cwd(), dataRoot });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `padded candidate took ${elapsed}ms, expected under 1000ms`);
  assert.equal(result.action, 'deny', 'padding with harmless leading segments must not evade detection of the real ".e*" danger at the end');
  assert.equal(result.category, 'sensitive-path');

  // Padding with no real danger at the end must still correctly pass.
  const benign = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: `${padding}notes.txt` }, cwd: process.cwd(), dataRoot });
  assert.equal(benign.action, 'pass');
});

test('shared risk policy: a bare wildcard segment in the MIDDLE (or first) position of a multi-segment protected directory path is denied, without over-widening to fully generic paths (regression found by a fresh independent Reviewer)', () => {
  // The previous fix for ".aws/*"/".kube/*" only relaxed the FINAL
  // segment of a multi-segment protected path. A fresh Reviewer found an
  // equally real form still evaded: `cat .config/*/hosts.yml` (the
  // MIDDLE segment wildcarded, not the last) still reaches the real
  // `.config/gh/hosts.yml` in a real shell. Fixed by allowing the
  // relaxation at ANY ONE segment position (never two or more, and never
  // when the protected path already has its own policy-level "*"
  // sentinel -- combining that free pass with a second relaxed position
  // would let a fully generic candidate match with zero real signal).
  const dataRoot = tempDataRoot();
  const mustDeny = [
    'cat .config/*/hosts.yml',
    'cat */gh/hosts.yml',
  ];
  for (const command of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path');
  }

  // Must NOT over-widen: a fully generic multi-segment path (no segment
  // carries any real discriminating content at all) must still pass,
  // including against a protectedPath that itself has a "*" sentinel
  // (".ssh/*") -- combining the sentinel's own free pass with a second
  // relaxed position must not let "*/*" match it.
  const mustPass = [
    'cat */*/*',
    'cat */*',
    'cat *',
  ];
  for (const command of mustPass) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass (fully generic, no real signal): ${command}`);
  }
});

test('shared risk policy: path traversal combined with glob syntax still resolves to the correct decision (denied when it reaches a real secret, allowed for an exact template)', () => {
  const dataRoot = tempDataRoot();
  const traversalToRealSecret = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat .env.example/../.e*' }, cwd: process.cwd(), dataRoot });
  assert.equal(traversalToRealSecret.action, 'deny');
  assert.equal(traversalToRealSecret.category, 'sensitive-path');

  const exactTemplateOnly = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: 'config/.env.example' }, cwd: process.cwd(), dataRoot });
  assert.equal(exactTemplateOnly.action, 'pass');
});
