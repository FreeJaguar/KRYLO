// Minimal, correct version comparator for the exact version shapes KRYLO's
// Ecosystem Maintenance checker actually needs to compare (Claude Code CLI,
// Codex CLI, Node.js major.minor). Deliberately NOT a general semver parser:
// the parent task explicitly warns against writing a fake semver parser
// that silently accepts malformed input. A string that does not match one
// of the narrow shapes below is reported as malformed, never guessed at.

const PLAIN_SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const CODEX_TAG_RE = /^rust-v(\d+)\.(\d+)\.(\d+)$/;
const CODEX_CLI_OUTPUT_RE = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)$/;
const MAJOR_MINOR_RE = /^v?(\d+)\.(\d+)$/;

/**
 * Parse a plain `X.Y.Z` version (optionally `v`-prefixed) -- the shape
 * Claude Code CLI releases and `claude --version`'s own first line use.
 * Returns { ok: true, major, minor, patch } or { ok: false, reason }.
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  const m = PLAIN_SEMVER_RE.exec(input.trim());
  if (!m) return { ok: false, reason: 'malformed-version' };
  return { ok: true, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Parse a Codex version from either its GitHub tag shape (`rust-vX.Y.Z`,
 * confirmed directly against the real `rust-v0.120.0` tag) or its CLI
 * output shape (`codex-cli X.Y.Z`). Returns the same shape as parseSemver.
 */
export function parseCodexVersion(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  const trimmed = input.trim();
  const tagMatch = CODEX_TAG_RE.exec(trimmed);
  if (tagMatch) return { ok: true, major: Number(tagMatch[1]), minor: Number(tagMatch[2]), patch: Number(tagMatch[3]) };
  const cliMatch = CODEX_CLI_OUTPUT_RE.exec(trimmed);
  if (cliMatch) return { ok: true, major: Number(cliMatch[1]), minor: Number(cliMatch[2]), patch: Number(cliMatch[3]) };
  return { ok: false, reason: 'malformed-version' };
}

/** Parse a Node.js `major.minor` pair (an engines-range floor, not a pinned exact version). */
export function parseMajorMinor(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  const m = MAJOR_MINOR_RE.exec(input.trim());
  if (!m) return { ok: false, reason: 'malformed-version' };
  return { ok: true, major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Compare two already-parsed { major, minor, patch? } values.
 * Returns -1, 0, or 1 (a < b, a == b, a > b).
 */
export function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  const ap = a.patch ?? 0;
  const bp = b.patch ?? 0;
  if (ap !== bp) return ap < bp ? -1 : 1;
  return 0;
}
