// Redaction helpers used before anything is persisted or printed.
//
// KRYLO must never persist or display raw secrets, credentials, or the
// user's home directory path. These functions apply a fixed set of masking
// rules and are intentionally conservative (they may over-mask benign long
// tokens rather than risk under-masking a secret).

const MASK = '[REDACTED]';

function maskPem(s) {
  return s.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, MASK);
}

function maskGithubTokens(s) {
  return s.replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/g, MASK);
}

function maskSlackTokens(s) {
  return s.replace(/\bxox[a-z]-[A-Za-z0-9-]+\b/g, MASK);
}

function maskJwt(s) {
  return s.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK);
}

function maskBearer(s) {
  return s.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${MASK}`);
}

function maskUrlCredentials(s) {
  // Cheap linear pre-check: without a literal "://" anywhere, the regex
  // below can never match, so skip it entirely -- this is the overwhelming
  // common case for ordinary source/diff content. Found necessary after
  // Cross-Harness's context-packet builder (a genuinely new, larger-input
  // caller of this function) reproduced a real ~50s hang on a 300,000-char
  // string with no "://" in it at all: the unbounded `[a-zA-Z0-9+.-]*`
  // scheme-prefix quantifier greedily consumes the whole remaining run at
  // every one of the string's O(n) starting positions, then backtracks
  // character-by-character (another O(n)) looking for the literal "://"
  // that never appears -- true O(n^2) behavior on adversarial input, not
  // hypothetical.
  if (!s.includes('://')) return s;
  // Bounding the scheme prefix (no real URL scheme is anywhere near this
  // long) caps the backtracking work per starting position at a constant,
  // closing the O(n^2) blowup even for a crafted input that DOES contain
  // "://" somewhere far from a long non-matching run -- defense in depth
  // alongside the early-exit above, not a substitute for it.
  // Greedy password segment backtracks to the LAST @, so passwords that
  // themselves contain @ are fully masked.
  return s.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]{0,31}):\/\/[^/\s:@]+:[^/\s]*@/g,
    (_m, scheme) => `${scheme}://${MASK}@`,
  );
}

function maskKeyValueSecrets(s) {
  // Key may carry a prefix (client_secret, access_token, MY_API_KEY, ...).
  return s.replace(
    /\b[\w.-]*(password|passwd|secret|token|api[_-]?key)\s*=\s*("[^"]*"|'[^']*'|[^\s&"']+)/gi,
    (m, key) => `${m.slice(0, m.indexOf('='))}=${MASK}`,
  );
}

function maskAwsAccessKey(s) {
  return s.replace(/\bAKIA[0-9A-Z]{16}\b/g, MASK);
}

function maskSkKeys(s) {
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, MASK)
    .replace(/\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g, MASK)
    .replace(/\brk_(live|test)_[A-Za-z0-9]{10,}\b/g, MASK)
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK);
}

function maskHomeDir(s) {
  let out = s.replace(/[A-Za-z]:\\Users\\[^\\/\s"']+/g, '~');
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, '~');
  return out;
}

// Long hex/base64 runs are the last, most generic pass so that anything
// already replaced by a more specific rule (and now reading "[REDACTED]")
// is not re-matched, and so specific token shapes get their dedicated marker.
function maskLongOpaqueRuns(s) {
  return s
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, MASK)
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, MASK);
}

// A fresh independent Security Reviewer found a real RangeError ("Maximum
// call stack size exceeded") thrown when redacting a single very long
// (multi-megabyte) unbroken token-like run -- distinct from the
// maskUrlCredentials catastrophic-backtracking ReDoS already fixed
// elsewhere in this file, and not fully root-caused given time
// constraints. Bounding the length any single masking pass is asked to
// process is a safe, general guard regardless of which specific regex
// pattern is responsible: content beyond this bound is masked outright
// rather than risk any V8 regex engine's internal limit on a future input
// shape not yet identified. No legitimate secret-scanning need ever
// requires examining a single 5MB+ blob character-by-character for token
// shapes that are, by definition, short.
const MAX_REDACT_INPUT_LENGTH = 2_000_000;

/**
 * Redact secrets, tokens, credentials, and home-directory paths from a string.
 * Non-string input is returned unchanged. Never throws -- this function's
 * own contract (relied on throughout state/telemetry/Cross-Harness) is to
 * always return a safe string, never propagate an internal regex-engine
 * failure to the caller.
 */
export function redactText(input) {
  if (typeof input !== 'string') return input;
  if (input.length > MAX_REDACT_INPUT_LENGTH) return MASK;
  try {
    return redactTextUnbounded(input);
  } catch {
    return MASK;
  }
}

function redactTextUnbounded(input) {
  let out = input;
  out = maskPem(out);
  out = maskGithubTokens(out);
  out = maskSlackTokens(out);
  out = maskJwt(out);
  out = maskBearer(out);
  out = maskUrlCredentials(out);
  out = maskKeyValueSecrets(out);
  out = maskAwsAccessKey(out);
  out = maskSkKeys(out);
  out = maskHomeDir(out);
  out = maskLongOpaqueRuns(out);
  return out;
}

/** Redact then truncate a string to at most `max` characters. */
export function redactAndTruncate(input, max) {
  const redacted = redactText(input);
  if (typeof redacted !== 'string') return redacted;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) return redacted;
  return redacted.length > max ? redacted.slice(0, max) : redacted;
}

/** Recursively redact every string value in an object/array, preserving shape. */
export function deepRedact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = deepRedact(v);
    }
    return result;
  }
  return value;
}
