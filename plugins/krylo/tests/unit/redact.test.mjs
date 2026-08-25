import test from 'node:test';
import assert from 'node:assert/strict';

import { redactText, redactAndTruncate, deepRedact } from '../../scripts/lib/redact.mjs';

test('masks a PEM block', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJBAK\n-----END PRIVATE KEY-----';
  const out = redactText(`key is ${pem} done`);
  assert.ok(!out.includes('MIIBogIBAAJBAK'));
  assert.ok(out.includes('[REDACTED]'));
});

test('masks GitHub tokens (ghp_, github_pat_, gho_)', () => {
  assert.ok(!redactText('token ghp_1234567890abcdefghijklmno end').includes('ghp_1234567890abcdefghijklmno'));
  assert.ok(!redactText('token github_pat_1234567890abcdefghijklmno end').includes('github_pat_1234567890abcdefghijklmno'));
  assert.ok(!redactText('token gho_1234567890abcdefghijklmno end').includes('gho_1234567890abcdefghijklmno'));
});

test('masks sk- style API keys', () => {
  const out = redactText('secret is sk-abcdefghijklmnopqrstuvwx1234');
  assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwx1234'));
  assert.ok(out.includes('[REDACTED]'));
});

test('masks AWS access key ids and long secret pairs', () => {
  const out = redactText('AKIAIOSFODNN7EXAMPLE and wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!out.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
});

test('masks Slack tokens', () => {
  const out = redactText('slack token xoxb-1234567890-abcdefghij');
  assert.ok(!out.includes('xoxb-1234567890-abcdefghij'));
});

test('masks JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZXZhbHVl';
  const out = redactText(`Authorization: ${jwt}`);
  assert.ok(!out.includes(jwt));
});

test('masks Bearer tokens', () => {
  const out = redactText('Authorization: Bearer abcdef1234567890ABCDEF');
  assert.ok(!out.includes('abcdef1234567890ABCDEF'));
  assert.ok(out.includes('Bearer [REDACTED]'));
});

test('masks password/secret/token/api-key key=value pairs case-insensitively', () => {
  assert.ok(!redactText('password=Sup3rSecret!').includes('Sup3rSecret!'));
  assert.ok(!redactText('PASSWD=Sup3rSecret!').includes('Sup3rSecret!'));
  assert.ok(!redactText('secret=Sup3rSecret!').includes('Sup3rSecret!'));
  assert.ok(!redactText('token=Sup3rSecret!').includes('Sup3rSecret!'));
  assert.ok(!redactText('API_KEY=Sup3rSecret!').includes('Sup3rSecret!'));
  assert.ok(!redactText('apikey=Sup3rSecret!').includes('Sup3rSecret!'));
});

test('masks credentials embedded in URLs', () => {
  const out = redactText('connect to postgres://myuser:myp4ss@db.example.com:5432/app');
  assert.ok(!out.includes('myuser:myp4ss'));
  assert.ok(out.includes('postgres://[REDACTED]@db.example.com'));
});

// Regression: Cross-Harness's context-packet builder (a genuinely new,
// larger-input caller of redactText/deepRedact) reproduced a real ~50s hang
// feeding this function a 300,000-char string with no "://" anywhere in
// it -- maskUrlCredentials' unbounded scheme-prefix quantifier
// ([a-zA-Z0-9+.-]*) backtracked O(n) times at each of O(n) starting
// positions (true O(n^2) on adversarial input, not hypothetical). Fixed
// with a cheap "does the string even contain ://" pre-check plus a bounded
// scheme-prefix length as defense in depth.
test('does not hang on a long string with no URL-credential shape at all (ReDoS regression)', () => {
  const adversarial = 'x'.repeat(300_000);
  const t0 = Date.now();
  const out = redactText(adversarial);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 2000, `redactText took ${elapsedMs}ms on adversarial input, expected well under 2000ms`);
  assert.equal(out, '[REDACTED]', 'the long uniform run is still masked by the long-opaque-run rule, unaffected by the URL-credential fix');
});

test('a crafted string containing "://" far from a long non-matching run still runs quickly and masks correctly', () => {
  const adversarial = `${'y'.repeat(200_000)} https://user:pass@example.com/path ${'z'.repeat(200_000)}`;
  const t0 = Date.now();
  const out = redactText(adversarial);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 2000, `redactText took ${elapsedMs}ms, expected well under 2000ms`);
  assert.ok(out.includes('https://[REDACTED]@example.com/path'));
});

// Regression: a fresh independent Security Reviewer's report prompted
// discovery of a real RangeError ("Maximum call stack size exceeded")
// thrown when redacting a single very long (multi-megabyte) unbroken
// token-like run -- distinct from the maskUrlCredentials ReDoS above, and
// not tied to any one specific masking pass. redactText must never throw;
// oversized input is masked outright via MAX_REDACT_INPUT_LENGTH instead.
test('does not throw a RangeError on a very large single-token input, and masks it outright', () => {
  const huge = 'a'.repeat(9_000_000);
  const out = redactText(huge);
  assert.equal(out, '[REDACTED]', 'oversized input is masked outright rather than processed');
});

test('deepRedact does not throw when a nested string value is oversized', () => {
  const out = deepRedact({ note: 'ok', blob: 'a'.repeat(9_000_000) });
  assert.equal(out.note, 'ok');
  assert.equal(out.blob, '[REDACTED]');
});

test('masks long hex and base64 runs', () => {
  const hex = 'a'.repeat(40);
  const out = redactText(`hash: ${hex}`);
  assert.ok(!out.includes(hex));
});

test('masks home directory prefixes on both platforms', () => {
  const win = redactText('path is C:\\Users\\alice\\projects\\repo\\file.txt');
  assert.ok(!win.includes('C:\\Users\\alice'));
  assert.ok(win.includes('~'));

  const posixHome = redactText('path is /home/alice/projects/repo/file.txt');
  assert.ok(!posixHome.includes('/home/alice'));
  assert.ok(posixHome.includes('~'));

  const macHome = redactText('path is /Users/alice/projects/repo/file.txt');
  assert.ok(!macHome.includes('/Users/alice'));
  assert.ok(macHome.includes('~'));
});

test('leaves benign text unchanged', () => {
  const benign = 'All 42 tests passed with 0 failures on branch main.';
  assert.equal(redactText(benign), benign);
});

test('redactAndTruncate truncates after redaction', () => {
  const input = 'password=Sup3rSecret! and then some trailing filler text beyond the limit';
  const out = redactAndTruncate(input, 20);
  assert.ok(out.length <= 20);
  assert.ok(!out.includes('Sup3rSecret!'));
});

test('deepRedact recurses through nested objects and arrays', () => {
  const input = {
    a: 'token=abcdefghijklmnop',
    b: [{ c: 'password=hunter2value' }, 'plain text'],
    d: { e: { f: 'ghp_1234567890abcdefghijklmno' } },
    n: 42,
    bool: true,
    nil: null,
  };
  const out = deepRedact(input);
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnop'));
  assert.ok(!JSON.stringify(out).includes('hunter2value'));
  assert.ok(!JSON.stringify(out).includes('ghp_1234567890abcdefghijklmno'));
  assert.equal(out.n, 42);
  assert.equal(out.bool, true);
  assert.equal(out.nil, null);
  assert.equal(out.b[1], 'plain text');
});
