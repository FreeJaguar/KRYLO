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

function findServerRule(mcpPolicy, server) {
  const needle = server.toLowerCase();
  for (const rule of mcpPolicy.serverActionClasses ?? []) {
    if (new RegExp(rule.match, 'i').test(needle)) return rule;
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
    return { className: 'other', reason: 'Unrecognized MCP tool name shape; not automatically trusted.' };
  }
  const { server, operation } = parsed;

  const mcpPolicy = loadJson(MCP_POLICY_PATH);
  const catalog = loadJson(CATALOG_PATH);

  if (catalogBlocksServer(catalog, server)) {
    return { className: mcpPolicy.unknownServerClass, reason: 'This MCP server is blocked in the KRYLO tool trust catalog.' };
  }

  const rule = findServerRule(mcpPolicy, server);
  const isKnown = Boolean(rule) || catalogKnowsServer(catalog, server);

  if (!isKnown) {
    return {
      className: mcpPolicy.unknownServerClass,
      reason: 'Unrecognized MCP server; unknown MCP write-capable tools are never automatically trusted.',
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
