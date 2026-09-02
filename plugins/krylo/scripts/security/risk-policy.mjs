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
  // Codex hook entrypoints: distinct filenames from their Claude
  // counterparts (never a bare substring of the Claude names above, e.g.
  // "risk-gate-codex.mjs" does not contain "risk-gate.mjs"), so each one
  // needs its own explicit entry or it is silently uncovered. A fresh
  // independent Security Reviewer confirmed this gap by direct invocation:
  // a model could run user-prompt-submit-codex.mjs itself with fabricated
  // stdin to forge a fresh run bootstrap -- including resurrecting a run
  // past a RISK_APPROVAL_REQUIRED/SAFE_BLOCKED halt that existed
  // specifically to force human review, with no real Codex event involved.
  'user-prompt-submit-codex.mjs',
  'risk-gate-codex.mjs',
  'permission-request-codex.mjs',
  'posttool-telemetry-codex.mjs',
  // Project-scoped hook launcher (docs/adr/0032-codex-project-scoped-hook-enforcement.md):
  // a redirector that re-executes the real scripts above -- without its own
  // entry here, a model could route around every filename check above by
  // invoking the launcher instead of the real script directly.
  'codex-project-hook-launcher.mjs',
  // Codex lifecycle enforcement (docs/adr/0033-codex-lifecycle-enforcement.md):
  // same forgery risk as every entry above -- a fabricated Stop/SessionStart/
  // SessionEnd payload run directly could probe for or mutate another
  // session's run, or bypass the real hook firing (and therefore the Orbit
  // budget check) entirely.
  'stop-gate-codex.mjs',
  'session-start-codex.mjs',
  'session-end-codex.mjs',
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

/**
 * A fresh independent Reviewer AND a fresh independent Security Reviewer
 * both found, and live-reproduced on Windows, that an earlier fix here
 * (which stripped a trailing space/dot only at the very END of the whole
 * path string) missed the identical bypass on an INTERMEDIATE component:
 * `.codex./hooks.json`, `.codex/krylo./x.mjs`, and `.claude/settings.json.`
 * all resolve to the exact real, protected file on disk (Windows silently
 * ignores a trailing space/dot on ANY path component, not just the last
 * one), while a plain end-anchored string comparison still classified them
 * `pass`. This must run AFTER path.resolve() has already collapsed every
 * `.`/`..` component -- applied any earlier, the same regex would destroy
 * a genuine `..` segment, since `..` itself is entirely dots.
 */
function stripWindowsPathComponentNoise(resolvedPath) {
  return resolvedPath.replace(/[ .]+(?=[\\/]|$)/g, '');
}

/**
 * Companion to stripWindowsPathComponentNoise() for the Bash/PowerShell
 * text-matching arms below, which search raw, free-form command text for a
 * small, FIXED set of literal path fragments (never resolved through
 * path.resolve()) -- transforming the whole command string the same way
 * the resolved-path arm does would risk mangling unrelated command text
 * that merely happens to contain "<word>. /<word>" or similar (matchesSensitivePath()'s
 * own history above documents exactly this class of false positive from an
 * over-broad text transform). Instead, this expands each FIXED fragment
 * itself into the bounded set of literal variants Windows would treat as
 * the same real path (a trailing space or dot appended to one path
 * component at a time), so only the small, known protected-path fragment
 * list grows -- arbitrary command text is never rewritten.
 */
function withWindowsTrailingNoiseVariants(fragment) {
  const parts = fragment.split(/([\\/])/); // odd indices are the separator characters themselves
  const variants = new Set([fragment]);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === '') continue;
    for (const noise of [' ', '.']) {
      const withNoise = parts.slice();
      withNoise[i] = `${withNoise[i]}${noise}`;
      variants.add(withNoise.join(''));
    }
  }
  return [...variants];
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
  ]).map((v) => v.toLowerCase()).flatMap(withWindowsTrailingNoiseVariants);

  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command ?? '').toLowerCase();
    if (pathFragments.some((v) => command.includes(v))) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => pathFragments.some((v) => e.toLowerCase().includes(v)));
  }

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'apply_patch') {
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
    // `touchesPluginInstallation()` already use. A LATER review round found
    // this still missed a trailing space/dot Windows silently ignores on a
    // path component (see stripWindowsPathComponentNoise()) -- applied to
    // the already-resolved absolute path below.
    const withoutAds = target.replace(/::[^\\/]*$/, '');
    const tildeExpanded = /^~[/\\]/.test(withoutAds)
      ? path.join(os.homedir(), withoutAds.slice(2))
      : withoutAds;
    try {
      const rawResolved = path.resolve(cwd || process.cwd(), tildeExpanded);
      const resolved = stripWindowsPathComponentNoise(rawResolved);
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
      return check(stripWindowsPathComponentNoise(realpathBestEffort(rawResolved)));
    } catch {
      return false;
    }
  }

  return false;
}

// docs/adr/0032-codex-project-scoped-hook-enforcement.md's project-scoped
// Codex hook files. Unlike every other KRYLO-owned file this module
// protects, these live INSIDE a user's own project tree (install-codex.mjs
// --target hooks writes <project>/.codex/hooks.json, its ownership
// sidecar, and the launcher directory) and are the actual PreToolUse
// enforcement boundary for a standalone Codex session -- a fresh
// independent Security Reviewer found and reproduced that neither was
// protected at all: a model could Write a no-op replacement over the
// launcher, or Write `{}` over hooks.json, both classified `pass`, and a
// PreToolUse hook that fails to emit valid output is confirmed to fail
// OPEN on the current stable Codex release (docs/codex-capability-matrix.md)
// -- a silent, total enforcement bypass for the rest of the session.
const CODEX_PROJECT_HOOK_FILES = ['hooks.json', 'krylo-hooks-meta.json'];

