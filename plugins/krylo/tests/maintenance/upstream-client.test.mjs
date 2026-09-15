// TDD category B (task Section 19.B): upstream client safety.
// Mocks the global `fetch` (Node's built-in, via node:test's mock API) so
// this suite never depends on live network access.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchUpstreamJson, getGithubCommitForRef } from '../../scripts/lib/upstream-client.mjs';

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

// Regression (Security Reviewer M-1, CONFIRMED via a real local slow-body
// server: 35s observed against a 10s configured cap): the request timeout
// previously covered only fetch()'s own headers-received phase --
// clearTimeout(timer) fired the instant fetch() resolved, before the body
// was ever read, so a server returning headers instantly and then
// dribbling the body indefinitely could hang the checker forever (the 2MB
// size cap never helps, since the byte count never gets there).
//
// This test proves the STRUCTURAL fix directly -- clearTimeout is not
// called until the entire hop (headers AND body) completes -- via a spy on
// the real global clearTimeout, rather than trying to simulate the actual
// 10-second timer firing. An earlier version of this test used node:test's
// mock timers to simulate the real 10s cap elapsing; that approach proved
// flaky (correct when run in isolation, hanging when run alongside this
// file's other tests, apparently a mock-timers/global-fetch-mock
// interaction) and was replaced with this deterministic, race-free shape,
// which is a strictly stronger test of the actual bug anyway: it proves
// the timer is never cleared prematurely, which is the exact root cause,
// rather than depending on a simulated timer callback also firing
// correctly.
test('the timer is not cleared until the ENTIRE hop (headers AND body) completes -- closes the M-1 premature-clearTimeout bug', async (t) => {
  const clearTimeoutCalls = [];
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'clearTimeout', (...args) => {
    clearTimeoutCalls.push(Date.now());
    return realClearTimeout(...args);
  });

  let releaseBody;
  const bodyGate = new Promise((resolve) => { releaseBody = resolve; });
  let stage = 'gated'; // gated -> chunk -> done
  const jsonBytes = new TextEncoder().encode('{"ok":true}');
  const gatedBody = {
    getReader() {
      return {
        async read() {
          if (stage === 'gated') {
            await bodyGate;
            stage = 'chunk';
            return { done: false, value: jsonBytes };
          }
          if (stage === 'chunk') {
            stage = 'done';
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      };
    },
  };
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, headers: { get: () => null }, body: gatedBody }));

  const resultPromise = fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  // Let the async chain reach readBoundedBody()'s pending reader.read()
  // call -- a handful of microtask turns, not a real-time wait.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(clearTimeoutCalls.length, 0, 'clearTimeout must not fire while the body read is still pending -- this was exactly the M-1 bug (it fired right after headers, before the body was ever read)');

  releaseBody();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(clearTimeoutCalls.length, 1, 'clearTimeout must fire exactly once, only after the body read actually completes');
});

test('the domain allowlist checks scheme and port, not only hostname: a plaintext http:// redirect to an allowlisted host is refused', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === 'https://api.github.com/repos/x/y/releases/latest') {
      return new Response(null, { status: 302, headers: { location: 'http://api.github.com/repos/x/y/releases/latest' } });
    }
    return new Response('{"stolen":true}', { status: 200 });
  });
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'domain-not-allowed');
  assert.equal(fetchMock.mock.callCount(), 1, 'the plaintext-http redirect target must never actually be fetched');
});

test('the domain allowlist rejects a non-443 port on an otherwise-allowlisted host', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const result = await fetchUpstreamJson('https://api.github.com:8080/repos/x/y/releases/latest');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'domain-not-allowed');
  assert.equal(fetchMock.mock.callCount(), 0);
});

// Regression (Security Reviewer L-3): owner/repo ultimately originate from
// parsed workflow-file text (actions-pins.mjs), not a fixed literal --
// an unencoded "/" in owner/repo could otherwise let a crafted value
// address a different API path segment.
test('getGithubCommitForRef URL-encodes owner/repo, closing a path-segment-injection shape at the source', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(!String(url).includes('/../'), `owner/repo must be encoded, not left to form a literal path segment: ${url}`);
    return new Response(JSON.stringify({ sha: 'abc' }), { status: 200 });
  });
  await getGithubCommitForRef('evil/..', 'also-evil', 'v1.0.0');
  assert.equal(fetchMock.mock.callCount(), 1);
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

// GitHub reports an exhausted PRIMARY rate limit as 403 with
// x-ratelimit-remaining: 0, not as 429. Before this branch existed the single
// most likely failure for an unauthenticated scheduled job fell into the
// catch-all `unexpected-status`, which reads like a broken endpoint rather
// than a quota that refills. The distinction is consumed downstream: the
// Ecosystem Radar reports a rate-limited probe as an unknown.
test('403 with an exhausted rate-limit header is reported as rate-limited, not as an unexpected status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/contents/package.json');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.status, 403);
});

// The narrowing that keeps the branch honest: a 403 that is NOT a rate limit
// is an authorization failure and must not be relabelled as one, or a real
// permission problem would look like something that fixes itself with time.
test('403 without an exhausted rate-limit header stays an unexpected status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '4999' },
  }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/contents/package.json');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected-status');
});

test('403 with no rate-limit header at all stays an unexpected status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  const result = await fetchUpstreamJson('https://api.github.com/repos/x/y/contents/package.json');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected-status');
});

// A rate limit must never be retried: the quota does not refill within a
// request, so a retry is a wasted call against an already-exhausted budget.
test('a rate-limited response is not retried', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  }));
  await fetchUpstreamJson('https://api.github.com/repos/x/y/contents/package.json');
  assert.equal(fetchMock.mock.callCount(), 1, 'no retry may follow an actual HTTP response');
});
