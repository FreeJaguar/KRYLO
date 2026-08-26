// TDD category B (task Section 19.B): upstream client safety.
// Mocks the global `fetch` (Node's built-in, via node:test's mock API) so
// this suite never depends on live network access.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchUpstreamJson } from '../../scripts/lib/upstream-client.mjs';

test('allowed domain (api.github.com): a normal 200 JSON response is returned', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, true);
  assert.equal(result.json.tag_name, 'v1.0.0');
});

test('blocked domain: a URL outside the allowlist is refused before any network call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const result = await fetchUpstreamJson('https://evil.example.com/steal');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'domain-not-allowed');
  assert.equal(fetchMock.mock.callCount(), 0, 'fetch must never actually be called for a disallowed domain');
});

test('redirect within the allowed domain is followed', async (t) => {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) return new Response(null, { status: 302, headers: { location: 'https://api.github.com/repos/x/y/releases/latest-redirected' } });
    return new Response(JSON.stringify({ tag_name: 'v2.0.0' }), { status: 200 });
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, true);
  assert.equal(result.json.tag_name, 'v2.0.0');
  assert.equal(call, 2);
});

test('redirect OUTSIDE the allowed domain is refused, never silently followed', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('api.github.com')) {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
    }
    return new Response('{"stolen":true}', { status: 200 });
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'domain-not-allowed');
  assert.equal(fetchMock.mock.callCount(), 1, 'the redirect target must never actually be fetched');
});

test('timeout: an AbortError from fetch is classified as "timeout", never treated as a valid response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('oversized response: a body exceeding the byte cap is rejected, never partially trusted', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(3 * 1024 * 1024), { status: 200 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'response-too-large');
});

test('invalid JSON: a 200 response with unparseable JSON is a clean failure, not a crash', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{ this is not json', { status: 200 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-json');
});

test('404: a missing resource is reported distinctly, never fabricated as "up to date"', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});

test('429: rate limiting is reported distinctly, retried at most once, never treated as a break', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 429 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate-limited');
  // A 429 is an actual HTTP response, not a network-level failure -- the
  // "retry once" policy applies only to timeout/network-error, never after
  // a response was already received (task Section 21).
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('500: a server error is reported distinctly and retried at most once for a network-level condition only', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'server-error');
});

test('a genuine network error is retried exactly once, not zero and not more than once', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNRESET');
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-error');
  assert.equal(fetchMock.mock.callCount(), 2, 'exactly one retry after the first network-level failure');
});

test('a network error that succeeds on the single retry returns the successful result', async (t) => {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) throw new Error('ECONNRESET');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, true);
  assert.equal(call, 2);
});
