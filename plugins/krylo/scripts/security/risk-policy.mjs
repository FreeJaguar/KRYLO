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
 * outright, via its own ordinary Write/Edit/Bash/PowerShell tools.
 *
 * The Write/Edit/NotebookEdit arm below gates only a genuine write to the
 * resolved settings file -- reading it via Read/Glob/Grep is not itself a
 * threat, and the model may legitimately need to read it to understand
 * current config, so those tools are deliberately not checked here at all.
 *
 * The Bash/PowerShell arm cannot make that same read/write distinction: it
 * is a plain text-matching check over the whole command string, so a
 * read-only command that merely mentions the settings path (`cat
 * .claude/settings.json`) is denied exactly like a write (`echo x >
 * .claude/settings.json`) would be. This is the same category of limitation
 * already documented for touchesDataRoot() and touchesHookEntrypoint()
 * above, just biased toward over-blocking instead of under-blocking: a
 * sufficiently indirect invocation (`cd .claude && echo x > settings.json`,
 * a shell variable holding the filename, base64/encoded writes) still is
 * not caught, while an innocuous read that merely names the file is. It
 * raises the bar for an unsophisticated attempt; it is neither a guarantee
 * against every possible obfuscation nor free of false positives.
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
      const resolved = path.resolve(cwd || process.cwd(), tildeExpanded);
      const check = (candidate) => {
        const lower = candidate.toLowerCase();
        const base = path.basename(lower);
        const parentBase = path.basename(path.dirname(lower));
        return parentBase === '.claude' && HOST_SETTINGS_FILENAMES.some((f) => base === f.toLowerCase());
      };
      if (check(resolved)) return true;
      // A directory symlink/junction whose NAME is not literally ".claude"
      // (e.g. `cfg -> .claude`) passes the raw check above but still lands
      // on the real settings file once the OS resolves it. realpathBestEffort
      // mirrors touchesDataRoot()'s own symlink handling, including its
      // best-effort behavior for a target file that does not exist yet.
      return check(realpathBestEffort(resolved));
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
 * own host-specific plugin-root signal) rather than matching filenames like
 * risk-gate.mjs anywhere -- a real Claude Code session always sets its own
 * plugin-root environment variable to the installed plugin's own path, which
 * is a completely different path from KRYLO's own SOURCE repository
 * checkout, so under a real host this does not block legitimate
 * KRYLO-on-itself development. That separation is a property of how the
 * host resolves `pluginRoot` (see the host adapter's own plugin-root
 * resolver), not an unconditional guarantee of this function: if that
 * environment variable is unset (an ad-hoc script invocation rather than a
 * real Hook process), the host adapter's resolver falls back to a
 * source-relative path that, when this module runs from within KRYLO's own
 * repository, resolves to that same repository checkout -- and this check
 * would then also deny editing `plugins/krylo/**` there.
 */