function touchesCodexProjectHooks({ toolName, toolInput, cwd }) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName ?? '');

  const pathFragments = [
    ...CODEX_PROJECT_HOOK_FILES.flatMap((f) => [`.codex/${f}`, `.codex\\${f}`]),
    '.codex/krylo/',
    '.codex\\krylo\\',
  ].map((v) => v.toLowerCase()).flatMap(withWindowsTrailingNoiseVariants);

  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command ?? '').toLowerCase();
    if (pathFragments.some((v) => command.includes(v))) return true;
    const expanded = homeExpandedVariants(command, os.homedir());
    return expanded.some((e) => pathFragments.some((v) => e.toLowerCase().includes(v)));
  }

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'apply_patch') {
    const target = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : '';
    if (target === '') return false;
    // Same normalization discipline as touchesClaudeSettings() above: strip
    // an NTFS alternate-data-stream suffix, expand a leading `~`, then
    // resolve through `.`/`..`/double-separators (and a best-effort symlink
    // resolution) before comparing -- never match the raw string. A
    // trailing space/dot Windows silently ignores on ANY path component
    // (not just the final one -- see stripWindowsPathComponentNoise()) is
    // stripped from the already-resolved absolute path below, not here.
    const withoutAds = target.replace(/::[^\\/]*$/, '');
    const tildeExpanded = /^~[/\\]/.test(withoutAds)
      ? path.join(os.homedir(), withoutAds.slice(2))
      : withoutAds;
    try {
      const rawResolved = path.resolve(cwd || process.cwd(), tildeExpanded);
      const resolved = stripWindowsPathComponentNoise(rawResolved);
      const check = (candidate) => {
        const lower = candidate.toLowerCase().replace(/\\/g, '/');
        const base = path.basename(lower);
        const parentBase = path.basename(path.dirname(lower));
        if (parentBase === '.codex' && CODEX_PROJECT_HOOK_FILES.some((f) => base === f.toLowerCase())) return true;
        // Anything under .codex/krylo/ (the launcher directory) at any
        // depth, not just its top-level files.
        const segments = lower.split('/');
        const codexIdx = segments.lastIndexOf('.codex');
        return codexIdx !== -1 && segments[codexIdx + 1] === 'krylo';
      };
      if (check(resolved)) return true;
      return check(stripWindowsPathComponentNoise(realpathBestEffort(rawResolved)));
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
  if (name !== 'Write' && name !== 'Edit' && name !== 'NotebookEdit' && name !== 'apply_patch') return false;
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

// Codex's apply_patch tool carries potentially MULTIPLE file targets inside
// its own unified-diff-like `patch` text, not a single file_path field the
// way Write/Edit/NotebookEdit have one -- real apply_patch payloads use
// `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File:
// <path>` / `*** Move to: <path>` (a rename destination) header lines.
// Extracting every one lets classifyRiskAction() run the SAME hard-deny/
// sensitive-path protection those tools already get against apply_patch
// too. A fresh independent review found this was previously entirely
// missing: apply_patch had no case anywhere in this file, so it silently
// fell through to the unconditional final `pass` any genuinely unrecognized
// tool name reaches -- a real, reproduced .env read/write/exfiltration
// bypass, not a hypothetical gap.
function extractApplyPatchTargets(patchText) {
  if (typeof patchText !== 'string') return [];
  const targets = [];
  const headerRe = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  let match;
  while ((match = headerRe.exec(patchText)) !== null) {
    const target = match[1].trim();
    if (target !== '') targets.push(target);
  }
  return targets;
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
  //
  // A sixth review round then found this introduced its own false
  // positive: applying the trim unconditionally exposed ordinary free
  // text ending in a real extension to the extension-only patterns
  // (`.pem`/`.key`/...), which -- unlike the `.env`/`id_rsa` patterns --
  // are not anchored to a path-start boundary. `git commit -m "regenerate
  // cert.pem."` denied outright, though it never referenced an actual
  // path. Scoped the trim to when it would not be masking ordinary prose:
  // only applied when the FINAL path component (after any separator),
  // once trimmed, has no remaining internal space -- true for a genuine
  // bare file reference (`.env `) or a real path whose filename segment
  // has no space (`my dir/.env.`), false for a free-text sentence.
  const trimmedTrailing = withoutAds.replace(/[ .]+$/, '');
  const lastSep = Math.max(trimmedTrailing.lastIndexOf('/'), trimmedTrailing.lastIndexOf('\\'));
  const lastSegment = lastSep >= 0 ? trimmedTrailing.slice(lastSep + 1) : trimmedTrailing;
  const normalized = lastSegment.includes(' ') ? withoutAds : trimmedTrailing;
  if (ENV_TEMPLATE_EXCEPTION.test(normalized)) return false;
  return policy.sensitivePaths.patterns.some((p) => new RegExp(p, 'i').test(normalized));
}

// -----------------------------------------------------------------------
// Foundation glob-closure checkpoint: matchesSensitivePath() above (kept
// exactly as-is, per this checkpoint's own instruction to preserve the
// existing exact matcher) only recognizes a LITERAL secret filename. A
// filesystem glob expression -- Bash/PowerShell `*`, `?`, `[...]` bracket
// classes, or a Glob/Grep path-shaped field -- that EXPANDS, at shell/tool
// level, to that exact same name was not recognized at all: `cat .e*` in a
// directory containing a real `.env` reads it identically to `cat .env`,
// but the sensitivePaths regexes require the literal text `.env`, not a
// wildcard that merely resolves to it.
//
// Rather than adding one more regex per reported example (which the task
// this fix answers explicitly asks not to do, and which drifts further
// from correct with every new example), this implements a small, bounded,
// deterministic glob-matching primitive and reuses it against the SAME
// canonical protected names/extensions the policy already declares
// (policies/production-policy.json's new `globProtectedPaths`/
// `globProtectedExtensions` fields) -- one shared algorithm, not one
// regex alternative per bypass.
//
// Design, bounded and ReDoS-free by construction:
//   1. Parse a glob string into ATOMS (`lit`, `any` from `?`, `class` from
//      a `[...]` bracket expression, `star` from one-or-more consecutive
//      `*`) in a single linear pass -- O(pattern length), no backtracking.
//   2. Match an atom sequence against a literal target using the classic
//      ITERATIVE two-pointer wildcard-matching algorithm (the same shape
//      as the well-known bounded `fnmatch`/wildcard-match algorithms):
//      O(atoms.length * literal.length), no recursion, no exponential
//      blowup regardless of how many `*`/`?`/class atoms the pattern has.
//      Crucially, `literal` here is always one of KRYLO's OWN short,
//      fixed canonical protected names (".env", "id_rsa", ".pem", ...),
//      never attacker-controlled length -- so this stays fast no matter
//      how long the ATTACKER's glob pattern is.
//   3. For the sensitive-EXTENSION family (any name ending in `.pem` etc,
//      not one fixed literal), search for a split point where a SUFFIX of
//      the pattern's atoms fully matches the extension literal -- bounded
//      to the last `MAX_SUFFIX_SEARCH_ATOMS` atoms (a real extension glob
//      never needs more trailing "wiggle room" than that; consecutive `*`
//      already collapse to one atom during parsing, so this bound does
//      not depend on the attacker's overall pattern length).
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// A fresh, focused review of the whole glob-closure feature found the
// ROOT design flaw underlying several of the fixes above: every analysis
// bound (brace branches, brace-branch length, brace groups, total
// brace-expanded candidates, bracket-class character budget, bracket-
// class count per pattern) treated "budget exceeded" as either an inert
// literal (the text is left unexpanded, then almost certainly matches
// nothing) or a silently-truncated result (a bracket class missing some
// of its real characters) -- both of which resolve to a silent NO_MATCH
// when the TRUE, unbounded analysis might have found a match. That is
// fail-open: an attacker only has to exceed whichever budget is smallest
// to make KRYLO analyze nothing and pass. Concretely, a brace group with
// 33 branches (one over MAX_BRACE_BRANCHES) including "env" was
// classified `pass`, even though real Bash still expands it and includes
// `.env`.
//
// The functions below are refactored around an explicit TRI-STATE
// result: MATCH, NO_MATCH, or INDETERMINATE. classifyRiskAction's own
// isSensitivePath() maps MATCH and INDETERMINATE alike to a deny -- an
// attacker-controlled complexity/budget limit must never turn into pass.
// Every bound below still exists and is still enforced (this remains
// bounded, ReDoS-free, deterministic analysis of ordinary, in-scope glob
// syntax, not a general shell interpreter); what changed is only what
// happens when a bound is actually hit: fail-safe deny, not silent pass.
// -----------------------------------------------------------------------
const MAX_CLASS_SET_SIZE = 512;
// A realistic glob for one of KRYLO's own protected names never needs
// anywhere near this many bracket-class occurrences; caps the cost of
// MANY of them back to back within one segment (each individually
// bounded by MAX_CLASS_SET_SIZE, but with no prior limit on how many a
// single segment could contain) directly at the source, benefiting every
// caller uniformly. Scoped to CLASS atoms specifically, not the pattern's
// overall atom count: a long run of plain literal/any/star atoms (with no
// bracket classes at all) is already O(1) per atom and does not need the
// same cap -- capping total atoms indiscriminately would truncate parsing
// before reaching a legitimate trailing extension in a pattern with a
// long literal prefix.
const MAX_CLASS_ATOMS_PER_PATTERN = 32;
const MAX_BRACE_BRANCHES = 32;
const MAX_BRACE_BRANCH_LENGTH = 128;
// Bound MULTI-group brace expansion (e.g. `.e{n,m}{v,w}`) so two or more
// groups cannot multiply into a combinatorial explosion of candidates.
const MAX_BRACE_GROUPS = 4;
const MAX_TOTAL_BRACE_CANDIDATES = 64;

// Parses a glob pattern into atoms. Returns `{ atoms, indeterminate }`:
// `indeterminate` is true whenever an analysis budget below was actually
// exhausted with real, unexamined pattern content remaining -- meaning
// the returned atoms are a known-INCOMPLETE picture of the pattern, not a
// confident "this is genuinely all there is to it". A caller that gets
// back `indeterminate: true` must treat the overall result as
// INDETERMINATE (fail-safe deny) rather than trusting a NO_MATCH computed
// from incomplete atoms, which is exactly the fail-open shape a fresh
// review found: a bracket-class budget cutoff could silently exclude the
// one character that would have made a real match, turning a true MATCH
// into an false NO_MATCH.
function parseGlobAtoms(pattern) {
  const atoms = [];
  let i = 0;
  let classAtomCount = 0;
  let indeterminate = false;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      atoms.push({ type: 'star' });
      i += 1;
      while (i < pattern.length && pattern[i] === '*') i += 1; // collapse consecutive '*'
    } else if (ch === '?') {
      atoms.push({ type: 'any' });
      i += 1;
    } else if (ch === '[' && classAtomCount >= MAX_CLASS_ATOMS_PER_PATTERN) {
      // Already at the per-pattern bracket-class budget. A legitimate
      // glob for a protected name never needs more than a handful of
      // bracket classes, but we genuinely do not know what this one would
      // have contributed -- flag indeterminate rather than silently
      // treating '[' as an inert literal character (which previously let
      // the pattern fall through to a confident, but potentially wrong,
      // NO_MATCH).
      indeterminate = true;
      atoms.push({ type: 'lit', ch: '[' });
      i += 1;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        // No closing ']' -- an unterminated bracket expression is not a
        // valid glob class in any supported shell either; treating the
        // '[' as a literal character here matches real shell behavior
        // exactly, not merely a convenient truncation.
        atoms.push({ type: 'lit', ch: '[' });
        i += 1;
        continue;
      }
      classAtomCount += 1;
      let body = pattern.slice(i + 1, close);
      let negate = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      const set = new Set();
      let j = 0;
      let classIndeterminate = false;
      // A bracket class needing more than MAX_CLASS_SET_SIZE distinct
      // characters has no realistic legitimate use in this policy's
      // protected-name matching, so this remains bounded -- but unlike an
      // earlier version, exhausting the budget WITH BODY STILL REMAINING
      // now flags the whole analysis indeterminate (fail-safe deny)
      // instead of silently matching against only the characters that
      // happened to fit before the cutoff.
      while (j < body.length) {
        if (set.size >= MAX_CLASS_SET_SIZE) {
          classIndeterminate = true;
          break;
        }
        // A bounded range (a-z): expand up to 1024 code points per range
        // so a pathological range spec cannot itself become a cost sink.
        // If the range itself would need more than that many code points,
        // the same indeterminate flag applies -- we do not know whether
        // the true (unbounded) range would have included a decisive
        // character beyond the 1024 we examined.
        if (body[j + 1] === '-' && j + 2 < body.length) {
          const lo = Math.min(body.charCodeAt(j), body.charCodeAt(j + 2));
          const hi = Math.max(body.charCodeAt(j), body.charCodeAt(j + 2));
          let c = lo;
          for (; c <= hi && c - lo < 1024 && set.size < MAX_CLASS_SET_SIZE; c += 1) {
            set.add(String.fromCharCode(c).toLowerCase());
          }
          if (c <= hi) classIndeterminate = true;
          j += 3;
        } else {
          set.add(body[j].toLowerCase());
          j += 1;
        }
      }
      if (classIndeterminate) indeterminate = true;
      atoms.push({ type: 'class', set, negate });
      i = close + 1;
    } else {
      atoms.push({ type: 'lit', ch: ch.toLowerCase() });
      i += 1;
    }
  }
  return { atoms, indeterminate };
}

