// KRYLO shared risk policy (host-neutral).
//
// Classifies commands, file targets, and MCP tool calls (Bash and PowerShell
// alike -- a risky action must not bypass KRYLO merely because Claude
// invoked one shell tool instead of the other) against
// policies/production-policy.json and policies/mcp-policy.json (the latter
// integrated with the Tool Trust Registry in catalog/tools.json). Production,
// destructive, publish, release, push, merge, IAM/secret, payment, external-
// message, and other declared write classes result in a `require-approval`
// decision; the host adapter is responsible for routing that through its own
// native, host-controlled human-approval surface (see risk-gate.mjs and
// docs/adr/0025-native-permission-approval.md) -- this module never grants,
// consumes, or otherwise authorizes an action itself. Sensitive files (.env,
// keys, credential stores) are protected outright (denied, not merely
// gated).
//
// This module is shared by every host adapter (scripts/security/risk-gate.mjs
// for Claude Code today). It never reads a host-specific environment
// variable or Hook payload field, never calls process.exit, and never writes
// to stdout: every entrypoint here returns a plain decision or result object
// for its caller to translate into that host's own output format.
//
// Decision text (the `reason` field) references ONLY the policy class and its
// reason — never the matched command, path, or tool arguments (prompt-
// injection and secret-leak safety).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDataRoot } from '../lib/paths.mjs';
import { isMcpToolName, classifyMcpTool } from './mcp-classifier.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, '..', '..', 'policies', 'production-policy.json');

export const DATA_ROOT_REASON =
  'The KRYLO runtime data directory (run state, approvals, pointers, wrapper config) is integrity-protected. ' +
  'It may only be modified through the KRYLO runtime scripts, never directly.';

// A conservative cap: fast for any legitimate command (measured ~4ms at
// this size against the real policy patterns) and far below the sizes
// (100K-1M chars) where the measured superlinear regex cost becomes a real
// latency/availability concern.
const MAX_BASH_COMMAND_LENGTH = 10_000;

export const OVERSIZED_COMMAND_REASON =
  `A Bash command this large (over ${MAX_BASH_COMMAND_LENGTH.toLocaleString('en-US')} characters) cannot be safely classified and is denied. ` +
  'Split it into smaller steps.';

export const HOOK_ENTRYPOINT_REASON =
  'This script is a KRYLO Hook entrypoint, invoked only by the host platform\'s own Hook dispatch -- it must never ' +
  'be executed directly.';

// Hook entrypoints (registered in skills/run/SKILL.md's frontmatter, never
// meant to be invoked by anything other than the host's own Hook dispatch)
// vs. the runtime CLIs the model IS meant to call directly
// (init-run.mjs/read-state.mjs/update-state.mjs/cleanup.mjs/doctor.mjs/
// audit-tool.mjs/validate-runtime.mjs). Security-hardening checkpoint:
// independent review found that a Hook entrypoint is an ordinary executable
// the model's own Bash/PowerShell tool can invoke directly with fabricated
// stdin, achieving the same state mutation a real Hook dispatch would (e.g.
// forging a PostToolUse/SubagentStart/Stop payload to manipulate telemetry,
// agent records, or Orbit bookkeeping). Denying direct invocation of these
// specific scripts closes the concrete, reproducible bypass; it is a
// text-matching defense-in-depth layer with the same category of
// limitation as touchesDataRoot() below (a sufficiently obfuscated
// invocation -- indirection through another interpreter, string
// concatenation, a copied/renamed file -- is not caught by design).
const HOOK_ENTRYPOINT_FILENAMES = [
  'question-gate.mjs',
  'risk-gate.mjs',
  'posttool-telemetry.mjs',
  'fingerprint.mjs',
  'agent-events.mjs',
  'stop-gate.mjs',
];

/**
 * KRYLO's own control plane (state.json, current-run.json, wrapper-config.json)
 * must not be writable through direct tool calls, or a prompt-injected model
 * could self-approve gated actions or disable the gates entirely. Legitimate
 * mutations go through the runtime CLIs, which never embed the data-root path
 * in the command line.
 */
/**
 * A Bash command can reference the data root using a shell shorthand that
 * expands to the same location at execution time (`~`, `$HOME`, `${HOME}`,
 * the Windows `%USERPROFILE%`) instead of spelling out the literal resolved
 * path. Substring-matching the raw command text alone would miss these, so
 * this also checks a version of the command with those forms expanded to
 * the real home directory -- lowercased and tried with both path-separator
 * styles, the same way the resolved data root itself already is.
 */