function touchesPluginInstallation({ toolName, toolInput, cwd, pluginRoot }) {
  if (typeof pluginRoot !== 'string' || pluginRoot.trim() === '') return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');
  const rootLower = path.resolve(pluginRoot).toLowerCase();

  // Independent review found a Critical self-inflicted regression: an
  // earlier version of this function also scanned Bash/PowerShell command
  // TEXT for ANY reference to pluginRoot -- but `skills/run/SKILL.md`'s own
  // mandatory runtime CLI calls are literally
  // `node "<the host's plugin-root env var>/scripts/runtime/<script>.mjs"`,
  // so once that variable is expanded to a literal path (guaranteed for
  // PowerShell, common for Bash), every legitimate init-run/read-state/
  // update-state call was denied outright -- breaking KRYLO's own
  // operation with no approval path. Unlike touchesDataRoot() (whose own
  // comment states legitimate mutations "never embed the data-root path in
  // the command line"), the opposite is true for pluginRoot by
  // construction: the model is SUPPOSED to invoke scripts by that exact
  // path, so "references pluginRoot" alone is not a usable signal for
  // Bash/PowerShell the way it is for touchesDataRoot().
  //
  // A later review found that dropping the Bash/PowerShell arm entirely
  // left a real gap open: `echo x >> <pluginRoot>/policies/production-
  // policy.json` and similar mutate the exact files this check exists to
  // protect. That review's own proposed fix -- deny when the command BOTH
  // mentions pluginRoot AND matches a fixed list of "write-shaped" signals
  // (redirection, sed -i, tee, cp, mv, Set-Content, ...) -- was tried and
  // then found, by a FURTHER independent review, to be strictly worse than
  // having no Bash/PowerShell arm at all: it is simultaneously (a) a
  // Critical false-positive generator, since `>` alone also matches `->`,
  // `=>`, and `2>&1`/`1>file` inside completely unrelated, legitimate
  // command text (including KRYLO's own mandatory runtime CLI calls, whose
  // JSON evidence payloads routinely contain arrows or comparison text),
  // and `cp`/`mv` match as bare free-text substrings; and (b) still misses
  // nearly every real mutation path, since there is no finite verb list --
  // `node -e "require('fs').writeFileSync(...)"`, `perl -pi -e`,
  // `python -c "open(...,'w')"`, `dd`, `truncate`, `install`, `rsync`,
  // `ln -sf`, `curl -o`, `git checkout ... --`, PowerShell
  // `[System.IO.File]::WriteAllText(...)`, `Remove-Item`, `Rename-Item`,
  // and a flagless `rm <file>` (not even caught by the destructive-
  // operation class, which requires a recognized delete flag) all
  // classified as `pass` against the fixed list, while genuinely
  // overwriting or deleting the protected file. A regex over untokenized
  // shell text cannot answer "is this a write to file X" for an
  // interpreter-agnostic, unbounded set of write primitives -- this is a
  // structural limit of the text-matching approach used throughout this
  // module, not a gap in any one pattern. Per that review's explicit
  // recommendation, the Bash/PowerShell arm is removed rather than kept in
  // a state that is negative-value (blocks legitimate use, catches little
  // real risk) or patched into a sixth round of the same failure mode.
  // Real protection for this file-mutation threat is the Write/Edit/
  // NotebookEdit arm below (the tool surface KRYLO can reliably observe
  // and canonicalize a path from) plus the narrowly-scoped
  // touchesHookEntrypoint() above; a model using an interpreter one-liner
  // or another shell write primitive to mutate the plugin's own installed
  // files via Bash/PowerShell is a disclosed, accepted residual gap for
  // this specific tool surface (see the residual-limitations list in
  // docs/adr/0028-foundation-final-closure.md), not a closed guarantee.
  if (name !== 'Write' && name !== 'Edit' && name !== 'NotebookEdit') return false;
  const target = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.notebook_path === 'string'
      ? input.notebook_path
      : '';
  if (target === '') return false;
  try {
    const resolvedRaw = path.resolve(cwd || process.cwd(), target);
    const resolved = resolvedRaw.toLowerCase();
    if (resolved === rootLower || resolved.startsWith(rootLower + path.sep.toLowerCase())) return true;
    // Same symlink/junction handling as touchesDataRoot() and (as of this
    // review round) touchesClaudeSettings(): a directory symlink pointing
    // into the installed plugin root would otherwise let a write escape
    // this check while still landing inside it once the OS resolves it.
    const realResolved = realpathBestEffort(resolvedRaw).toLowerCase();
    const realRoot = realpathBestEffort(path.resolve(pluginRoot)).toLowerCase();
    return realResolved === realRoot || realResolved.startsWith(realRoot + path.sep.toLowerCase());
  } catch {
    return false;
  }
}

function loadPolicy() {
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  return JSON.parse(raw);
}