function atomMatchesChar(atom, ch) {
  const c = ch.toLowerCase();
  if (atom.type === 'lit') return atom.ch === c;
  if (atom.type === 'any') return true;
  if (atom.type === 'class') {
    const inSet = atom.set.has(c);
    return atom.negate ? !inSet : inSet;
  }
  return false;
}

// Classic bounded wildcard matching: iterative, two-pointer, tracking the
// most recent `star` atom to retry from on a mismatch. O(atoms.length *
// literal.length) worst case; no recursion, no exponential backtracking.
function globAtomsMatchLiteral(atoms, literal) {
  let ai = 0;
  let li = 0;
  let starAtomIdx = -1;
  let starLiteralIdx = 0;
  const atomCount = atoms.length;
  const literalLength = literal.length;
  while (li < literalLength) {
    if (ai < atomCount && atoms[ai].type !== 'star' && atomMatchesChar(atoms[ai], literal[li])) {
      ai += 1;
      li += 1;
    } else if (ai < atomCount && atoms[ai].type === 'star') {
      starAtomIdx = ai;
      starLiteralIdx = li;
      ai += 1; // try matching zero characters with the star first
    } else if (starAtomIdx !== -1) {
      ai = starAtomIdx + 1;
      starLiteralIdx += 1;
      li = starLiteralIdx; // star absorbs one more character, retry
    } else {
      return false;
    }
  }
  while (ai < atomCount && atoms[ai].type === 'star') ai += 1; // trailing stars match empty
  return ai === atomCount;
}