function homeExpandedVariants(command, home) {
  if (!home) return [];
  const homeLower = String(home).toLowerCase();
  const withHomeReplaced = String(command)
    .replace(/~[/\\]/g, `${homeLower}/`)
    .replace(/\$\{?home\}?/gi, homeLower)
    .replace(/%userprofile%/gi, homeLower);
  return [withHomeReplaced, withHomeReplaced.replace(/\\/g, '/'), withHomeReplaced.replace(/\//g, '\\')];
}

/**
 * Resolve a path through any symlinks, best-effort. fs.realpathSync throws
 * for a path whose final component does not exist yet (a common case: a new
 * file about to be created); this walks up to the nearest existing ancestor,
 * resolves *that* through symlinks, and re-appends the not-yet-existing
 * suffix, so a not-yet-created file inside a symlinked directory still
 * resolves to where it would actually land.
 */
function realpathBestEffort(candidatePath) {
  let current = candidatePath;
  const suffix = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidatePath; // reached the filesystem root; give up gracefully
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function touchesDataRoot({ toolName, toolInput, cwd, dataRoot }) {
  const variants = [
    dataRoot,
    dataRoot.split(path.sep).join('/'),
    '.claude/plugins/data/krylo',
    '.claude\\plugins\\data\\krylo',
    // The multi-host Foundation's generic (non-Claude-specific) data-root
    // fallback (scripts/lib/paths.mjs::getDataRoot()) -- covered both as a
    // relative fragment and, for Bash, via home-shorthand expansion below.
    '.krylo/data',
    '.krylo\\data',
    'current-run.json',
    'wrapper-config.json',
  ].map((v) => v.toLowerCase());

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');

  // Bash and PowerShell are separate Claude Code tool names (confirmed
  // against official Hook documentation, ADR-0022) but both carry the actual
  // shell command in tool_input.command -- a risky command must be caught
  // identically regardless of which shell Claude chose to invoke it through.
  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command ?? '').toLowerCase();
    if (variants.some((v) => command.includes(v))) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => variants.some((v) => e.toLowerCase().includes(v)));
  }

  const target = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.notebook_path === 'string'
      ? input.notebook_path
      : '';
  if (target === '') return false;
  const lower = target.toLowerCase();
  if (variants.some((v) => lower.includes(v))) return true;
  try {
    const resolved = path.resolve(cwd || process.cwd(), target).toLowerCase();
    const rootLower = path.resolve(dataRoot).toLowerCase();
    if (resolved === rootLower || resolved.startsWith(rootLower + path.sep.toLowerCase())) return true;
    // path.resolve() alone never follows symlinks: a symlink outside the
    // data root that points into it would otherwise escape this check, even
    // though writing through it lands inside the data root for real. Resolve
    // both sides through any symlinks (best-effort for a target that does
    // not exist yet, e.g. a new file about to be created) before the final
    // comparison.
    const realResolved = realpathBestEffort(path.resolve(cwd || process.cwd(), target)).toLowerCase();
    const realRoot = realpathBestEffort(path.resolve(dataRoot)).toLowerCase();
    return realResolved === realRoot || realResolved.startsWith(realRoot + path.sep.toLowerCase());
  } catch {
    return false;
  }
}

export const PLUGIN_INSTALLATION_REASON =
  'The KRYLO plugin\'s own installed files (hooks, security policy, run skill) are integrity-protected while a ' +
  'KRYLO run is active. A model must not be able to disable a hook or weaken policy by editing the plugin\'s ' +
  'own installed source. Ask a human to change the plugin installation directly.';

export const SECURITY_CONFIG_WEAKENING_REASON =
  'Claude Code\'s own permission/hook configuration is integrity-protected while a KRYLO run is active. ' +
  'A model must not be able to silently weaken enforcement (add an allow rule, remove a hook, enable ' +
  'bypassPermissions) by writing to its own settings files. Ask a human to change this configuration directly.';

/**
 * Claude Code's own settings files control the exact enforcement surface
 * this checkpoint (docs/adr/0025-native-permission-approval.md,
 * docs/adr/0027-restore-native-approval-for-all-require-approval-classes.md)
 * relies on: `permissions.allow`/`deny`/`ask` rules, `hooks.PreToolUse`
 * registration, and `defaultMode` (which could be set to `bypassPermissions`).
 * Live testing (ADR-0028) confirmed a *pre-existing* allow rule cannot
 * bypass a hook's own `ask` decision -- but nothing previously stopped the
 * model from directly WRITING a new rule, or deleting the hook registration
 * outright, via its own ordinary Write/Edit/Bash/PowerShell tools. Only
 * writes are gated (reading these files is not itself a threat, and the
 * model may legitimately need to read them to understand current config).
 *
 * The Bash/PowerShell arm is text-matching defense-in-depth, the same
 * category of limitation already documented for touchesDataRoot() and
 * touchesHookEntrypoint() above: a sufficiently indirect invocation
 * (`cd .claude && echo x > settings.json`, a shell variable holding the
 * filename, base64/encoded writes) is not caught by design. It raises the
 * bar for an unsophisticated attempt; it is not a guarantee against every
 * possible obfuscation.
 */
