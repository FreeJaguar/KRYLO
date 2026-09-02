// Direct tests for the shared, host-neutral risk policy: classifyRiskAction
// is called directly (no Hook process spawn, no Claude JSON), so a
// contributor changing scripts/security/risk-policy.mjs gets fast, precise
// feedback here, and scripts/security/risk-gate.mjs (the Claude adapter) is
// exercised end-to-end separately by tests/hooks/risk-gate*.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRiskAction } from '../../scripts/security/risk-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RISK_POLICY_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'security', 'risk-policy.mjs');

// Platform-safe temp dir: os.tmpdir() resolves to the real system temp
// location on Windows, macOS, and Linux alike (never a hardcoded /tmp). The
// directory is only ever used as a string for data-root-protection matching
// in these tests, never created or written to.
function tempDataRoot() {
  return path.join(os.tmpdir(), 'krylo-risk-policy-test-data-root');
}

test('shared risk policy classifies git push without Claude Hook JSON', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-push');
  assert.equal(result.category, 'git-push');
  assert.equal('hookSpecificOutput' in result, false);
});

test('shared risk policy classifies every one of the 12 production-policy.json approvalClasses correctly, by exact class name', () => {
  // Task requirement (ADR-0027): review the complete require-approval class
  // matrix and do not leave a class accidentally unreachable. This asserts
  // the exact actionClass name for one representative command per class, so
  // a class silently renamed or removed from the policy file surfaces as a
  // test failure here, not merely as a missing test.
  const cases = [
    ['kubectl --context prod apply -f app.yaml', 'production-deploy'],
    ['prisma migrate deploy', 'production-data-write'],
    ['rm -rf /var/data', 'destructive-operation'],
    ['npm publish', 'package-publish'],
    ['gh release create v1.0.0', 'release'],
    ['git push origin main', 'git-push'],
    ['git push --force origin main', 'git-force'],
    ['gh pr merge 42', 'merge'],
    ['gh secret set DEPLOY_KEY', 'iam-or-secrets'],
    ['stripe charges create --amount 100', 'payment'],
    ['slack send "release is out"', 'external-message'],
    ['npx omniroute start', 'external-write'],
  ];
  for (const [command, expectedClass] of cases) {
    const result = classifyRiskAction({
      toolName: 'Bash',
      toolInput: { command },
      cwd: process.cwd(),
      dataRoot: tempDataRoot(),
    });
    assert.equal(result.action, 'require-approval', `expected require-approval for ${expectedClass}: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected actionClass ${expectedClass} for: ${command}`);
  }
});

test('shared risk policy no longer over-matches git-push on unrelated commands merely containing the word "push" later in the text (Foundation final-closure D4)', () => {
  // Three independent review rounds flagged the same over-breadth: the
  // git-push pattern matched the literal word "push" appearing anywhere
  // after "git", with no requirement that it actually be the git
  // subcommand -- so `git commit -m "push button feature"` classified as
  // git-push. Tightened to require "push" immediately follow "git" plus
  // only recognized global option tokens (-C, -c, --git-dir=, etc.), not
  // any arbitrary later text.
  const dataRoot = tempDataRoot();
  const mustStillMatch = [
    ['git push origin main', 'git-push'],
    ['git -C /some/repo push origin main', 'git-push'],
    ['git -c user.name=x push origin main', 'git-push'],
    ['git --git-dir=/r/.git push', 'git-push'],
    ['git push origin +main', 'git-force'],
    ['git push --force origin main', 'git-force'],
  ];
  for (const [command, expectedClass] of mustStillMatch) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected ${expectedClass} for: ${command}`);
  }

  const mustNoLongerMatch = [
    'git commit -m "push button feature"',
    'git status\necho push',
  ];
  for (const command of mustNoLongerMatch) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.notEqual(result.actionClass, 'git-push', `must not classify as git-push: ${command}`);
    assert.notEqual(result.actionClass, 'git-force', `must not classify as git-force: ${command}`);
  }
});

test('shared risk policy still catches a quoted git-push subcommand (regression found by fresh Verifier in the D4 tightening itself)', () => {
  // The D4 tightening (above) required "push" to immediately follow "git"
  // plus recognized option tokens -- but did not anticipate a model or
  // injected instruction simply quoting the subcommand (`git "push"`,
  // `git 'push'`), which a real shell still dispatches to git's push
  // subcommand identically. Fixed by tolerating optional matching quotes
  // around "push" in the pattern itself.
  const dataRoot = tempDataRoot();
  const mustMatch = [
    ['git "push" origin main', 'git-push'],
    ["git 'push' origin main", 'git-push'],
    ['git -C . "push" origin', 'git-push'],
  ];
  for (const [command, expectedClass] of mustMatch) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected ${expectedClass} for: ${command}`);
  }
});

test('shared risk policy still catches "git.exe push" and a quoted config value containing a space (regression found by fresh Reviewer in the quoted-subcommand fix itself)', () => {
  // The quoted-subcommand fix above still missed two realistic, everyday
  // forms: the Windows executable suffix (`git.exe push ...`, since `\bgit\b`
  // requires a word boundary right after "git" and ".exe" does not provide
  // one before "push" reaching it), and a quoted option VALUE containing a
  // space (`git -c user.name="A B" push ...` -- the option-token loop's
  // value alternation could not match a token that is partly unquoted and
  // partly quoted, e.g. `user.name="A B"`). Fixed by allowing an optional
  // `.exe`/`.cmd` suffix on `git`, and by matching an option value as a
  // sequence of unquoted-or-quoted segments glued together (the same way a
  // real shell treats `user.name="A B"` as one word after quote-removal),
  // not a single quoted-or-plain alternative.
  const dataRoot = tempDataRoot();
  const mustMatch = [
    ['git.exe push origin main', 'git-push'],
    ['git -c user.name="A B" push origin main', 'git-push'],
    ["git -c user.name='A B' push origin main", 'git-push'],
  ];
  for (const [command, expectedClass] of mustMatch) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected ${expectedClass} for: ${command}`);
  }
});

test('shared risk policy still catches a quoted absolute path to git.exe containing a space, and remains free of the nested-quantifier ReDoS that fix itself introduced (regression found by fresh Security Reviewer/Reviewer)', () => {
  // Two further real bugs, both in the SAME option-value pattern above:
  // (1) a quoted absolute path like `"C:/Program Files/Git/bin/git.exe" push`
  // still evaded the pattern, because the closing quote character sat
  // between the git/.exe boundary and the required following whitespace.
  // Fixed by allowing an optional matching quote right after that boundary.
  // (2) the option-value alternation `(?:[^\s"']+|"[^"]*"|'[^']*')+` nested
  // a quantified alternative inside an already-repeating group -- the
  // textbook exponential-backtracking shape -- reproduced taking ~1.9s for
  // a 46-byte adversarial payload with no closing quote and no "push"
  // token (forcing the engine to try every partition before failing).
  // Fixed by removing the redundant inner `+` (a single, non-quantified
  // character inside the repeating group matches the same shell words
  // without the ambiguity).
  const dataRoot = tempDataRoot();
  const mustMatch = [
    ['"C:/Program Files/Git/bin/git.exe" push origin main', 'git-push'],
    ["'C:/Program Files/Git/bin/git.exe' push origin main", 'git-push'],
  ];
  for (const [command, expectedClass] of mustMatch) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, expectedClass, `expected ${expectedClass} for: ${command}`);
  }

  // The adversarial ReDoS payload itself must classify quickly (well under
  // a second), not merely "eventually" -- this is a direct regression test
  // for the exponential-backtracking bug, not just a correctness check.
  const adversarial = `git -a="${'a'.repeat(40)} ; echo done`;
  const start = Date.now();
  const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command: adversarial }, cwd: process.cwd(), dataRoot });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `classification of the adversarial payload took ${elapsedMs}ms, expected under 1000ms (ReDoS regression)`);
  assert.equal(result.action, 'pass', 'the adversarial payload does not itself contain a real push and must classify as pass, quickly');
});