// A candidate glob made ENTIRELY of star atoms (`*`, `**`, `***`, all
// collapse to one star atom) carries no specific-name signal at all -- a
// lone star fully matches ANY literal, so without this guard `cat *`
// would "match" every single protected name and extension in the policy,
// denying the single most ordinary wildcard command there is. This is
// exactly the over-blocking the task this checkpoint answers explicitly
// warns against ("do NOT solve this by denying every command containing
// `*`"): a bare wildcard is not attempting to spell out a specific
// protected name the way `.e*`/`id_rsa*`/`*.pem` are (each of those has
// real literal/class content alongside its wildcard).
function hasDiscriminatingContent(atoms) {
  return atoms.some((atom) => atom.type !== 'star');
}

// Takes ALREADY-PARSED atoms rather than a raw string and re-parsing here:
// independent review found each candidate segment was being re-parsed
// from scratch once per globProtectedPaths entry PLUS once per protected
// extension (roughly 22 times per segment in the shipped policy), which,
// stacked with a bracket-class-heavy segment repeated across up to
// MAX_BRACE_BRANCHES brace-expanded candidates, multiplied into hundreds
// of millions of redundant Set operations and a 40-60 second stall --
// FAR worse than the stall this same fix round's MAX_CLASS_SET_SIZE bound
// was meant to close, since that bound only limits the cost of a SINGLE
// parse, not how many times the same segment gets re-parsed. Parsing each
// segment exactly once (in globCouldTargetSensitivePath, below) and
// reusing the atoms across every check removes that multiplier entirely.
//
// This is a plain, unconditional discriminating-content-required match --
// the "one segment of a multi-segment protected path may instead be a
// bare wildcard" relaxation lives directly in globCouldTargetSensitivePath's
// own loop (which has the context -- how many OTHER segments already
// matched strictly -- that this single-segment function does not), not
// here.
function atomsMatchLiteral(atoms, literalSegment) {
  if (!hasDiscriminatingContent(atoms)) return false;
  return globAtomsMatchLiteral(atoms, literalSegment.toLowerCase());
}