function firstMatchingClass(policy, command) {
  // Independent review found that collapsing a newline to a plain space
  // (like any other whitespace) erased the distinction between "one
  // command with internal whitespace" and "two separate commands" --
  // letting an unrelated preceding line (`git\nrm -rf /`, a bare two-line
  // script with no other separator at all) spoof the git/docker/npm-rm
  // exclusion below, since after collapsing it reads identically to the
  // genuine single command `git rm -rf /`. A newline is a real command
  // boundary in every shell this classifies (Bash, PowerShell), so it is
  // now normalized to an explicit separator (`;`) before other whitespace
  // is collapsed -- restoring the distinction the patterns below rely on,
  // and incidentally re-activating each pattern's own `[^|;&\n]` exclusion
  // (previously silently neutered by the plain-space collapse, since a
  // literal `\n` could never survive to be tested against by that point).
  //
  // Independent review then found a bare `\r` (no `\n` at all) still fell
  // through to the plain-whitespace collapse and re-opened the identical
  // gap -- a real statement separator in PowerShell on its own, not just as
  // part of a `\r\n` pair. `\r\n` is matched first so a Windows-style
  // line ending produces one separator, not two.
  //
  // A second independent review then found that turning EVERY newline into
  // a command separator went too far the other way: a Bash `\`-newline or
  // PowerShell backtick-newline is a LINE CONTINUATION, not a boundary --
  // it is one logical command written across multiple lines. Treating it
  // as a separator silently broke every pattern in production-policy.json
  // that excludes crossing a real separator (`[^|;&\n]*?`), turning most of
  // this checkpoint's own require-approval classes into `pass` for any
  // continued command -- a far more severe availability gap than the
  // narrow spoof this normalization exists to close. Continuations are
  // collapsed to a plain space FIRST, before any remaining bare newline is
  // turned into a separator.
  const normalized = String(command)
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .replace(/\r\n|\r|\n/g, ' ; ')
    .replace(/\s+/g, ' ');
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
  // Independent review found that touchesClaudeSettings() strips a trailing
  // NTFS alternate-data-stream suffix (`::$DATA`, a distinct stream of the
  // SAME file on Windows) before matching, but this function -- the one
  // that actually gates secret-path reads/writes -- never did, so
  // `.env::$DATA` read straight through to the real `.env` content while
  // classifying as `pass`. Stripped here so every caller (Bash/PowerShell
  // tokens, Write/Edit/NotebookEdit target, Read/Glob/Grep candidates)
  // benefits without each needing its own copy of this logic.
  const withoutAds = text.replace(/::[^\\/]*$/, '');
  // A further independent review found and confirmed, against a real
  // PowerShell process, that Windows silently ignores trailing spaces and
  // dots on a path component (`Get-Content '.env '` reads the real `.env`
  // on disk), so appending either to an otherwise-matched secret path
  // bypassed the pattern's own end-of-string anchors. Stripped the same
  // way as the ADS suffix above, before the exception and pattern checks.
  const normalized = withoutAds.replace(/[ .]+$/, '');
  if (ENV_TEMPLATE_EXCEPTION.test(normalized)) return false;
  return policy.sensitivePaths.patterns.some((p) => new RegExp(p, 'i').test(normalized));
}

/**
 * Sensitive-path patterns are anchored to path boundaries, so a command like
 * `cat .env` must be checked token-by-token as well as whole-string (for
 * embedded paths like `cat ./config/.env`).
 */
/**
 * Independent security review found the token splitter below never
 * stripped surrounding quotes, so `cat ".env"` or `cat '.env'` produced the
 * token `".env"` (quotes included) rather than `.env`, which never matched
 * the sensitivePaths patterns' own path-boundary anchors (which expect a
 * literal `.env`, not a quote character, at the start) -- a quoted
 * filename, valid and completely ordinary shell syntax, bypassed secret-
 * path protection entirely.
 *
 * A further independent review found that stripping only one matching
 * OUTER pair still left `.env""` and `"".env` (a quote-concatenation --
 * ordinary, valid shell syntax that still resolves to the literal file
 * `.env`) unmatched, since the leftover interior quote characters broke
 * the path-boundary anchors just the same. Every quote character is now
 * removed from the token, not merely a single surrounding pair. This
 * cannot re-lose the internal space the SHELL_WORD tokenizer preserves
 * inside a quoted segment (round 4's fix for `cat "my dir/.env"`): only
 * quote characters themselves are removed, and a space is not one.
 */
function stripSurroundingQuotes(token) {
  return token.replace(/["']/g, '');
}

// Splitting on whitespace before stripping quotes (the original approach)
// tears a quoted path containing an internal space in two, so neither half
// still looks like a quoted token and stripSurroundingQuotes() has nothing
// to strip -- independent review reproduced `cat "my dir/.env"` bypassing
// secret-path protection this way. This instead extracts whole shell words:
// each token is a maximal run of ordinary characters and/or fully-quoted
// segments glued together (mirroring the git-push pattern's own "shell
// word" concept above), so a quoted path keeps its internal space as part
// of ONE token. The unquoted alternative is a single character (not `+`)
// so this cannot repeat the nested-quantifier ReDoS already fixed once in
// the git-push pattern.
const SHELL_WORD = /(?:[^\s"';|&<>()]|"[^"]*"|'[^']*')+/g;

function commandTouchesSensitivePath(policy, command) {
  if (matchesSensitivePath(policy, command)) return true;
  const tokens = String(command).match(SHELL_WORD) || [];
  return tokens
    .map(stripSurroundingQuotes)
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
    if (matchesSensitivePath(policy, stripSurroundingQuotes(target))) {
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
      if (typeof candidate === 'string' && candidate !== '' && matchesSensitivePath(policy, stripSurroundingQuotes(candidate))) {
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