test('shared risk policy classifies a git force-push as git-force, not the more general git-push', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'git push --force origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-force');
});

test('shared risk policy passes npm test', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
  assert.equal(result.category, 'pass');
});

test('shared risk policy denies a protected secret path for Write', () => {
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: '.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
  assert.equal(typeof result.reason, 'string');
});

test('shared risk policy denies wildcard/glob forms of sensitive-path access (Foundation final-closure D2)', () => {
  // A third independent review found the sensitivePaths patterns were
  // literal-path-anchored: `cat .env` was denied, but `cat .env*` or
  // `Grep(glob: '.env*')` -- shell/tool wildcards that expand to the exact
  // same secret file at execution time -- evaded the pattern entirely,
  // because the boundary alternation right after ".env" (end-of-string, a
  // literal ".", or a path separator) never included a literal "*".
  const dataRoot = tempDataRoot();
  const denied = [
    ['Bash', { command: 'cat .env*' }],
    ['Bash', { command: 'cat .env.*' }],
    ['Bash', { command: 'cat id_rsa*' }],
    ['Grep', { pattern: '.', glob: '**/.env', output_mode: 'content' }],
    ['Grep', { pattern: '.', glob: '.env*', output_mode: 'content' }],
    ['Glob', { pattern: '**/.env*' }],
  ];
  for (const [toolName, toolInput] of denied) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for ${toolName}(${JSON.stringify(toolInput)})`);
    assert.equal(result.category, 'sensitive-path');
  }
});

test('shared risk policy passes shareable dotenv templates (.env.example/.sample/.template/.dist/.defaults) but still denies the real thing (Foundation final-closure D3)', () => {
  // `.env.example`-style files are conventional, public, non-secret
  // templates committed to version control on purpose -- the sensitivePaths
  // `.env` pattern's own boundary (matching ANY `.env.<anything>`) treated
  // reading one identically to reading a real secret .env, an availability
  // regression this checkpoint fixes narrowly (only these exact, well-known
  // template suffixes are exempted).
  const dataRoot = tempDataRoot();
  const safeTemplates = [
    ['Read', { file_path: '.env.example' }],
    ['Read', { file_path: '.env.sample' }],
    ['Read', { file_path: 'config/.env.template' }],
    ['Read', { file_path: '.env.dist' }],
    ['Read', { file_path: '.env.defaults' }],
    ['Bash', { command: 'cat .env.example' }],
    ['Write', { file_path: '.env.example', content: 'PORT=3000' }],
  ];
  for (const [toolName, toolInput] of safeTemplates) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass for ${toolName}(${JSON.stringify(toolInput)})`);
  }

  const stillDenied = [
    ['Read', { file_path: '.env' }],
    ['Read', { file_path: '.env.local' }],
    ['Bash', { command: 'cat .env' }],
    // Not a real template suffix -- must not accidentally widen the exception.
    ['Read', { file_path: '.env.example.secret' }],
    // Security review found the original exception's trailing boundary
    // matched anywhere in the string (not only at the end), so path
    // traversal riding on a legitimate-looking template prefix reached a
    // REAL secret and returned its content -- reproduced end to end on
    // Windows. The template name must be the final path component.
    ['Read', { file_path: '.env.example/../.env' }],
    ['Read', { file_path: 'config/.env.example/real-secret' }],
  ];
  for (const [toolName, toolInput] of stillDenied) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for ${toolName}(${JSON.stringify(toolInput)})`);
  }
});

test('shared risk policy denies a protected secret path for Read, Glob, and Grep (not just Bash/Write)', () => {
  // Independent security review found that Read/Glob/Grep were entirely
  // absent from the risk-gate matcher and from classifyRiskAction()'s
  // tool-name branches: a model denied on `cat .env` via Bash could simply
  // switch to Read(".env") and read the identical content ungated.
  const readDeny = classifyRiskAction({
    toolName: 'Read',
    toolInput: { file_path: '.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(readDeny.action, 'deny');
  assert.equal(readDeny.category, 'sensitive-path');

  // Grep's real schema carries `path` and, separately, `glob` -- a second
  // independent review round found the first fix checked only `path`,
  // leaving `glob` (which Grep(pattern, glob, output_mode: 'content') can
  // use to return an arbitrary file's *content*) completely unchecked.
  const grepByPath = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { path: '.env', pattern: 'SECRET' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(grepByPath.action, 'deny');
  assert.equal(grepByPath.category, 'sensitive-path');

  const grepByGlob = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { pattern: '.', glob: '**/.env', output_mode: 'content' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(grepByGlob.action, 'deny', 'Grep(glob: **/.env) must be denied, not just Grep(path: .env)');
  assert.equal(grepByGlob.category, 'sensitive-path');

  // Glob has no `file_path` field at all -- its real path-shaped field is
  // `pattern` itself (the second bypass reproduced by the same review).
  const globByPattern = classifyRiskAction({
    toolName: 'Glob',
    toolInput: { pattern: '**/.env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(globByPattern.action, 'deny', 'Glob(pattern: **/.env) must be denied');
  assert.equal(globByPattern.category, 'sensitive-path');
});

test('shared risk policy passes a benign Read/Glob/Grep target', () => {
  const benignRead = classifyRiskAction({
    toolName: 'Read',
    toolInput: { file_path: 'src/app.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignRead.action, 'pass');

  // A Grep search PATTERN (the content regex, not a path) must never be
  // matched against sensitive-path patterns -- only `path`/`glob` are
  // path-shaped for Grep. Searching *for* the text ".env" across ordinary
  // source files is not the same as reading a secret file.
  const benignGrep = classifyRiskAction({
    toolName: 'Grep',
    toolInput: { pattern: '.env', glob: '**/*.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignGrep.action, 'pass', 'Grep pattern text must not itself be treated as a path');

  const benignGlob = classifyRiskAction({
    toolName: 'Glob',
    toolInput: { pattern: '**/*.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(benignGlob.action, 'pass');
});

test('shared risk policy denies a Bash command that reads a protected secret path', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'cat .env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
  // Prompt-injection / leak safety: the reason never echoes the command.
  assert.ok(!result.reason.includes('cat .env'));
});

test('shared risk policy denies a QUOTED sensitive-path reference (regression found by fresh Reviewer: quotes bypassed secret-path protection entirely)', () => {
  // The Bash token splitter never stripped surrounding quotes, so
  // `cat ".env"` or `cat '.env'` (ordinary, everyday shell quoting) produced
  // the token `".env"` -- which never matched the sensitivePaths patterns'
  // own path-boundary anchors (a literal `.env` is expected at the start,
  // not a quote character) -- bypassing secret-path protection entirely.
  // The same fix also applies to a literally-quoted `file_path`/`path`/
  // `glob` value on Write/Edit/Read/Glob/Grep.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    ['Bash', { command: 'cat ".env"' }],
    ['Bash', { command: "cat '.env'" }],
    ['Bash', { command: 'cat ".ssh/id_rsa"' }],
    ['Read', { file_path: '".env"' }],
    ['Write', { file_path: '".env"', content: 'x' }],
  ];
  for (const [toolName, toolInput] of mustDeny) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for ${toolName}(${JSON.stringify(toolInput)})`);
    assert.equal(result.category, 'sensitive-path');
  }
});