// Does some SUFFIX of the atoms (as a glob) fully match suffixLiteral
// (e.g. ".pem")? Independent review found the original version bounded
// this search to a fixed MAX_SUFFIX_SEARCH_ATOMS=64 window -- a genuine
// fail-open risk if a pattern could ever need more trailing "wiggle room"
// than that. This version is PROVABLY COMPLETE instead of merely
// generously bounded, with no arbitrary constant at all: walking k
// backward from atoms.length, every non-star atom included in the slice
// mandatorily consumes exactly one character of the (fixed-length)
// target literal -- so once the running count of non-star atoms in the
// slice exceeds the target's own length, that slice (and, since the
// count only grows as k decreases, every slice for a SMALLER k too) is
// mathematically impossible to match, and the search can stop. This
// naturally bounds total cost to roughly the target length (a handful of
// atoms for the longest protected extension) regardless of how long or
// complex the attacker's overall pattern is, without ever needing to
// guess whether a match might exist further back.
//
// (Also fixes the earlier discriminating-content guard bug: `build*`
// previously matched via the degenerate trailing-star-only slice, which
// by itself carries no discriminating signal even though the pattern as
// a whole plainly does -- the guard below is checked per slice, not once
// against the whole pattern.)
function atomsMatchExtensionSuffix(atoms, suffixLiteral) {
  const literal = suffixLiteral.toLowerCase();
  let nonStarCount = 0;
  for (let k = atoms.length; k >= 0; k -= 1) {
    if (k < atoms.length && atoms[k].type !== 'star') {
      nonStarCount += 1;
      if (nonStarCount > literal.length) break;
    }
    const slice = atoms.slice(k);
    if (hasDiscriminatingContent(slice) && globAtomsMatchLiteral(slice, literal)) return true;
  }
  return false;
}

// Closes the secrets.json/secret.yaml "generic extension" bypass:
// globProtectedExtensions above unconditionally protects an extension
// regardless of basename, which is correct for pem/pfx/p12/key/keystore/jks
// (no broad legitimate use), but json/yaml/yml/toml are extremely common
// extensions used by countless unrelated files -- protecting the whole
// extension the same way would deny '*.json'/'**/*.yml'/'*.toml' outright.
// Instead, a SEPARATE policy list (globProtectedGenericExtensionBasenames +
// globGenericExtensions) requires the candidate's own BASENAME portion
// (everything before the shared extension) to carry genuine discriminating
// content that can itself target one of the protected basenames
// ("secret"/"secrets"): a bare `*.json` has no discriminating basename
// content at all and passes, while `secret?.json`/`secrets*.json`/
// `secr*.json`/`[s]ecret.json` all specifically constrain the basename
// toward "secret"/"secrets" and deny.
//
// Symmetric to atomsMatchExtensionSuffix's provably-complete backward
// search: walk the split point between "basename" and "extension" forward
// from the start, tracking a running count of non-star atoms consumed by
// the candidate basename slice; once that count exceeds the protected
// basename's own length, every LARGER split point only adds more
// mandatory characters and can never match either -- so the search can
// stop, with no fixed bound and no risk of silently giving up early.
function atomsMatchGenericExtensionBasename(atoms, basenameLiteral, extensionSuffixLiteral) {
  const basename = basenameLiteral.toLowerCase();
  let nonStarCount = 0;
  for (let p = 0; p <= atoms.length; p += 1) {
    if (p > 0 && atoms[p - 1].type !== 'star') {
      nonStarCount += 1;
      if (nonStarCount > basename.length) break;
    }
    const prefix = atoms.slice(0, p);
    if (!hasDiscriminatingContent(prefix)) continue;
    if (!globAtomsMatchLiteral(prefix, basename)) continue;
    const remainder = atoms.slice(p);
    if (atomsMatchExtensionSuffix(remainder, extensionSuffixLiteral)) return true;
  }
  return false;
}

// The policy-level "*" segment sentinel (only used for directory-scoped
// protections like ".ssh/*", meaning "any single filename directly under
// this protected directory") and the at-most-one-relaxed-position
// bare-wildcard logic both live directly in globCouldTargetSensitivePath's
// own loop, which has the cross-segment context (how many OTHER segments
// already matched strictly) neither `atomsMatchLiteral()` nor a
// standalone per-segment helper can see on its own.

