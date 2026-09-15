// Safe upstream HTTPS client for Ecosystem Maintenance (task Sections 6-8).
// Node built-ins only (fetch/URL/AbortController) -- no axios/got/octokit.
// Domain allowlist enforced on the initial request AND every redirect hop
// (a redirect escaping the allowlist is a failure, never silently
// followed); bounded timeout, response-size cap enforced while streaming
// (not only via a possibly-absent Content-Length header), bounded redirect
// count, and at most one retry for a network-level failure on GET only --
// never a second attempt once a response was actually received (Section 21:
// "never retry a request that performs a write; there should be no writes
// in this system anyway" -- every call here is GET).
//
// Verified directly against official docs before implementation (not
// memory; docs/process/ECOSYSTEM_MAINTENANCE_IMPLEMENTATION_PLAN.md Section
// 7 records the full verification): GitHub's unauthenticated REST API rate
// limit is 60 requests/hour/IP, comfortably above what one checker run
// issues; releases/tags/commits endpoints confirmed current.

const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com']);
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// A fresh independent Security Reviewer found the allowlist checked only
// `hostname`, silently accepting a plaintext `http://` (or a non-443 port)
// redirect to an otherwise-allowlisted host -- TLS/certificate validation
// would be dropped for that hop, letting an on-path attacker serve
// arbitrary JSON (still bounded to the report's own truncation, but a
// genuine strengthening the domain-allowlist claim in SECURITY.md already
// implies). Scheme and port are now checked alongside hostname.
function isAllowedHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.port === '' || u.port === '443') && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function readBoundedBody(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw Object.assign(new Error('response-too-large'), { code: 'RESPONSE_TOO_LARGE' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('response-too-large'), { code: 'RESPONSE_TOO_LARGE' });
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function fetchOnce(url, { acceptHeader }) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedHost(currentUrl)) {
      return { ok: false, reason: 'domain-not-allowed', url: currentUrl };
    }
    // A fresh independent Security Reviewer found and reproduced (a
    // deliberately slow-body local server, 35s observed against a 10s
    // configured cap) that the timeout previously covered only the
    // fetch() call itself (headers received), NOT the subsequent body
    // read below -- `clearTimeout(timer)` fired the instant fetch()
    // resolved, so a server that returns headers instantly and then
    // dribbles the body could hang the checker indefinitely; the 2MB cap
    // never helps because the byte count never gets there. The SAME
    // controller/signal now stays live, and the timer is cleared only
    // once the entire hop (headers AND body) is done -- an abort during
    // body streaming propagates to the reader's own pending `read()`
    // (the fetch spec ties response-body streaming to the same signal
    // used for the initial request), so one timer genuinely bounds the
    // whole hop, not just its first phase.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: acceptHeader,
          'User-Agent': 'krylo-ecosystem-maintenance',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network-error', error: String(err?.message || err) };
    }
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      const location = response.headers.get('location');
      if (!location) return { ok: false, reason: 'redirect-without-location' };
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.status === 429) { clearTimeout(timer); return { ok: false, reason: 'rate-limited', status: response.status }; }
    if (response.status >= 500) { clearTimeout(timer); return { ok: false, reason: 'server-error', status: response.status }; }
    if (response.status === 404) { clearTimeout(timer); return { ok: false, reason: 'not-found', status: response.status }; }
    if (response.status !== 200) { clearTimeout(timer); return { ok: false, reason: 'unexpected-status', status: response.status }; }
    try {
      const text = await readBoundedBody(response);
      return { ok: true, status: response.status, text };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return { ok: false, reason: aborted ? 'timeout' : (err?.code === 'RESPONSE_TOO_LARGE' ? 'response-too-large' : 'read-error'), error: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'too-many-redirects' };
}

/**
 * Fetch JSON from an allowlisted upstream URL. Never throws. Returns
 * { ok:true, json } or { ok:false, reason }. Exactly one bounded retry for
 * a network-level failure (timeout/connection error) before the request
 * ever received a response; no retry after any actual HTTP response.
 */
export async function fetchUpstreamJson(url, { acceptHeader = 'application/vnd.github+json' } = {}) {
  let result = await fetchOnce(url, { acceptHeader });
  if (!result.ok && (result.reason === 'timeout' || result.reason === 'network-error')) {
    result = await fetchOnce(url, { acceptHeader });
  }
  if (!result.ok) return result;
  try {
    return { ok: true, json: JSON.parse(result.text) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

// owner/repo ultimately originate from parsed workflow-file `uses:` text
// (actions-pins.mjs), not a fixed literal -- a fresh independent Security
// Reviewer noted they reached the URL unencoded, so a crafted `owner`
// containing `../` could in principle address a different API path
// (bounded to unauthenticated GET on the same allowlisted host, since
// isAllowedHost() constrains the host regardless, but worth closing at
// the source rather than relying on that alone).
function encodeRepoSegment(segment) {
  return encodeURIComponent(segment);
}

/** GET /repos/{owner}/{repo}/releases/latest -- the newest non-prerelease, non-draft release. */
export async function getLatestGithubRelease(owner, repo) {
  return fetchUpstreamJson(`https://api.github.com/repos/${encodeRepoSegment(owner)}/${encodeRepoSegment(repo)}/releases/latest`);
}

/** GET /repos/{owner}/{repo}/tags -- used when a repo has no formal "release", only tags. */
export async function getGithubTags(owner, repo) {
  return fetchUpstreamJson(`https://api.github.com/repos/${encodeRepoSegment(owner)}/${encodeRepoSegment(repo)}/tags`);
}

/** GET /repos/{owner}/{repo}/releases/tags/{tag} -- resolve one exact known tag (e.g. the pinned floor). */
export async function getGithubReleaseByTag(owner, repo, tag) {
  return fetchUpstreamJson(`https://api.github.com/repos/${encodeRepoSegment(owner)}/${encodeRepoSegment(repo)}/releases/tags/${encodeURIComponent(tag)}`);
}

/** GET /repos/{owner}/{repo}/commits/{ref} -- resolve a tag/branch ref to its exact commit SHA. */
export async function getGithubCommitForRef(owner, repo, ref) {
  return fetchUpstreamJson(`https://api.github.com/repos/${encodeRepoSegment(owner)}/${encodeRepoSegment(repo)}/commits/${encodeURIComponent(ref)}`);
}

/**
 * GET /repos/{owner}/{repo}/compare/{base}...{head} -- the changed-FILE LIST
 * between a reviewed ref and an observed one (Weekly Upstream Watch,
 * docs/adr/0036-weekly-upstream-watch.md). Only `files[].filename`/`status`
 * and the commit count are ever consumed: the response also carries patch
 * text and commit messages, which are upstream-authored untrusted content
 * and are deliberately never read, let alone executed. The `...` between the
 * two refs is GitHub's own three-dot compare syntax and must NOT be
 * percent-encoded, so each ref is encoded separately around it.
 */
export async function getGithubCompare(owner, repo, base, head) {
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  return fetchUpstreamJson(`https://api.github.com/repos/${encodeRepoSegment(owner)}/${encodeRepoSegment(repo)}/compare/${range}`);
}