const HOST_SETTINGS_FILENAMES = ['settings.json', 'settings.local.json'];

function touchesClaudeSettings({ toolName, toolInput, cwd }) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');

  const pathFragments = HOST_SETTINGS_FILENAMES.flatMap((f) => [
    `.claude/${f}`,
    `.claude\\${f}`,
  ]).map((v) => v.toLowerCase());

  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command ?? '').toLowerCase();
    if (pathFragments.some((v) => command.includes(v))) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => pathFragments.some((v) => e.toLowerCase().includes(v)));
  }

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const target = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : '';
    if (target === '') return false;
    // Independent review found the prior version matched the RAW target
    // string, never resolved -- so `.claude/./settings.json`,
    // `.claude//settings.json`, `.claude/x/../settings.json`, and an NTFS
    // alternate-data-stream suffix (`settings.json::$DATA`, a distinct
    // stream of the SAME file on Windows) all evaded it while still
    // landing on the real file. Strip a trailing `::<stream>` suffix, expand
    // a leading `~` the same way Bash command text already is elsewhere in
    // this file, then resolve through `.`/`..`/double-separators before
    // comparing the basename and immediate parent directory name -- the
    // same resolve-then-compare shape `touchesDataRoot()` and
    // `touchesPluginInstallation()` already use.
    const withoutAds = target.replace(/::[^\\/]*$/, '');
    const tildeExpanded = /^~[/\\]/.test(withoutAds)
      ? path.join(os.homedir(), withoutAds.slice(2))
      : withoutAds;
    try {
      const resolved = path.resolve(cwd || process.cwd(), tildeExpanded).toLowerCase();
      const base = path.basename(resolved);
      const parentBase = path.basename(path.dirname(resolved));
      return parentBase === '.claude' && HOST_SETTINGS_FILENAMES.some((f) => base === f.toLowerCase());
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Deny a Bash or PowerShell command that directly executes a KRYLO Hook
 * entrypoint (see HOOK_ENTRYPOINT_FILENAMES above). Only these two shell
 * tools are checked: a Hook entrypoint being merely read/opened via
 * Write/Edit's file_path is not itself a dangerous execution, and
 * touchesDataRoot() already protects the data it would mutate.
 */
function touchesHookEntrypoint({ toolName, toolInput }) {
  const name = String(toolName ?? '');
  if (name !== 'Bash' && name !== 'PowerShell') return false;
  const command = typeof toolInput?.command === 'string' ? toolInput.command.toLowerCase() : '';
  if (command === '') return false;
  return HOOK_ENTRYPOINT_FILENAMES.some((filename) => command.includes(filename.toLowerCase()));
}

/**
 * The KRYLO plugin's own INSTALLED files (hook entrypoints, production/MCP
 * policy JSON, the run skill's own hook-registration frontmatter) must not
 * be writable by the model, for the same reason the data root is protected:
 * a model that could edit its own gate's source or policy could disable or
 * weaken enforcement for the rest of the run. Scoped to `pluginRoot` (the
 * actual INSTALLED plugin location a real host adapter resolves from its
 * own host-specific plugin-root signal) rather than matching filenames like risk-gate.mjs
 * anywhere -- KRYLO's own SOURCE repository (where this exact file is
 * developed) is a completely different path from where a host installs the
 * plugin for actual use, so this does not block legitimate KRYLO-on-itself
 * development, only a running instance's actual enforcement surface.
 */
function touchesPluginInstallation({ toolName, toolInput, cwd, pluginRoot }) {
  if (typeof pluginRoot !== 'string' || pluginRoot.trim() === '') return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');
  const rootLower = path.resolve(pluginRoot).toLowerCase();

  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command ?? '').toLowerCase();
    if (command === '') return false;
    if (command.includes(rootLower)) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => e.toLowerCase().includes(rootLower));
  }

  if (name !== 'Write' && name !== 'Edit' && name !== 'NotebookEdit') return false;
  const target = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.notebook_path === 'string'
      ? input.notebook_path
      : '';
  if (target === '') return false;
  try {
    const resolved = path.resolve(cwd || process.cwd(), target).toLowerCase();
    return resolved === rootLower || resolved.startsWith(rootLower + path.sep.toLowerCase());
  } catch {
    return false;
  }
}