// Bounded, simple Bash brace-expansion support: a single, non-nested
// `{a,b,c}` group is expanded into its literal alternatives (each
// re-checked through the same glob-aware path). Deliberately narrow, per
// this checkpoint's own instruction not to build a shell interpreter --
// but every construct genuinely out of scope (nesting, a brace RANGE like
// `{a..z}`/`{1..10}`, too many branches, an over-long branch) now reports
// `indeterminate`, not `inert`: a fresh review found treating these as
// inert literal text was itself fail-open, since a real shell still
// expands every one of them and any could produce a protected name
// (`.{a..z}nv` genuinely expands, in real Bash, to include `.env`).
// `inert` is reserved for constructs that are GENUINELY not brace syntax
// in any supported shell either (no closing `}` at all, or a body with
// neither a comma nor a range operator) -- there, "no expansion occurs"
// is a fact about real shell behavior, not an analysis shortcut.
//
// A further review found a second, independent fail-open gap: scanning
// stopped entirely the moment the FIRST `{...}` pair in the text turned
// out to be genuinely inert (`{foo}`, no comma/range), on the mistaken
// assumption that "the first pair is inert" implies "nothing later in
// this token can expand" -- false in real Bash, which evaluates every
// brace pair in a word independently (`{foo}/.{env,x}` expands to
// `{foo}/.env` even though `{foo}` itself never expands). Fixed by
// scanning left to right and SKIPPING each genuinely inert pair rather
// than concluding the whole candidate is inert: `inert` is now returned
// only once the scan reaches the end of the text with no relevant
// (expandable or indeterminate) brace pair found anywhere. This scan is
// linear in the text's own length (each `indexOf` call starts exactly
// where the previous one left off, never re-scanning already-passed
// text), and that length is already bounded by the caller's own
// upstream command/field-length limits, so no separate bound is needed
// here.
function expandFirstBraceGroup(text) {
  let searchFrom = 0;
  for (;;) {
    const open = text.indexOf('{', searchFrom);
    if (open === -1) return { status: 'inert' }; // no brace pair anywhere left to scan
    const close = text.indexOf('}', open + 1);
    if (close === -1) return { status: 'inert' }; // unterminated: not valid brace syntax in a real shell either
    const body = text.slice(open + 1, close);
    if (body.includes('{') || body.includes('}')) {
      return { status: 'indeterminate' }; // nested braces ARE valid, expandable bash syntax we do not implement
    }
    // A brace RANGE ({a..z}, {0..9}, {1..10..2}) has no comma at all but
    // is valid, common, expandable bash syntax -- flagged indeterminate
    // rather than falling through to "no comma -> inert" below.
    if (/^[^,]*\.\.[^,]*$/.test(body)) {
      return { status: 'indeterminate' };
    }
    const branches = body.split(',');
    if (branches.length < 2) {
      // Genuinely inert -- but only THIS pair. A later brace pair in the
      // same text is evaluated by a real shell independently of this
      // one, so keep scanning rather than concluding nothing else here
      // can expand.
      searchFrom = close + 1;
      continue;
    }
    if (branches.length > MAX_BRACE_BRANCHES) return { status: 'indeterminate' };
    if (branches.some((b) => b.length > MAX_BRACE_BRANCH_LENGTH)) return { status: 'indeterminate' };
    const prefix = text.slice(0, open);
    const suffix = text.slice(close + 1);
    return { status: 'expanded', candidates: branches.map((b) => `${prefix}${b}${suffix}`) };
  }
}

// Iterates expandFirstBraceGroup() to a fixed point so MULTIPLE groups in
// one candidate (`.e{n,m}{v,w}`) are all expanded, not just the first --
// an earlier review found the original single-pass version left any
// SECOND group unexpanded (literal `{`/`}` still present, matching
// nothing), even though a real shell expands every group in a word.
// Bounded by MAX_BRACE_GROUPS rounds and a hard
// MAX_TOTAL_BRACE_CANDIDATES ceiling so two or more groups cannot combine
// into a combinatorial explosion -- but per the tri-state redesign above,
// exhausting EITHER bound while a genuinely expandable (or indeterminate)
// group still remains now reports `indeterminate` for the whole
// candidate, not a silent "here's what we got so far".
function expandSimpleBraceGroup(text) {
  let candidates = [text];
  for (let round = 0; round < MAX_BRACE_GROUPS; round += 1) {
    let expandedAnything = false;
    const next = [];
    for (const candidate of candidates) {
      const result = expandFirstBraceGroup(candidate);
      if (result.status === 'indeterminate') return { status: 'indeterminate' };
      if (result.status === 'inert') {
        next.push(candidate);
        continue;
      }
      expandedAnything = true;
      for (const branch of result.candidates) {
        next.push(branch);
        if (next.length > MAX_TOTAL_BRACE_CANDIDATES) return { status: 'indeterminate' };
      }
    }
    candidates = next;
    if (!expandedAnything) break;
  }
  // MAX_BRACE_GROUPS rounds are exhausted (or expansion legitimately
  // stopped early) -- if any candidate STILL contains a group we would
  // expand or flag indeterminate, our picture of the possible outcomes is
  // incomplete, and the whole result must be indeterminate rather than a
  // confident "here is the full candidate set".
  const stillExpandable = candidates.some((c) => {
    const r = expandFirstBraceGroup(c);
    return r.status === 'expanded' || r.status === 'indeterminate';
  });
  if (stillExpandable) return { status: 'indeterminate' };
  return { status: 'expanded', candidates };
}

/**
 * Determine whether `text`, interpreted as a filesystem glob expression,
 * can match one of KRYLO's canonical protected secret names/extensions
 * (policies/production-policy.json's `sensitivePaths.globProtectedPaths`/
 * `globProtectedExtensions`). Complements matchesSensitivePath() (exact
 * literal matching, unchanged) rather than replacing it.
 *
 * Returns one of three string results -- MATCH, NO_MATCH, or
 * INDETERMINATE -- rather than a boolean. A fresh review's own explicit
 * security rule: MATCH and INDETERMINATE both deny; only a confident
 * NO_MATCH continues normal classification. An attacker-controlled
 * complexity/budget limit inside this function must never silently
 * resolve to NO_MATCH just because analysis stopped -- see the
 * `GLOB_MATCH`/`GLOB_NO_MATCH`/`GLOB_INDETERMINATE` constants below and
 * every "indeterminate" flag threaded through the helpers above.
 *
 * A glob that can ALSO match an exempted public template name (e.g.
 * `.env*` also matches `.env.example`) is still denied here: the template
 * exception in matchesSensitivePath() only ever applies to an EXACT,
 * literal template filename with no glob metacharacters at all, since
 * this function only runs when a glob metacharacter is present.
 */
const GLOB_MATCH = 'match';
const GLOB_NO_MATCH = 'no_match';
const GLOB_INDETERMINATE = 'indeterminate';

