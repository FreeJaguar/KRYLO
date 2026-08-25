// Classifies a PreToolUse call to an MCP tool (tool_name matching
// mcp__<server>__<operation>) against policies/mcp-policy.json and the Tool
// Trust Registry (catalog/tools.json), for scripts/security/risk-gate.mjs.
//
// Tool names and descriptions from MCP servers are untrusted data (rule
// mcp-untrusted-metadata): this classifier only ever looks at the literal
// tool_name string Claude Code invoked, never at server-provided metadata,
// and every decision path that cannot positively confirm safety denies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_POLICY_PATH = path.join(HERE, '..', '..', 'policies', 'mcp-policy.json');
const CATALOG_PATH = path.join(HERE, '..', '..', 'catalog', 'tools.json');

export const MCP_TOOL_PREFIX = 'mcp__';

/** True for any tool name Claude Code routes through an MCP server. */
export function isMcpToolName(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * mcp__<server>__<operation>: the server segment may itself contain single
 * underscores, so the operation is the last '__'-delimited segment and the
 * server is everything between the mcp__ prefix and that last segment.
 */
export function parseMcpToolName(toolName) {
  const parts = String(toolName).split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  const operation = parts[parts.length - 1];
  const server = parts.slice(1, -1).join('__');
  if (server === '' || operation === '') return null;
  return { server, operation };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * A server is "known" only when its name is EXACTLY the catalog tool's id
 * (optionally with a trailing -mcp/-cli suffix), case-insensitively. A prior
 * version used bidirectional substring matching (`needle.includes(strippedId)`
 * / `haystack.includes(needle)`), which let an attacker-named server borrow
 * trust by embedding a short catalog id as a substring (e.g. "digitalocean"
 * contains "git", "context7-writer" contains "context7") and be treated as a
 * known, unruled, read-oriented, pass-through server for every operation —
 * defeating the "unknown MCP write-capable tools are never automatically
 * trusted" rule. Exact-match only closes that bypass; it never widens what
 * counts as known, so it cannot introduce a new gap in the other direction.
 */
function normalizeServerCandidate(id) {
  return String(id).toLowerCase().replace(/-mcp$|-cli$/, '');
}

function catalogKnowsServer(catalog, server) {
  const needle = server.toLowerCase();
  return catalog.tools.some((tool) => {
    const id = tool.id.toLowerCase();
    return id === needle || normalizeServerCandidate(id) === needle;
  });
}

function catalogBlocksServer(catalog, server) {
  const needle = server.toLowerCase();
  return catalog.tools.some((tool) => {
    if (tool.trustTier !== 'Blocked') return false;
    const id = tool.id.toLowerCase();
    return id === needle || normalizeServerCandidate(id) === needle;
  });
}

/**
 * `rule.match` is a simple `|`-delimited alternation of exact server-identity
 * keywords (e.g. "stripe|paypal|braintree|adyen", or an already-anchored
 * "^git$") -- never a partial-match pattern. Two independent review rounds
 * found the original unanchored `new RegExp(rule.match, 'i').test(needle)`
 * let an attacker-chosen server name borrow trust merely by CONTAINING one
 * of these keywords (e.g. "evil-github-proxy" matched "github" and was
 * treated as the known, reviewed GitHub server) -- the exact same bypass
 * class `catalogKnowsServer()` above was already hardened against; this
 * function had not been. Exact match only (after stripping the same
 * -mcp/-cli suffix `catalogKnowsServer()` tolerates), never substring.
 */
function serverNameMatchesRule(rule, server) {
  const needle = server.toLowerCase();
  const normalizedNeedle = normalizeServerCandidate(server);
  const alternatives = rule.match.replace(/^\^/, '').replace(/\$$/, '').split('|');
  return alternatives.some((alt) => {
    const altLower = alt.toLowerCase();
    return altLower === needle || altLower === normalizedNeedle;
  });
}

function findServerRule(mcpPolicy, server) {
  for (const rule of mcpPolicy.serverActionClasses ?? []) {
    if (serverNameMatchesRule(rule, server)) return rule;
  }
  return null;
}

/** Insert '_' at camelCase boundaries and lowercase, so a `_`/`-`-anchored verb
 * pattern matches "mergePullRequest" the same way it matches "merge_pull_request". */
function toDelimited(operation) {
  return String(operation)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function operationClass(rule, operation) {
  for (const override of rule.operationOverrides ?? []) {
    if (new RegExp(override.pattern, 'i').test(operation)) return { className: override.class, reason: rule.reason };
  }
  return { className: rule.writeClass, reason: rule.reason };
}

/**
 * Classify one MCP tool call.
 * Returns null when the call is allowed to pass through (recognized server,
 * operation does not look like a write), or { className, reason } when it
 * must be gated pending approval.
 */
export function classifyMcpTool(toolName) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) {
    // Malformed/unrecognized shape: fail toward gating, not toward trust.
    // `hardDeny: true` -- KRYLO cannot even identify what server or
    // operation this is, so there is nothing a human could meaningfully
    // evaluate in an approval prompt; this is a `deny` case, not a
    // `require-approval` one (docs/adr/0025-native-permission-approval.md's
    // restore-native-approval checkpoint: `deny` and `require-approval` are
    // distinct KRYLO policy outcomes, and a `deny` case must never be
    // routed through the native ask prompt just because MCP tools became
    // ask-eligible for their genuine require-approval classes).
    return { className: 'other', reason: 'Unrecognized MCP tool name shape; not automatically trusted.', hardDeny: true };
  }
  const { server, operation } = parsed;

  const mcpPolicy = loadJson(MCP_POLICY_PATH);
  const catalog = loadJson(CATALOG_PATH);

  if (catalogBlocksServer(catalog, server)) {
    return {
      className: mcpPolicy.unknownServerClass,
      reason: 'This MCP server is blocked in the KRYLO tool trust catalog.',
      hardDeny: true,
    };
  }

  const rule = findServerRule(mcpPolicy, server);
  const isKnown = Boolean(rule) || catalogKnowsServer(catalog, server);

  if (!isKnown) {
    // Same reasoning as above: an entirely unrecognized server is not a
    // known write operation awaiting a human's informed yes/no -- there is
    // no server identity for a human to evaluate at all, so this stays a
    // hard `deny`, never `ask`.
    return {
      className: mcpPolicy.unknownServerClass,
      reason: 'Unrecognized MCP server; unknown MCP write-capable tools are never automatically trusted.',
      hardDeny: true,
    };
  }

  if (!rule) {
    // Known via the catalog only (e.g. context7, playwright): no write
    // classification data, so this server is treated as a reviewed
    // read-oriented integration. Metadata is still untrusted, but with no
    // write class configured there is nothing productive to gate here.
    return null;
  }

  const writeVerb = new RegExp(mcpPolicy.writeVerbPattern, 'i');
  const sqlLike = new RegExp(mcpPolicy.sqlLikeOperationPattern, 'i');
  // writeVerbPattern requires a `_`/`-` delimiter around the verb, so an
  // operation named in camelCase (a common MCP convention, e.g.
  // "mergePullRequest", "createRefund") would never match the raw string —
  // silently un-gating exactly the writes this policy exists to catch.
  // Delimiting camelCase boundaries first makes the same pattern verb-aware
  // regardless of naming convention.
  const delimitedOperation = toDelimited(operation);
  const looksWrite = writeVerb.test(delimitedOperation)
    || (rule.treatAnyExecuteAsWrite === true && sqlLike.test(delimitedOperation));

  if (!looksWrite) return null;

  return operationClass(rule, operation);
}