function loadPolicy() {
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  return JSON.parse(raw);
}

function firstMatchingClass(policy, command) {
  const normalized = String(command).replace(/\s+/g, ' ');
  // git-force is a specialization of git-push; test it before git-push so the
  // more specific class wins.
  const order = Object.keys(policy.approvalClasses).sort((a, b) => (a === 'git-force' ? -1 : b === 'git-force' ? 1 : 0));
  for (const className of order) {
    const cls = policy.approvalClasses[className];
    for (const pattern of cls.patterns) {
      if (new RegExp(pattern, 'i').test(normalized)) {
        return { className, reason: cls.reason };
      }
    }
  }
  return null;
}

// Foundation final-closure checkpoint: `.env.example`, `.env.sample`, and
// equivalent intentionally-shareable environment templates are conventional,
// public, non-secret files -- committed to version control on purpose, to
// document which variables a real .env needs -- yet the sensitivePaths
// `.env` pattern's own boundary alternation (`$|\.|[\\/]`) matches ANY
// `.env.<anything>`, including these, treating a routine template read the
// same as a real secret. This exception is intentionally narrow: only the
// specific, well-known template suffixes below are exempted, matched at a
// full path-segment boundary (so `.env.example` is exempt but
// `.env.example.secret` or `config/.env.example/real-secret` is not).
// Independent security review found the original trailing boundary
// (`$|[\\/]`) let the exception match ANYWHERE in the string, not only at
// the very end -- so `.env.example/../.env` matched the exception (exempting
// the WHOLE string from the sensitive-path check) while the resolved target
// was actually the real `.env`, a genuine secret-leak path-traversal bypass
// reproduced end to end. Anchored to end-of-string only: the template
// filename must be the FINAL path component, nothing after it (not even a
// further path segment), so a bare `.env.example` or `config/.env.example`
// is still exempt, but `.env.example/../.env` or `config/.env.example/
// real-secret` is not -- it falls through to the normal sensitivePaths
// check, which correctly still matches the literal `.env` occurring later.
const ENV_TEMPLATE_EXCEPTION = /(^|[\\/])\.env\.(example|sample|template|dist|defaults)$/i;

function matchesSensitivePath(policy, text) {
  if (typeof text !== 'string' || text === '') return false;
  if (ENV_TEMPLATE_EXCEPTION.test(text)) return false;
  return policy.sensitivePaths.patterns.some((p) => new RegExp(p, 'i').test(text));
}

/**
 * Sensitive-path patterns are anchored to path boundaries, so a command like
 * `cat .env` must be checked token-by-token as well as whole-string (for
 * embedded paths like `cat ./config/.env`).
 */
function commandTouchesSensitivePath(policy, command) {
  if (matchesSensitivePath(policy, command)) return true;
  return String(command)
    .split(/[\s;|&<>()]+/)
    .filter((t) => t !== '')
    .some((token) => matchesSensitivePath(policy, token));
}

/**
 * Classify one tool call against KRYLO's shared risk policy. Host-neutral:
 * takes a plain { toolName, toolInput, cwd, dataRoot } input and returns one
 * of:
 *
 *   { action: 'pass', category: 'pass' | 'mcp-pass' }
 *   { action: 'deny', category: '<policy-class>', reason: '...' }
 *   { action: 'require-approval', category: '<actionClass>', actionClass: '<actionClass>', reason: '...' }
 *
 * Never throws for a well-formed input; never calls process.exit or writes
 * to stdout. A caller must catch and fail toward its own safe default (a
 * deterministic deny, not an unconfirmed-safe "ask") for a malformed input
 * (missing/invalid dataRoot, unreadable policy file, etc).
 */