function globCouldTargetSensitivePath(policy, text) {
  if (typeof text !== 'string' || text === '') return GLOB_NO_MATCH;
  // Independent review found brace expansion below was unreachable for a
  // BRACE-ONLY pattern (`.{env,x}` contains no `*`/`?`/`[` at all), even
  // though a real shell expands it unconditionally -- `{` is now part of
  // this initial gate too.
  if (!/[*?[{]/.test(text)) return GLOB_NO_MATCH; // no glob/brace metacharacter: nothing for this check to do
  const expansion = expandSimpleBraceGroup(text);
  if (expansion.status === GLOB_INDETERMINATE) return GLOB_INDETERMINATE;
  const candidates = expansion.candidates;
  const globProtectedPaths = Array.isArray(policy.sensitivePaths.globProtectedPaths)
    ? policy.sensitivePaths.globProtectedPaths
    : [];
  const globProtectedExtensions = Array.isArray(policy.sensitivePaths.globProtectedExtensions)
    ? policy.sensitivePaths.globProtectedExtensions
    : [];
  const globProtectedGenericExtensionBasenames = Array.isArray(
    policy.sensitivePaths.globProtectedGenericExtensionBasenames,
  )
    ? policy.sensitivePaths.globProtectedGenericExtensionBasenames
    : [];
  const globGenericExtensions = Array.isArray(policy.sensitivePaths.globGenericExtensions)
    ? policy.sensitivePaths.globGenericExtensions
    : [];
  // Independent review found a whole-candidate length cap that used to
  // sit here was a fail-OPEN bypass, not a safety bound: padding a
  // candidate with harmless leading segments just past the cap evaded
  // the glob check entirely. The actual cost driver was never the
  // candidate's overall length -- only the TRAILING segments a protected
  // path can possibly match against ever matter (the longest,
  // `.config/gh/hosts.yml`, needs 3), and re-parsing is done exactly once
  // per segment below -- so only the last `maxProtectedPathSegments`
  // segments are ever parsed or examined at all, regardless of how many
  // (or how long) the leading segments are.
  const maxProtectedPathSegments = globProtectedPaths.reduce(
    (max, protectedPath) => Math.max(max, protectedPath.split('/').length),
    1,
  );
  let sawIndeterminateSegment = false;
  for (const candidate of candidates) {
    const allSegments = candidate.replace(/\\/g, '/').split('/').filter((s) => s !== '');
    if (allSegments.length === 0) continue;
    const segments = allSegments.slice(-maxProtectedPathSegments);
    // Parse each (trailing) segment's atoms exactly ONCE per candidate and
    // reuse them across every protectedPath/extension check below -- an
    // earlier review found each segment was previously re-parsed from
    // scratch once per globProtectedPaths entry plus once per protected
    // extension (roughly 22 times), which, stacked with brace expansion's
    // up to MAX_BRACE_BRANCHES candidates, multiplied into a 40-60 second
    // stall for a bracket-class-heavy candidate.
    const segmentParses = segments.map((segment) => parseGlobAtoms(segment));
    if (segmentParses.some((p) => p.indeterminate)) sawIndeterminateSegment = true;
    const segmentAtoms = segmentParses.map((p) => p.atoms);
    for (const protectedPath of globProtectedPaths) {
      const protectedSegments = protectedPath.split('/');
      if (segments.length < protectedSegments.length) continue;
      const tailAtoms = segmentAtoms.slice(segments.length - protectedSegments.length);
      // Independent review found a real bypass: `.aws/*`, `.kube/*`, and
      // `.config/gh/*` all passed, since a bare wildcard filename segment
      // was rejected by the SAME guard that (correctly) rejects a bare
      // wildcard with no directory context at all. Once every OTHER
      // segment has matched the exact protected directory name with real
      // content, a bare-wildcard segment legitimately does reach the
      // specific protected path too (the surrounding context already
      // confirms it, unlike a context-free `cat *`).
      //
      // A further review found restricting this to only the FINAL
      // segment missed an equally real form: `cat .config/*/hosts.yml`
      // (the MIDDLE segment wildcarded, not the last) still reaches the
      // real `.config/gh/hosts.yml` in a real shell. At most ONE segment
      // may use this relaxation, at ANY position -- never two or more,
      // which is what would turn a fully generic `*/*/*` into a false
      // match with no real directory-context signal at all (the same
      // over-blocking concern a context-free bare `*` already guards
      // against for single-segment protected names).
      //
      // Own follow-up check (caught before this round's review closed,
      // via this checkpoint's own test-first practice): a protectedPath
      // that ALREADY has a policy-level `*` sentinel (`.ssh/*`) grants a
      // free pass on that position regardless of anything else -- so also
      // letting the relaxation apply to one of the OTHER (specific-name)
      // segments would let a fully generic candidate (`cat */*`) match
      // with ZERO real information confirming ANY of them, since between
      // the sentinel's unconditional pass and the one relaxed position
      // there would be nothing left requiring a strict match. The
      // relaxation is therefore only available when the protectedPath has
      // NO sentinel segment of its own; a sentinel-bearing entry already
      // requires every one of its OTHER (non-sentinel) segments to match
      // strictly.
      const pathHasSentinel = protectedSegments.includes('*');
      let relaxedPositionUsed = false;
      let matchesAll = true;
      for (let idx = 0; idx < protectedSegments.length; idx += 1) {
        const protectedSegment = protectedSegments[idx];
        if (protectedSegment === '*') continue; // policy-level sentinel: always matches
        if (atomsMatchLiteral(tailAtoms[idx], protectedSegment)) continue; // strict match
        const isEligibleForRelaxation = !pathHasSentinel // never combine the sentinel's own free pass with a second relaxed position
          && protectedSegments.length > 1 // never for a single-segment protected name (`.env`, `id_rsa`, ...): that is exactly the context-free bare-`*` over-blocking case
          && !relaxedPositionUsed
          && tailAtoms[idx].length > 0
          && !hasDiscriminatingContent(tailAtoms[idx]);
        if (isEligibleForRelaxation) {
          relaxedPositionUsed = true;
          continue;
        }
        matchesAll = false;
        break;
      }
      if (matchesAll) {
        return GLOB_MATCH;
      }
    }
    const lastSegmentAtoms = segmentAtoms[segmentAtoms.length - 1];
    for (const ext of globProtectedExtensions) {
      if (atomsMatchExtensionSuffix(lastSegmentAtoms, `.${ext}`)) return GLOB_MATCH;
    }
    for (const ext of globGenericExtensions) {
      for (const protectedBasename of globProtectedGenericExtensionBasenames) {
        if (atomsMatchGenericExtensionBasename(lastSegmentAtoms, protectedBasename, `.${ext}`)) {
          return GLOB_MATCH;
        }
      }
    }
  }
  // A bracket-class or per-pattern-class-count budget was exhausted on
  // some examined segment, with no confirmed MATCH found elsewhere: we
  // cannot rule out that the unexamined portion of that class would have
  // completed a real match, so this is INDETERMINATE (fail-safe deny),
  // not a confident NO_MATCH.
  return sawIndeterminateSegment ? GLOB_INDETERMINATE : GLOB_NO_MATCH;
}

function isSensitivePath(policy, text) {
  if (matchesSensitivePath(policy, text)) return true;
  return globCouldTargetSensitivePath(policy, text) !== GLOB_NO_MATCH;
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
 *
 * A sixth review round confirmed, against a real Bash process, that Bash
 * ANSI-C (`$'...'`) and locale (`$"..."`) quoting still bypassed this:
 * `cat $'.env'` reads the real `.env`, but the SHELL_WORD tokenizer glues
 * the leading `$` into the token as ordinary text, so after stripping
 * only the quote characters the token becomes `$.env` -- the leading `$`
 * defeats the sensitivePaths patterns' own `(^|[\\/])` start-of-path
 * anchor. A `$` immediately before a quote character is part of that
 * quoting syntax, not path text, and is stripped along with the quote.
 */
function stripSurroundingQuotes(token) {
  return token.replace(/\$(?=["'])/g, '').replace(/["']/g, '');
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
  // The WHOLE-STRING check stays exact-match only (matchesSensitivePath,
  // unchanged): it exists to catch an exact protected path embedded
  // directly in the command text (`cat ./config/.env`), and a raw
  // multi-word command line is not itself a meaningful glob expression --
  // running the glob-aware check against it let an unrelated preceding
  // word (`cat *`) supply just enough "discriminating content" for the
  // trailing bare `*` to still slip through the extension-suffix search,
  // exactly reproducing the over-blocking this checkpoint's own task
  // explicitly warns against. The glob-aware check instead only ever runs
  // per TOKEN (each a genuine shell word on its own), below.
  if (matchesSensitivePath(policy, command)) return true;
  const tokens = String(command).match(SHELL_WORD) || [];
  return tokens
    .map(stripSurroundingQuotes)
    .some((token) => isSensitivePath(policy, token));
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

  if (touchesCodexProjectHooks({ toolName: name, toolInput: input, cwd })) {
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
    if (isSensitivePath(policy, stripSurroundingQuotes(target))) {
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
      if (typeof candidate === 'string' && candidate !== '' && isSensitivePath(policy, stripSurroundingQuotes(candidate))) {
        return {
          action: 'deny',
          category: 'sensitive-path',
          reason: `${policy.sensitivePaths.reason} This read target is a protected secret path.`,
        };
      }
    }
    return { action: 'pass', category: 'pass' };
  }

  if (name === 'apply_patch') {
    const patchText = typeof input.patch === 'string' ? input.patch : '';
    const targets = extractApplyPatchTargets(patchText);
    // A real apply_patch call always specifies at least one target file via
    // its own required header syntax -- zero extractable targets means the
    // patch content was not recognized (malformed, unexpected shape, or a
    // deliberate evasion attempt), which is exactly the "cannot determine
    // whether this is safe" case this module treats as fail-safe deny
    // elsewhere (the tri-state glob redesign, docs/adr/0028's Section H),
    // never a silent pass just because parsing found nothing.
    if (targets.length === 0) {
      return {
        action: 'deny',
        category: 'apply-patch-unparseable',
        reason: 'KRYLO could not determine which file(s) this apply_patch call targets, so it cannot verify the action is safe. Denied as a fail-safe.',
      };
    }
    for (const target of targets) {
      const syntheticInput = { file_path: target };
      if (touchesDataRoot({ toolName: name, toolInput: syntheticInput, cwd, dataRoot: resolvedDataRoot })) {
        return { action: 'deny', category: 'data-root-protection', reason: DATA_ROOT_REASON };
      }
      if (touchesClaudeSettings({ toolName: name, toolInput: syntheticInput, cwd })) {
        return { action: 'deny', category: 'security-config-protection', reason: SECURITY_CONFIG_WEAKENING_REASON };
      }
      if (touchesCodexProjectHooks({ toolName: name, toolInput: syntheticInput, cwd })) {
        return { action: 'deny', category: 'security-config-protection', reason: SECURITY_CONFIG_WEAKENING_REASON };
      }
      if (touchesPluginInstallation({ toolName: name, toolInput: syntheticInput, cwd, pluginRoot })) {
        return { action: 'deny', category: 'plugin-installation-protection', reason: PLUGIN_INSTALLATION_REASON };
      }
      if (isSensitivePath(policy, stripSurroundingQuotes(target))) {
        return {
          action: 'deny',
          category: 'sensitive-path',
          reason: `${policy.sensitivePaths.reason} This apply_patch target is a protected secret path.`,
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
