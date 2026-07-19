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