export function classifyRiskAction({ toolName, toolInput, cwd, dataRoot, pluginRoot } = {}) {
  const name = String(toolName ?? '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const resolvedDataRoot = typeof dataRoot === 'string' && dataRoot.trim() !== '' ? dataRoot : getDataRoot();
  const policy = loadPolicy();

  // Independent security review measured that production-policy.json's
  // multi-segment lazy-quantifier regex patterns (matched against the full
  // Bash command text) scale superlinearly with input size -- ~25 seconds
  // at the 1MB stdin ceiling readStdinJson() otherwise allows, close enough
  // to a real PreToolUse Hook timeout budget to be a genuine availability
  // risk (and, if a host's actual timeout behavior for an unresponsive Hook
  // ever turns out to be permissive, a fail-open risk too). No legitimate
  // Bash command a model constructs needs to be anywhere near this long;
  // deny outright rather than attempting to classify (never merely
  // truncate before matching, which could hide a real dangerous command
  // that happens to appear later in an otherwise-padded string).
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string' && input.command.length > MAX_BASH_COMMAND_LENGTH) {
    return { action: 'deny', category: 'oversized-command', reason: OVERSIZED_COMMAND_REASON };
  }

  if (touchesDataRoot({ toolName: name, toolInput: input, cwd, dataRoot: resolvedDataRoot })) {
    return { action: 'deny', category: 'data-root-protection', reason: DATA_ROOT_REASON };
  }

  if (touchesHookEntrypoint({ toolName: name, toolInput: input })) {
    return { action: 'deny', category: 'hook-entrypoint-protection', reason: HOOK_ENTRYPOINT_REASON };
  }

  if (touchesClaudeSettings({ toolName: name, toolInput: input, cwd })) {
    return { action: 'deny', category: 'security-config-protection', reason: SECURITY_CONFIG_WEAKENING_REASON };
  }

  if (touchesPluginInstallation({ toolName: name, toolInput: input, cwd, pluginRoot })) {
    return { action: 'deny', category: 'plugin-installation-protection', reason: PLUGIN_INSTALLATION_REASON };
  }

  if (name === 'Bash' || name === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : '';

    if (commandTouchesSensitivePath(policy, command)) {
      return {
        action: 'deny',
        category: 'sensitive-path',
        reason: `${policy.sensitivePaths.reason} This command touches a protected secret path.`,
      };
    }

    const match = firstMatchingClass(policy, command);
    if (match) {
      return { action: 'require-approval', category: match.className, actionClass: match.className, reason: match.reason };
    }

    return { action: 'pass', category: 'pass' };
  }

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const target = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : '';
    if (matchesSensitivePath(policy, target)) {
      return {
        action: 'deny',
        category: 'sensitive-path',
        reason: `${policy.sensitivePaths.reason} This file target is a protected secret path.`,
      };
    }
    return { action: 'pass', category: 'pass' };
  }

  // Independent security review found that reading a protected secret path
  // was denied via Bash (`cat .env`) and via Write/Edit's file_path, but not
  // via the Read/Glob/Grep tools at all -- SKILL.md's risk-gate matcher did
  // not even list them, so a model blocked on `cat .env` could simply
  // switch tools and read the same file through Read() unimpeded. Same
  // check as Write/Edit/NotebookEdit above, against every path-shaped field
  // each of these tools actually carries -- a second independent review
  // round found the first fix checked only `file_path`/`path`, which is
  // Read's real shape but not Grep's or Glob's: Grep's real schema is
  // `{pattern, path?, glob?, output_mode, ...}` (`pattern` is the content
  // regex being searched FOR, not a path, and must not be checked here --
  // only `path`/`glob` are path-shaped) and Glob's is `{pattern, path?}`
  // (Glob's `pattern` IS a file-glob, so it is path-shaped there). Before
  // this fix, `Grep(pattern: '.', glob: '**/.env', output_mode: 'content')`
  // (returning file *contents*) and `Glob(pattern: '**/.env')` (disclosing
  // secret-file locations) both bypassed this check entirely -- reproduced
  // end to end by two independent reviewers. Every path-shaped field each
  // tool actually carries is checked now, so a secret path cannot be
  // reached through any of them.
  if (name === 'Read' || name === 'Glob' || name === 'Grep') {
    const candidates = name === 'Read'
      ? [input.file_path]
      : name === 'Glob'
        ? [input.path, input.pattern]
        : [input.path, input.glob]; // Grep: never input.pattern (a content regex, not a path)
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '' && matchesSensitivePath(policy, candidate)) {
        return {
          action: 'deny',
          category: 'sensitive-path',
          reason: `${policy.sensitivePaths.reason} This read target is a protected secret path.`,
        };
      }
    }
    return { action: 'pass', category: 'pass' };
  }

  if (isMcpToolName(name)) {
    const match = classifyMcpTool(name);
    if (match) {
      // A malformed tool-name shape or an unknown/blocked MCP server has no
      // identity a human could meaningfully approve or deny -- KRYLO's own
      // `deny`/`require-approval` distinction (restore-native-approval
      // checkpoint) puts these on the `deny` side, never routed through the
      // native ask prompt just because MCP tools became ask-eligible for
      // their genuine, identified require-approval write classes.
      if (match.hardDeny) {
        return { action: 'deny', category: match.className, reason: match.reason };
      }
      return { action: 'require-approval', category: match.className, actionClass: match.className, reason: match.reason };
    }
    return { action: 'pass', category: 'mcp-pass' };
  }

  return { action: 'pass', category: 'pass' };
}