test('shared risk policy denies a quoted sensitive path containing an internal space, and an NTFS alternate-data-stream reference (two further regressions found by a fresh Security Reviewer/Reviewer in the quote-stripping fix itself)', () => {
  // (1) Splitting on whitespace BEFORE stripping quotes (the original
  // approach) tears a quoted path with an internal space in two
  // (`cat "my dir/.env"` -> tokens `"my` and `dir/.env"`), so neither half
  // still looks like a quoted token and nothing gets stripped. Fixed by
  // extracting whole shell words (ordinary characters and/or fully-quoted
  // segments glued together) before stripping quotes.
  // (2) matchesSensitivePath() never stripped a trailing NTFS
  // alternate-data-stream suffix (`::$DATA`, a distinct stream of the SAME
  // file on Windows) the way touchesClaudeSettings() already does, so
  // `.env::$DATA` read straight through to real secret content while
  // classifying as `pass`.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    ['Bash', { command: 'cat "my dir/.env"' }],
    ['Bash', { command: "cat 'my dir/.env'" }],
    ['Bash', { command: 'cat .env::$DATA' }],
    ['Bash', { command: 'cat ".env::$DATA"' }],
    ['Read', { file_path: '.env::$DATA' }],
    ['Write', { file_path: '.env::$DATA', content: 'x' }],
  ];
  for (const [toolName, toolInput] of mustDeny) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for ${toolName}(${JSON.stringify(toolInput)})`);
    assert.equal(result.category, 'sensitive-path');
  }

  // A benign quoted path with an internal space must still pass.
  const benign = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'cat "my dir/notes.txt"' }, cwd: process.cwd(), dataRoot });
  assert.equal(benign.action, 'pass');
});

test('shared risk policy denies quote-concatenated sensitive paths and a trailing-space/dot Windows path quirk (two further regressions found by a fresh Security Reviewer in the SAME quote-stripping fix)', () => {
  // (1) Stripping only ONE outer matching pair of quotes (the round-4 fix)
  // still left an interior/adjacent quote character in the token for
  // `.env""` or `""".env` -- ordinary, valid shell quote-concatenation
  // that a real shell still resolves to the literal file `.env` -- which
  // broke the path-boundary anchors just the same. Fixed by removing every
  // quote character from the token, not merely a single surrounding pair.
  // (2) Confirmed against a real PowerShell process that Windows silently
  // ignores a trailing space or dot on a path component (`Get-Content
  // '.env '` reads the real `.env`), so appending either bypassed the
  // pattern's own end-of-string anchor. Fixed by stripping trailing
  // spaces/dots inside matchesSensitivePath(), the same way the NTFS ADS
  // suffix already is.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    ['Bash', { command: 'cat .env""' }],
    ['Bash', { command: 'cat "".env' }],
    ['Bash', { command: "cat '.env '" }],
    ['Bash', { command: 'cat .env.' }],
    ['Read', { file_path: '.env ' }],
  ];
  for (const [toolName, toolInput] of mustDeny) {
    const result = classifyRiskAction({ toolName, toolInput, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for ${toolName}(${JSON.stringify(toolInput)})`);
    assert.equal(result.category, 'sensitive-path');
  }

  // The .env.example template exception must still work after trailing-dot
  // trimming (trimming ".env.example" itself must not strip its own "e").
  const template = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: '.env.example' }, cwd: process.cwd(), dataRoot });
  assert.equal(template.action, 'pass');
});

test('shared risk policy: the trailing-space/dot trim does not deny ordinary free text ending in a real extension, and ANSI-C/locale Bash quoting no longer bypasses secret-path detection (two further findings from a sixth, final independent review)', () => {
  // (1) Applying the trailing space/dot trim unconditionally exposed
  // ordinary prose ending in a real file extension to the extension-only
  // sensitivePaths patterns (.pem/.key/...), which -- unlike the .env/
  // id_rsa patterns -- are not anchored to a path-start boundary.
  // `git commit -m "regenerate cert.pem."` denied outright even though it
  // never referenced an actual path. Fixed by only applying the trim when
  // the final path component, once trimmed, has no remaining internal
  // space -- true for a genuine bare/real path reference, false for a
  // free-text sentence.
  const dataRoot = tempDataRoot();
  const benignFreeText = [
    'git commit -m "regenerate cert.pem."',
    'echo "done with config.key."',
  ];
  for (const command of benignFreeText) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass for benign free text: ${command}`);
  }

  // A real path with a space in an EARLIER segment (not the filename
  // itself) and a genuine trailing dot must still be denied.
  const realPathWithEarlierSpace = classifyRiskAction({
    toolName: 'Bash', toolInput: { command: 'cat "my dir/.env."' }, cwd: process.cwd(), dataRoot,
  });
  assert.equal(realPathWithEarlierSpace.action, 'deny');
  assert.equal(realPathWithEarlierSpace.category, 'sensitive-path');

  // (2) Bash ANSI-C ($'...') and locale ($"...") quoting -- confirmed
  // against a real Bash process to read the literal file .env -- still
  // bypassed detection because the tokenizer glued the leading `$` into
  // the token as ordinary text. Fixed by stripping a `$` immediately
  // before a quote character along with the quote itself.
  const ansiCQuoted = [
    "cat $'.env'",
    'cat $".env"',
  ];
  for (const command of ansiCQuoted) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for: ${command}`);
    assert.equal(result.category, 'sensitive-path');
  }

  // An unrelated, legitimate use of `$` immediately before a path-like
  // string (not ANSI-C quoting) must not be affected.
  const unrelatedDollar = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'echo $5.env' }, cwd: process.cwd(), dataRoot });
  assert.equal(unrelatedDollar.action, 'pass');
});

test('shared risk policy denies direct writes into the KRYLO data root', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: path.join(dataRoot, 'runs', 'x', 'state.json') },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via ~/.krylo/data (tilde shorthand)', () => {
  // ADDITIONAL HARDENING (security-hardening checkpoint): the new
  // multi-host design introduces ~/.krylo/data as the future shared data
  // root. A model could reference it in a Bash command using the tilde
  // shorthand, or $HOME/%USERPROFILE% env-var expansion, rather than the
  // literal resolved absolute path -- the shell still expands it to the
  // same location, so the protection must not be bypassable just because
  // the command text spells the path conventionally instead of literally.
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'rm -rf ~/.krylo/data/runs' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via $HOME (POSIX env var)', () => {
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'cat $HOME/.krylo/data/runs/x/state.json' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Bash command referencing the data root via %USERPROFILE% (Windows env var)', () => {
  const dataRoot = path.join(os.homedir(), '.krylo', 'data');
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'type %USERPROFILE%\\.krylo\\data\\runs\\x\\state.json' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies a Write reaching the data root through a symlinked directory (escape via symlink)', () => {
  // ADDITIONAL HARDENING (security-hardening checkpoint): path.resolve()
  // alone does not follow symlinks, so a symlink OUTSIDE the data root that
  // points INTO it would previously escape detection -- the nominal
  // (unresolved) path never starts with the data root's own literal path,
  // even though writing through the symlink lands inside it for real.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-symlink-test-'));
  try {
    const dataRoot = path.join(base, 'real-data-root');
    fs.mkdirSync(dataRoot, { recursive: true });
    const outsideDir = path.join(base, 'looks-harmless');
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkPath = path.join(outsideDir, 'link-to-data-root');
    try {
      fs.symlinkSync(dataRoot, linkPath, 'junction');
    } catch {
      // Symlink/junction creation can require elevated privileges in some
      // environments; skip rather than fail the suite on an unrelated
      // permissions gap.
      return;
    }

    const result = classifyRiskAction({
      toolName: 'Write',
      toolInput: { file_path: path.join(linkPath, 'runs', 'x', 'state.json') },
      cwd: outsideDir,
      dataRoot,
    });
    assert.equal(result.action, 'deny');
    assert.equal(result.category, 'data-root-protection');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('shared risk policy denies a Bash or PowerShell command directly invoking a KRYLO Hook entrypoint', () => {
  // A model must not be able to forge PostToolUse/SubagentStart/Stop/
  // PreToolUse payloads to manipulate telemetry, agent records, Orbit
  // bookkeeping, or risk classification by running a Hook entrypoint script
  // directly via its own Bash or PowerShell tool instead of the host's own
  // Hook dispatch actually invoking it.
  const dataRoot = tempDataRoot();
  for (const filename of ['question-gate.mjs', 'risk-gate.mjs', 'posttool-telemetry.mjs', 'fingerprint.mjs', 'agent-events.mjs', 'stop-gate.mjs']) {
    for (const toolName of ['Bash', 'PowerShell']) {
      const result = classifyRiskAction({
        toolName,
        toolInput: { command: `node plugins/krylo/scripts/security/${filename}` },
        cwd: process.cwd(),
        dataRoot,
      });
      assert.equal(result.action, 'deny', `expected direct invocation of ${filename} via ${toolName} to be denied`);
      assert.equal(result.category, 'hook-entrypoint-protection');
    }
  }
});

test('shared risk policy denies the model writing/editing Claude Code\'s own settings.json or settings.local.json (security-config-weakening protection, Foundation final closure)', () => {
  // A model must not be able to silently weaken KRYLO/Claude enforcement --
  // add a permissions.allow rule, remove the PreToolUse hook registration,
  // or set defaultMode to bypassPermissions -- by writing to Claude Code's
  // own settings files with its ordinary Write/Edit/Bash/PowerShell tools.
  const dataRoot = tempDataRoot();
  const targets = ['.claude/settings.json', '.claude/settings.local.json'];
  for (const target of targets) {
    const writeResult = classifyRiskAction({ toolName: 'Write', toolInput: { file_path: target, content: '{}' }, cwd: process.cwd(), dataRoot });
    assert.equal(writeResult.action, 'deny', `expected deny for Write(${target})`);
    assert.equal(writeResult.category, 'security-config-protection');

    const editResult = classifyRiskAction({ toolName: 'Edit', toolInput: { file_path: target, old_string: 'a', new_string: 'b' }, cwd: process.cwd(), dataRoot });
    assert.equal(editResult.action, 'deny', `expected deny for Edit(${target})`);

    for (const toolName of ['Bash', 'PowerShell']) {
      const bashResult = classifyRiskAction({
        toolName,
        toolInput: { command: `echo hello >> ${target}` },
        cwd: process.cwd(),
        dataRoot,
      });
      assert.equal(bashResult.action, 'deny', `expected deny for ${toolName} referencing ${target}`);
      assert.equal(bashResult.category, 'security-config-protection');
    }
  }

  // A user-level settings file (absolute/home-relative path) must be caught too.
  const userLevel = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: '~/.claude/settings.json', content: '{}' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(userLevel.action, 'deny', 'expected deny for a user-level settings.json target');
});

test('shared risk policy does not deny reading Claude settings, or writing an unrelated file that merely contains "settings.json" as a substring', () => {
  const dataRoot = tempDataRoot();
  const readResult = classifyRiskAction({ toolName: 'Read', toolInput: { file_path: '.claude/settings.json' }, cwd: process.cwd(), dataRoot });
  assert.notEqual(readResult.action, 'deny', 'reading settings.json is not itself the threat; only writing it is');

  const lookalike = classifyRiskAction({ toolName: 'Write', toolInput: { file_path: 'docs/my-settings.json.bak', content: 'x' }, cwd: process.cwd(), dataRoot });
  assert.equal(lookalike.action, 'pass', 'a file merely named similarly must not be swept in by a bare substring match');
});

test('shared risk policy: settings.json protection resolves the path before comparing, so a redundant "." segment, a double separator, ".." traversal, or an NTFS alternate-data-stream suffix cannot bypass it (regression found by fresh Security Reviewer, real file overwrite reproduced)', () => {
  // The first version of touchesClaudeSettings() matched the RAW target
  // string (lowercased, backslash-to-slash only) -- never resolved through
  // path.resolve() the way touchesDataRoot()/touchesPluginInstallation()
  // already do. Independent review reproduced, end to end, that
  // `.claude/./settings.json`, `.claude//settings.json`,
  // `.claude/x/../settings.json`, and `.claude/settings.json::$DATA` (an
  // NTFS alternate-data-stream suffix -- a distinct stream of the SAME
  // file on Windows) all classified as `pass` and genuinely overwrote the
  // real settings.json on disk. Fixed by resolving the target (after
  // stripping any `::<stream>` suffix and expanding a leading `~`) before
  // comparing its basename and parent directory name.
  const dataRoot = tempDataRoot();
  const mustDeny = [
    '.claude/./settings.json',
    '.claude//settings.json',
    '.claude/x/../settings.json',
    '.claude/settings.json::$DATA',
  ];
  for (const target of mustDeny) {
    const result = classifyRiskAction({ toolName: 'Write', toolInput: { file_path: target, content: '{}' }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for Write(${target})`);
    assert.equal(result.category, 'security-config-protection');
  }
});

test('shared risk policy catches a directory symlink/junction whose name is not literally ".claude", for both settings-protection and plugin-installation-protection (regression found by a fresh Security Reviewer: neither function resolved symlinks, unlike touchesDataRoot())', () => {
  // A prior review round's comment inaccurately claimed the same
  // resolve-then-compare "shape" as touchesDataRoot() -- but touchesDataRoot()
  // additionally resolves through any symlink/junction via
  // realpathBestEffort(), which neither touchesClaudeSettings() nor
  // touchesPluginInstallation() actually did. A directory symlink/junction
  // named something other than ".claude" (or outside the literal
  // pluginRoot string) passed the raw-path check while still landing on
  // the real protected file once the OS resolved it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'krylo-settings-symlink-test-'));
  try {
    const dataRoot = tempDataRoot();
    const realClaudeDir = path.join(base, '.claude');
    fs.mkdirSync(realClaudeDir, { recursive: true });
    const outsideDir = path.join(base, 'workdir');
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkPath = path.join(outsideDir, 'cfg');
    try {
      fs.symlinkSync(realClaudeDir, linkPath, 'junction');
    } catch {
      return; // symlink/junction creation can require elevated privileges
    }

    const settingsResult = classifyRiskAction({
      toolName: 'Write',
      toolInput: { file_path: path.join(linkPath, 'settings.json'), content: '{}' },
      cwd: outsideDir,
      dataRoot,
    });
    assert.equal(settingsResult.action, 'deny', 'a write through a symlinked ".claude" directory must still be denied');
    assert.equal(settingsResult.category, 'security-config-protection');

    const realPluginRoot = path.join(base, 'installed-plugin-root');
    fs.mkdirSync(path.join(realPluginRoot, 'policies'), { recursive: true });
    const pluginLinkPath = path.join(outsideDir, 'plugin-cfg');
    try {
      fs.symlinkSync(realPluginRoot, pluginLinkPath, 'junction');
    } catch {
      return;
    }
    const pluginResult = classifyRiskAction({
      toolName: 'Write',
      toolInput: { file_path: path.join(pluginLinkPath, 'policies', 'production-policy.json'), content: '{}' },
      cwd: outsideDir,
      dataRoot,
      pluginRoot: realPluginRoot,
    });
    assert.equal(pluginResult.action, 'deny', 'a write through a symlinked plugin-root directory must still be denied');
    assert.equal(pluginResult.category, 'plugin-installation-protection');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('shared risk policy denies the model writing/editing the KRYLO plugin\'s own INSTALLED files (hooks, policy) when pluginRoot is known, without blocking KRYLO-on-itself source development', () => {
  // A model must not be able to disable a KRYLO hook or weaken its policy
  // by editing the plugin's own installed source. Scoped to `pluginRoot`
  // (the actual installed location, e.g. CLAUDE_PLUGIN_ROOT) so this never
  // collides with KRYLO's own SOURCE repository -- a completely different
  // path in ordinary development -- confirmed by the negative case below.
  const dataRoot = tempDataRoot();
  // A separate root, sibling to (not nested under) dataRoot -- in real usage
  // pluginRoot and dataRoot are always distinct installed locations; nesting
  // them here would also trip data-root-protection first and not exercise
  // this check at all.
  const fakePluginRoot = path.join(os.tmpdir(), 'krylo-risk-policy-test-fake-plugin-root');
  const targets = [
    path.join(fakePluginRoot, 'scripts', 'security', 'risk-gate.mjs'),
    path.join(fakePluginRoot, 'policies', 'production-policy.json'),
    path.join(fakePluginRoot, 'skills', 'run', 'SKILL.md'),
  ];
  for (const target of targets) {
    const result = classifyRiskAction({
      toolName: 'Edit', toolInput: { file_path: target, old_string: 'a', new_string: 'b' }, cwd: process.cwd(), dataRoot, pluginRoot: fakePluginRoot,
    });
    assert.equal(result.action, 'deny', `expected deny for editing installed plugin file: ${target}`);
    assert.equal(result.category, 'plugin-installation-protection');
  }

  // Bash/PowerShell command TEXT is deliberately NOT scanned for this check
  // at all (unlike Write/Edit/NotebookEdit above) -- this went through TWO
  // more independent review rounds after the original design:
  // (a) a first version scanned for ANY pluginRoot reference, which also
  // matched `skills/run/SKILL.md`'s own MANDATORY runtime CLI calls
  // (`node "<pluginRoot>/scripts/runtime/<script>.mjs"`), breaking KRYLO's
  // own operation with no approval path (Critical regression);
  // (b) narrowing to "references pluginRoot AND matches a write-shaped
  // signal list" (redirection/sed -i/tee/cp/mv/Set-Content/...) was then
  // found to be WORSE than no check at all: it still denied legitimate
  // calls (bare `>`/`cp`/`mv` appear as free text inside ordinary evidence
  // strings and JSON payloads a real runtime CLI call routinely carries --
  // Critical false positive), while missing nearly every actual write
  // primitive (`node -e "...writeFileSync..."`, `perl -pi -e`,
  // `python -c "open(...,'w')"`, `dd`, `truncate`, `rsync`, `curl -o`,
  // PowerShell `[System.IO.File]::WriteAllText`, etc. all still passed).
  // A regex over untokenized shell text cannot answer "is this a write to
  // file X" for an interpreter-agnostic, unbounded set of write
  // primitives -- removed rather than continuing to patch a control that
  // was negative-value. See docs/adr/0028-foundation-final-closure.md's
  // residual-limitations list for the disclosed gap this leaves.
  const bashReference = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: `echo x >> ${path.join(fakePluginRoot, 'policies', 'production-policy.json')}` },
    cwd: process.cwd(),
    dataRoot,
    pluginRoot: fakePluginRoot,
  });
  assert.notEqual(bashReference.action, 'deny', 'a Bash command merely referencing pluginRoot must NOT be denied by this check -- text-matching for "is this a write" was tried and found worse than no check (Critical false positives, ~19% real coverage)');

  const bashRead = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: `cat ${path.join(fakePluginRoot, 'policies', 'production-policy.json')}` },
    cwd: process.cwd(),
    dataRoot,
    pluginRoot: fakePluginRoot,
  });
  assert.notEqual(bashRead.action, 'deny', 'a read-only Bash command merely referencing pluginRoot must NOT be denied');

  // The realistic mandatory call this fix protects: a real runtime CLI
  // invocation using the plugin's own root, exactly as SKILL.md issues it,
  // must never be denied by this check -- it references pluginRoot but is
  // not write-shaped.
  const legitimateRuntimeCall = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: `node "${path.join(fakePluginRoot, 'scripts', 'runtime', 'update-state.mjs')}" --session s --record-progress` },
    cwd: process.cwd(),
    dataRoot,
    pluginRoot: fakePluginRoot,
  });
  assert.notEqual(legitimateRuntimeCall.action, 'deny', 'KRYLO\'s own mandatory runtime CLI call must never be denied by plugin-installation protection');

  // Negative case: editing the SAME filename outside pluginRoot (e.g. KRYLO's
  // own source repository during development) must be unaffected.
  const sourceRepoPath = path.join(os.tmpdir(), 'krylo-risk-policy-test-source-repo', 'plugins', 'krylo', 'scripts', 'security', 'risk-gate.mjs');
  const sourceEdit = classifyRiskAction({
    toolName: 'Edit', toolInput: { file_path: sourceRepoPath, old_string: 'a', new_string: 'b' }, cwd: process.cwd(), dataRoot, pluginRoot: fakePluginRoot,
  });
  assert.notEqual(sourceEdit.action, 'deny', 'editing the source repo (a different path from the installed pluginRoot) must not be blocked');

  // No pluginRoot known: the check must not throw or false-positive.
  const noPluginRoot = classifyRiskAction({
    toolName: 'Edit', toolInput: { file_path: targets[0], old_string: 'a', new_string: 'b' }, cwd: process.cwd(), dataRoot,
  });
  assert.notEqual(noPluginRoot.action, 'deny', 'without a known pluginRoot, this check must not fire');
});

test('shared risk policy still allows the legitimate runtime CLIs the model is meant to call directly', () => {
  const dataRoot = tempDataRoot();
  for (const command of [
    'node plugins/krylo/scripts/runtime/init-run.mjs --goal "x" --session s --lane PATCH --risk low',
    'node plugins/krylo/scripts/runtime/read-state.mjs --session s',
    'node plugins/krylo/scripts/runtime/update-state.mjs --session s --add-criterion "x"',
  ]) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.notEqual(result.category, 'hook-entrypoint-protection', `legitimate CLI call must not be denied as a hook-entrypoint invocation: ${command}`);
  }
});

test('shared risk policy denies an oversized Bash command outright, bounding classification latency (ReDoS-style DoS finding)', () => {
  // HIGH FINDING (independent security review, security-hardening
  // checkpoint): production-policy.json's multi-segment lazy-quantifier
  // patterns scale superlinearly against the full command text -- the
  // reviewer measured ~25 seconds at the 1MB stdin ceiling readStdinJson()
  // otherwise allows, close enough to a real PreToolUse Hook timeout to be
  // a genuine availability risk. A model could pad an actually-dangerous
  // command with ~1MB of adversarial filler as a shell comment and stall
  // the gate itself. Fixed: an oversized Bash command is denied outright,
  // before any pattern matching runs, rather than truncated (which could
  // hide a real dangerous command appearing after the cut point).
  const dataRoot = tempDataRoot();

  const oversized = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: `git push --force origin main  # ${'x'.repeat(20_000)}` },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(oversized.action, 'deny');
  assert.equal(oversized.category, 'oversized-command');

  // A normal-sized command is completely unaffected.
  const normal = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(normal.action, 'pass');

  // Classification of an adversarial-but-under-the-cap command stays fast
  // (bounds the fix, not just the denial path): the reviewer's own
  // benchmark showed ~4ms at 10,000 bytes against the real policy file.
  const nearCapCommand = `az deploymentx functionappy ${'az deploymentx functionappy '.repeat(300)}`.slice(0, 9_900);
  const start = process.hrtime.bigint();
  classifyRiskAction({ toolName: 'Bash', toolInput: { command: nearCapCommand }, cwd: process.cwd(), dataRoot });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert.ok(elapsedMs < 500, `classification of a near-cap adversarial command took ${elapsedMs}ms, expected well under 500ms`);
});

test('shared risk policy denies a Bash command naming the wrapper config in the data root', () => {
  const dataRoot = tempDataRoot();
  const command = `echo '{"originalCommand":["evil"]}' > ${dataRoot.replace(/\\/g, '/')}/wrapper-config.json`;
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy passes a benign file write', () => {
  const result = classifyRiskAction({
    toolName: 'Write',
    toolInput: { file_path: 'src/app.js' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
});

test('shared risk policy invariant: Write/Edit/NotebookEdit/Read/Glob/Grep and an unrecognized tool name can NEVER produce require-approval', () => {
  // risk-gate.mjs's native-ask eligibility (ADR-0027) relies on this
  // invariant to know Bash/PowerShell/MCP are the only tool surfaces that
  // ever need to reach the ask/deny branch at all -- independent review
  // found this invariant lived only in a code comment. Locking it here
  // means a future change that adds a require-approval path for one of
  // these tools surfaces as a failing test, not a silent gap in
  // risk-gate.mjs's NATIVE_ASK_ELIGIBLE_TOOLS set.
  const dataRoot = tempDataRoot();
  const cwd = process.cwd();
  const cases = [
    ['Write', { file_path: 'src/app.js' }],
    ['Write', { file_path: '.env' }], // even the sensitive-path deny case
    ['Edit', { file_path: 'src/app.js' }],
    ['NotebookEdit', { notebook_path: 'nb.ipynb' }],
    ['Read', { file_path: 'src/app.js' }],
    ['Read', { file_path: '.env' }],
    ['Glob', { pattern: '**/*.js' }],
    ['Grep', { pattern: 'TODO', glob: '**/*.js' }],
    ['SomeFutureToolKrylODoesNotYetClassify', { anything: 'x' }],
  ];
  for (const [toolName, toolInput] of cases) {
    const result = classifyRiskAction({ toolName, toolInput, cwd, dataRoot });
    assert.notEqual(result.action, 'require-approval', `${toolName} must never produce require-approval`);
  }
});

test('shared risk policy hard-denies an unknown MCP server (not merely require-approval)', () => {
  // Restore-native-approval checkpoint: `deny` and `require-approval` are
  // distinct KRYLO policy outcomes. An entirely unrecognized MCP server has
  // no identity a human could meaningfully approve, so it must stay a hard
  // `deny` even now that known MCP write classes route through native ask
  // -- otherwise widening `ask` to MCP tools would silently downgrade
  // "we have never reviewed this server at all" to a single-click prompt.
  const result = classifyRiskAction({
    toolName: 'mcp__some_random_service__update_thing',
    toolInput: {},
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
});

test('shared risk policy passes a known read-only-shaped MCP operation', () => {
  const result = classifyRiskAction({
    toolName: 'mcp__context7__query-docs',
    toolInput: { q: 'hello' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
  assert.equal(result.category, 'mcp-pass');
});

test('shared risk policy gates a known write-shaped MCP operation pending approval', () => {
  const result = classifyRiskAction({
    toolName: 'mcp__github__merge_pull_request',
    toolInput: { pr: 42 },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'merge');
});

test('shared risk policy falls back to the real data root when dataRoot is omitted', () => {
  const prev = process.env.KRYLO_DATA_ROOT;
  process.env.KRYLO_DATA_ROOT = tempDataRoot();
  try {
    const result = classifyRiskAction({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      cwd: process.cwd(),
    });
    assert.equal(result.action, 'pass');
  } finally {
    if (prev === undefined) delete process.env.KRYLO_DATA_ROOT;
    else process.env.KRYLO_DATA_ROOT = prev;
  }
});

test('shared risk policy contains zero Claude-specific fields in its decisions', () => {
  const result = classifyRiskAction({
    toolName: 'Bash',
    toolInput: { command: 'gh secret set DEPLOY_KEY' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal('hookSpecificOutput' in result, false);
  assert.equal('permissionDecision' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['action', 'actionClass', 'category', 'reason'].sort());
});

// --- PowerShell coverage (Windows): a risky action must not bypass KRYLO
// merely because Claude invokes the PowerShell tool instead of Bash. Official
// Claude Code Hook documentation confirms PowerShell is a distinct tool name
// from Bash, with the same tool_input.command shape (docs/adr/0022's version
// floor update; code.claude.com/docs/en/hooks). ---

test('shared risk policy classifies a git push via the PowerShell tool exactly like Bash', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'git push origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-push');
});

test('shared risk policy classifies a force push via the PowerShell tool as git-force', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'git push --force origin main' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'git-force');
});

test('shared risk policy classifies a native PowerShell destructive delete (Remove-Item -Recurse -Force) as destructive-operation (require-approval)', () => {
  // A Bash-flavored `rm -rf` pattern alone would miss the syntax a genuine
  // PowerShell user or a PowerShell-invoking model actually writes.
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'Remove-Item -Recurse -Force C:\\Users\\dev\\important' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'require-approval');
  assert.equal(result.actionClass, 'destructive-operation');
});

test('shared risk policy catches PowerShell parameter abbreviations and built-in aliases for the same destructive delete', () => {
  // Independent security review found the prior pattern required the FULL
  // "remove-item"/"-recurse"/"-force" spelling, which PowerShell's own
  // parameter-prefix matching and built-in command aliases trivially evade
  // (verified empirically: -Rec/-Fo/-R/-F abbreviations and the ri/rd/rmdir/
  // del/erase aliases all previously classified as a silent 'pass'). `rm`
  // is deliberately EXCLUDED from this alias list: a follow-up review found
  // that including it turned ordinary Bash hygiene commands (`rm -rf
  // node_modules`, `rm -f package-lock.json`) into unconditional denies
  // with no in-run unlock (destructive-operation is not in the native-ask
  // allowlist). The pre-existing, separately-anchored Bash `rm` pattern
  // (root/home/drive-letter targets only) is unaffected and still covers
  // genuinely dangerous `rm` usage; see the benign-command test below for
  // the negative case this trade-off requires.
  const dataRoot = tempDataRoot();
  const commands = [
    'Remove-Item -Rec -Fo C:\\important',
    'Remove-Item -R -F C:\\important',
    'ri -Recurse -Force C:\\important',
    'rd /s /q C:\\important',
    'rmdir -Recurse -Force C:\\important',
    'del /f /s /q C:\\important',
    'erase -Force C:\\important',
  ];
  for (const command of commands) {
    const result = classifyRiskAction({ toolName: 'PowerShell', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, 'destructive-operation', `expected destructive-operation for: ${command}`);
  }
});

test('shared risk policy classifies a bare relative-path rm as destructive-operation (require-approval, not an accidental permanent deny) -- git-rm/docker-rm/xargs-rm hygiene stays unaffected', () => {
  // Foundation final-closure checkpoint (docs/adr/0028): the pre-existing
  // Bash `rm` pattern only matched an absolute/home-anchored target, so
  // `rm -rf node_modules`, `rm -rf ../`, `rm -rf .`, and `rm -rf *` all
  // passed through completely ungated -- a real relative-path evasion of
  // the destructive-operation class. Now that native ask (ADR-0027) covers
  // every require-approval class, including destructive-operation, fixing
  // this correctly means require-approval (a real human-approval path via
  // native ask), not an accidental unconditional deny with no unlock --
  // exactly the earlier PowerShell-alias regression this same test file
  // once guarded against, now resolved differently because the
  // consequence of gating destructive-operation changed underneath it.
  // "docker rm", "git rm", and "npm rm" are excluded (a negative lookbehind)
  // because "rm" there is a different tool's subcommand, not the actual
  // filesystem-delete shell command, and gating them would be pure noise
  // with no security value.
  const dataRoot = tempDataRoot();
  const nowGated = [
    'rm -rf node_modules',
    'rm -rf dist',
    'rm -f package-lock.json',
    'rm -rf ../',
    'rm -rf ../../',
    'rm -rf .',
    'rm -rf *',
  ];
  for (const command of nowGated) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, 'destructive-operation', `expected destructive-operation for: ${command}`);
  }

  const stillBenign = [
    'docker rm -f my-container',
    'git rm -r --cached .',
    'xargs rm -f',
    'npm rm somepackage',
  ];
  for (const command of stillBenign) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass (not blocked) for: ${command}`);
  }
});

test('shared risk policy: the git/docker/npm-rm exclusion cannot be spoofed by an unrelated preceding word or an env-var-assignment prefix (regression found by fresh Verifier + Security Reviewer in the rm fix itself)', () => {
  // The first fix's negative lookbehind (`(?<!git )(?<!docker )(?<!npm )`)
  // inspected only the four raw characters immediately before "rm" -- not
  // whether "git"/"docker"/"npm" was actually a real, separate command.
  // Two independent review rounds reproduced real bypasses: a two-line
  // script normalized to "echo git rm -rf /" (the literal word "git"
  // merely happens to precede "rm"), and a POSIX env-var-assignment prefix
  // like "x=npm rm -rf /var/data" (a real, working shell command). Both
  // evaded the exclusion and passed through completely ungated -- worse
  // than the original relative-path gap, since these examples used
  // absolute targets the PRE-fix pattern already caught. Fixed by requiring
  // "git"/"docker"/"npm" itself be at a genuine command-start position
  // (start-of-string or after a ;/&/| separator), not merely the word
  // immediately preceding "rm".
  const dataRoot = tempDataRoot();
  const mustBeGated = [
    'echo git rm -rf /',
    'echo npm rm -rf ~/important',
    'x=npm rm -rf /var/data',
    'FOO=git rm -rf /var/data',
    'TMP=/opt/npm rm -rf /var/data',
    // A fresh Reviewer round found the fix above still missed the BARER
    // form with no preceding word at all: a literal two-line script with
    // no other separator, "git\nrm -rf /", normalizes (before this
    // checkpoint's newline-to-separator fix) to the SAME text as the
    // genuine single command "git rm -rf /" -- the lookbehind could not
    // tell them apart. Fixed by normalizing a newline to an explicit `;`
    // separator before collapsing other whitespace.
    'git\nrm -rf /',
    'true; git\nrm -rf /',
    // A further review round found a BARE \r (no \n at all -- a real
    // PowerShell statement separator on its own, confirmed against a real
    // PowerShell process) fell through the \r?\n-only normalization to the
    // plain-whitespace collapse and re-opened the identical gap. Fixed by
    // normalizing \r\n, a lone \r, and a lone \n uniformly (matching \r\n
    // first so it becomes one separator, not two).
    'git\rrm -Recurse -Force C:\\Projects',
  ];
  for (const command of mustBeGated) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${command}`);
    assert.equal(result.actionClass, 'destructive-operation');
  }

  // Genuine subcommands, including after a real command separator, must
  // still pass.
  const stillBenign = [
    'git rm -r --cached .',
    'docker rm -f my-container',
    'npm rm somepackage',
    'echo hi && git rm -r --cached .',
    'echo hi; docker rm -f x',
  ];
  for (const command of stillBenign) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'pass', `expected pass for: ${command}`);
  }
});

test('shared risk policy treats a Bash "\\"-continuation or PowerShell "`"-continuation as ONE command, not a separator (Critical regression found by a fresh Reviewer in the bare-newline rm fix itself)', () => {
  // Converting EVERY bare newline into a command separator (the fix for the
  // bare-newline `rm` spoof above) went too far: a Bash `\`-newline or
  // PowerShell backtick-newline is a LINE CONTINUATION, one logical command
  // written across lines, not a boundary. Treating it as a separator
  // defeated every pattern in production-policy.json that excludes
  // crossing a real separator (`[^|;&\n]*?`) for any continued command --
  // reproduced for production-deploy, destructive-operation, iam-or-
  // secrets, release, merge, and payment, among others. Fixed by collapsing
  // a continuation to a plain space FIRST, before any remaining bare
  // newline becomes a separator.
  const dataRoot = tempDataRoot();
  const mustStillGate = [
    ['kubectl \\\napply -f prod.yaml', 'production-deploy'],
    ['terraform \\\ndestroy -auto-approve', 'production-deploy'],
    ['rm -rf \\\n./build', 'destructive-operation'],
  ];
  for (const [command, expectedClass] of mustStillGate) {
    const result = classifyRiskAction({ toolName: 'Bash', toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for: ${JSON.stringify(command)}`);
    assert.equal(result.actionClass, expectedClass, `expected ${expectedClass} for: ${JSON.stringify(command)}`);
  }

  const powerShellContinuation = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'kubectl `\napply -f prod.yaml' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(powerShellContinuation.action, 'require-approval', 'a PowerShell backtick-continuation must not neuter production-deploy classification');
  assert.equal(powerShellContinuation.actionClass, 'production-deploy');

  // The bare-newline rm-spoof case (no continuation character at all) must
  // remain gated -- this fix must not un-fix that regression test.
  const bareNewlineStillGated = classifyRiskAction({ toolName: 'Bash', toolInput: { command: 'git\nrm -rf /' }, cwd: process.cwd(), dataRoot });
  assert.equal(bareNewlineStillGated.action, 'require-approval');
  assert.equal(bareNewlineStillGated.actionClass, 'destructive-operation');
});

test('shared risk policy classifies environment-variable, Windows drive-root, and PowerShell rm-alias-with-relative-target destructive deletes correctly', () => {
  const dataRoot = tempDataRoot();
  const cases = [
    ['Bash', 'rm -rf $HOME'],
    ['Bash', 'rm -rf %USERPROFILE%\\temp'],
    ['Bash', 'rm -rf C:\\'],
    ['PowerShell', 'rm -Recurse -Force ./build'],
    ['PowerShell', 'Remove-Item .. -Recurse -Force'],
    ['PowerShell', 'Remove-Item -Recurse -Force $env:TEMP\\x'],
  ];
  for (const [toolName, command] of cases) {
    const result = classifyRiskAction({ toolName, toolInput: { command }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'require-approval', `expected require-approval for ${toolName}: ${command}`);
    assert.equal(result.actionClass, 'destructive-operation');
  }
});

test('shared risk policy denies a PowerShell command reading a protected secret path', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'Get-Content .env' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'sensitive-path');
});

test('shared risk policy denies a PowerShell command directly invoking a KRYLO Hook entrypoint', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'node plugins/krylo/scripts/security/risk-gate.mjs' },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'hook-entrypoint-protection');
});

// Regression (Critical, found by a fresh independent Security Reviewer
// against docs/adr/0032-codex-project-scoped-hook-enforcement.md): the
// project-scoped Codex hook enforcement files (<project>/.codex/hooks.json,
// the ownership sidecar, and the launcher directory) had NO Write/Edit/
// NotebookEdit/apply_patch protection at all -- only Bash/PowerShell
// EXECUTION of the launcher was denied (hook-entrypoint-protection above).
// Reproduced directly: a model could Write a no-op replacement over the
// launcher, or Write {} over hooks.json, both classified `pass`, silently
// disabling every subsequent Codex PreToolUse enforcement for the rest of
// the session (a PreToolUse hook that fails to emit valid output is
// confirmed to fail OPEN on the current stable Codex release -- see
// docs/codex-capability-matrix.md).
test('shared risk policy denies Write/Edit/NotebookEdit/apply_patch targeting the Codex project-scoped hook files (hooks.json, the ownership sidecar, or anything under .codex/krylo/)', () => {
  const dataRoot = tempDataRoot();
  const targets = [
    '.codex/hooks.json',
    '.codex\\hooks.json',
    '.codex/krylo-hooks-meta.json',
    '.codex/krylo/codex-project-hook-launcher.mjs',
    '.codex\\krylo\\codex-project-hook-launcher.mjs',
    'subdir/../.codex/hooks.json',
    // Regression (Medium, found and reproduced by a fresh independent
    // Security Reviewer): Windows silently ignores a trailing space or dot
    // on a path component, so `.codex/hooks.json ` / `.codex/hooks.json.`
    // land on the exact same real file while evading an end-anchored
    // string match -- the same class of bypass already fixed for
    // touchesClaudeSettings()'s sensitive-path matching.
    '.codex/hooks.json ',
    '.codex/hooks.json.',
    '.codex/krylo/codex-project-hook-launcher.mjs ',
  ];
  for (const target of targets) {
    for (const toolName of ['Write', 'Edit', 'NotebookEdit']) {
      const result = classifyRiskAction({ toolName, toolInput: { file_path: target }, cwd: process.cwd(), dataRoot });
      assert.equal(result.action, 'deny', `expected deny for ${toolName} -> ${target}`);
      assert.equal(result.category, 'security-config-protection');
    }
  }
});

test('shared risk policy denies an apply_patch call targeting .codex/hooks.json or the launcher directory', () => {
  const dataRoot = tempDataRoot();
  for (const target of ['.codex/hooks.json', '.codex/krylo/codex-project-hook-launcher.mjs']) {
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch\n`;
    const result = classifyRiskAction({ toolName: 'apply_patch', toolInput: { patch }, cwd: process.cwd(), dataRoot });
    assert.equal(result.action, 'deny', `expected deny for apply_patch -> ${target}`);
    assert.equal(result.category, 'security-config-protection');
  }
});

test('shared risk policy denies a Bash/PowerShell command that textually references .codex/hooks.json or the launcher path (not just direct launcher execution)', () => {
  const dataRoot = tempDataRoot();
  const commands = [
    'echo "{}" > .codex/hooks.json',
    'rm .codex/krylo-hooks-meta.json',
    'Remove-Item .codex\\hooks.json',
  ];
  for (const command of commands) {
    for (const toolName of ['Bash', 'PowerShell']) {
      const result = classifyRiskAction({ toolName, toolInput: { command }, cwd: process.cwd(), dataRoot });
      assert.equal(result.action, 'deny', `expected deny for ${toolName}: ${command}`);
      assert.equal(result.category, 'security-config-protection');
    }
  }
});

test('shared risk policy denies a Bash command directly invoking any Codex Hook entrypoint (regression found by a fresh independent Security Reviewer: distinct Codex filenames were silently uncovered by the Claude-only entrypoint list)', () => {
  const dataRoot = tempDataRoot();
  const codexEntrypoints = [
    'scripts/security/user-prompt-submit-codex.mjs',
    'scripts/security/risk-gate-codex.mjs',
    'scripts/security/permission-request-codex.mjs',
    'scripts/runtime/posttool-telemetry-codex.mjs',
    // Project-scoped hook launcher (docs/adr/0032): a model could otherwise
    // route around every filename above by invoking it through this
    // redirector instead of the real script directly.
    '.codex/krylo/codex-project-hook-launcher.mjs',
    // Lifecycle enforcement (docs/adr/0033): Stop/SessionStart/SessionEnd
    // entrypoints, same forgery risk (e.g. a fabricated Stop payload could
    // be used to probe for another session's run, or a direct invocation
    // could bypass the real hook firing and thus the Orbit budget check).
    'scripts/orbit/stop-gate-codex.mjs',
    'scripts/security/session-start-codex.mjs',
    'scripts/status/session-end-codex.mjs',
  ];
  for (const entrypoint of codexEntrypoints) {
    const result = classifyRiskAction({
      toolName: 'Bash',
      toolInput: { command: `echo '{"session_id":"forged"}' | node "${entrypoint}"` },
      cwd: process.cwd(),
      dataRoot,
    });
    assert.equal(result.action, 'deny', `expected deny for direct invocation of ${entrypoint}`);
    assert.equal(result.category, 'hook-entrypoint-protection');
  }
});

test('shared risk policy denies a PowerShell command referencing the KRYLO data root', () => {
  const dataRoot = tempDataRoot();
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: `Remove-Item -Recurse -Force ${dataRoot.replace(/\\/g, '/')}/runs` },
    cwd: dataRoot,
    dataRoot,
  });
  assert.equal(result.action, 'deny');
  assert.equal(result.category, 'data-root-protection');
});

test('shared risk policy denies an oversized PowerShell command outright, same as Bash', () => {
  const dataRoot = tempDataRoot();
  const oversized = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: `git push --force origin main  # ${'x'.repeat(20_000)}` },
    cwd: process.cwd(),
    dataRoot,
  });
  assert.equal(oversized.action, 'deny');
  assert.equal(oversized.category, 'oversized-command');
});

test('shared risk policy passes a benign PowerShell command', () => {
  const result = classifyRiskAction({
    toolName: 'PowerShell',
    toolInput: { command: 'npm test' },
    cwd: process.cwd(),
    dataRoot: tempDataRoot(),
  });
  assert.equal(result.action, 'pass');
});

test('module source never reads a CLAUDE_-prefixed environment variable', () => {
  const source = fs.readFileSync(RISK_POLICY_PATH, 'utf8');
  assert.doesNotMatch(source, /process\.env\.CLAUDE_/);
  assert.doesNotMatch(source, /env\[.CLAUDE_/);
});
