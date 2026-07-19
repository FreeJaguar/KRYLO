#!/usr/bin/env node
// KRYLO tool auditor: read-only trust and security review of a tool, plugin,
// skill, MCP definition, package, or local path (docs/09-tool-governance.md).
//
// Usage: node audit-tool.mjs --target <path-or-name> [--version <v>] [--json]
//        [--catalog-dir <dir>]   (test override for catalog location)
//
// The auditor NEVER executes, installs, or modifies the target. Findings are
// pattern-based static observations; the verdict follows the trust registry:
// an unreviewed tool or version is never auto-approved, a blocked version is
// refused.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_DIR = path.resolve(HERE, '..', '..', 'catalog');

const MAX_DEPTH = 6;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.sh', '.bash', '.zsh', '.ps1', '.yml', '.yaml', '.toml', '.txt', '.py']);

const CONTENT_RULES = [
  { severity: 'critical', id: 'remote-exec', summary: 'Remote script piped into a shell (curl|bash / wget|sh)', pattern: /\b(curl|wget)\b[^\n]{0,200}\|\s*(sudo\s+)?(ba)?sh\b/i },
  { severity: 'high', id: 'install-hook', summary: 'npm lifecycle install hook (postinstall/preinstall/install)', pattern: null },
  { severity: 'medium', id: 'eval', summary: 'Dynamic code evaluation (eval)', pattern: /\beval\s*\(/ },
  { severity: 'medium', id: 'dynamic-exec', summary: 'child_process execution with dynamic string construction', pattern: /(exec|execSync|spawn|spawnSync)\s*\(\s*(`[^`]*\$\{|[\w.]+\s*\+)/ },
  { severity: 'medium', id: 'env-secret-read', summary: 'Reads secret-like environment variables', pattern: /process\.env\.[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/ },
  { severity: 'high', id: 'settings-mutation', summary: 'Mentions writing Claude settings files', pattern: /(writeFile|copyFile|appendFile)[^\n]{0,120}settings(\.local)?\.json/i },
  { severity: 'high', id: 'auto-update', summary: 'Auto-update behavior (self-update / checkForUpdates with download)', pattern: /(self[-_]?update|auto[-_]?update|checkForUpdates)/i },
  { severity: 'high', id: 'secret-file-read', summary: 'Reads secret files (.env, id_rsa, cloud credentials)', pattern: /(readFile|createReadStream|open)[^\n]{0,120}(\.env\b|id_rsa|\.aws[\\/]credentials|\.kube[\\/]config)/i },
];

const URL_PATTERN = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

function walkFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile()) files.push(p);
    }
  };
  const stat = fs.statSync(root);
  if (stat.isFile()) files.push(root);
  else walk(root, 0);
  return files;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/') || path.basename(file);
}

function scanPath(root) {
  const findings = [];
  const domains = new Set();
  const files = walkFiles(root);

  for (const file of files) {
    const rel = relative(root, file);
    const base = path.basename(file).toLowerCase();
    let text = null;
    try {
      if (fs.statSync(file).size <= MAX_FILE_BYTES && (TEXT_EXTENSIONS.has(path.extname(base)) || !path.extname(base))) {
        text = fs.readFileSync(file, 'utf8');
      }
    } catch {
      continue;
    }
    if (text === null) continue;

    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        const scripts = pkg.scripts ?? {};
        for (const hook of ['preinstall', 'install', 'postinstall']) {
          if (scripts[hook]) {
            findings.push({ severity: 'high', id: 'install-hook', summary: `npm ${hook} script present`, location: rel });
          }
        }
        if (pkg.bin) findings.push({ severity: 'info', id: 'bin', summary: 'declares executable bin entries', location: rel });
        const depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
        findings.push({ severity: 'info', id: 'dependencies', summary: `${depCount} declared dependencies`, location: rel });
        if (!pkg.repository) findings.push({ severity: 'low', id: 'no-repository', summary: 'package.json has no repository field', location: rel });
      } catch {
        findings.push({ severity: 'low', id: 'bad-manifest', summary: 'package.json is not valid JSON', location: rel });
      }
    }

    if (base === 'hooks.json' || base === 'plugin.json' || base === 'marketplace.json') {
      findings.push({ severity: 'info', id: 'claude-manifest', summary: `Claude Code manifest present (${base})`, location: rel });
      if (/https?:\/\//i.test(text) && base !== 'marketplace.json') {
        findings.push({ severity: 'medium', id: 'remote-config', summary: `${base} references remote URLs`, location: rel });
      }
    }

    for (const rule of CONTENT_RULES) {
      if (rule.pattern && rule.pattern.test(text)) {
        findings.push({ severity: rule.severity, id: rule.id, summary: rule.summary, location: rel });
      }
    }

    for (const match of text.matchAll(URL_PATTERN)) {
      domains.add(match[1].toLowerCase());
    }
  }

  return { findings, domains: [...domains].sort(), filesScanned: files.length };
}

function loadCatalog(catalogDir) {
  const tools = JSON.parse(fs.readFileSync(path.join(catalogDir, 'tools.json'), 'utf8')).tools;
  const blocked = JSON.parse(fs.readFileSync(path.join(catalogDir, 'blocked-versions.json'), 'utf8')).blocked;
  const trustPolicy = JSON.parse(fs.readFileSync(path.join(catalogDir, 'trust-policy.json'), 'utf8'));
  return { tools, blocked, trustPolicy };
}

function catalogVerdict(catalog, name, version) {
  const blockedEntry = catalog.blocked.find((b) => b.id === name);
  if (blockedEntry && (!version || (blockedEntry.blockedRanges ?? []).some((r) => r === version || r === '*'))) {
    return { verdict: 'refuse', reason: `blocked by trust registry: ${blockedEntry.reason ?? 'blocked version'}` };
  }
  const record = catalog.tools.find((t) => t.id === name);
  if (!record) {
    return { verdict: 'unreviewed-no-automatic-use', reason: 'tool is not in the trust catalog; no automatic use' };
  }
  if (record.reviewedVersion === 'pending-first-review') {
    return { verdict: 'unreviewed-no-automatic-use', reason: 'tool family is classified but no exact version passed review; no automatic use', record };
  }
  if (version && version !== record.reviewedVersion) {
    return { verdict: 'unreviewed-no-automatic-use', reason: `version ${version} differs from reviewed ${record.reviewedVersion}; a newer version is not automatically trusted`, record };
  }
  const tierBehavior = catalog.trustPolicy.tiers[record.trustTier]?.defaultBehavior ?? 'no-automatic-use';
  return { verdict: `tier-${record.trustTier}`, reason: `reviewed at ${record.reviewedVersion}; default behavior: ${tierBehavior}`, record };
}

function suggestTier(findings) {
  if (findings.some((f) => f.severity === 'critical')) return 'Blocked';
  if (findings.some((f) => f.severity === 'high')) return 'B';
  if (findings.some((f) => f.severity === 'medium')) return 'B+';
  return 'A-';
}

function main() {
  const argv = process.argv.slice(2);
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const target = getFlag('--target');
  const version = getFlag('--version');
  const catalogDir = getFlag('--catalog-dir') ?? DEFAULT_CATALOG_DIR;
  const asJson = argv.includes('--json');

  if (!target) {
    process.stderr.write('usage: audit-tool.mjs --target <path-or-name> [--version <v>] [--json] [--catalog-dir <dir>]');
    process.exit(1);
  }

  const catalog = loadCatalog(catalogDir);
  const isPath = fs.existsSync(target);
  const name = isPath ? path.basename(path.resolve(target)) : target;

  const scan = isPath ? scanPath(path.resolve(target)) : { findings: [], domains: [], filesScanned: 0 };
  const registry = catalogVerdict(catalog, name, version);

  // Static findings can only make the verdict stricter, never looser.
  let verdict = registry.verdict;
  if (scan.findings.some((f) => f.severity === 'critical')) {
    verdict = 'refuse';
  }

  const report = {
    ok: true,
    target,
    identity: { name, version: version ?? null, inspected: isPath ? 'local-path' : 'catalog-name-only' },
    filesScanned: scan.filesScanned,
    findings: scan.findings,
    remoteDomains: scan.domains,
    suggestedTier: isPath ? suggestTier(scan.findings) : null,
    registry: { verdict: registry.verdict, reason: registry.reason, tier: registry.record?.trustTier ?? null },
    verdict,
    reReviewTriggers: catalog.trustPolicy.rules.reReviewTriggers,
    note: 'Audit is read-only. Installation or use is a separate, user-approved action. An unreviewed version is never auto-approved.',
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else {
    const lines = [];
    lines.push(`audit: ${name}${version ? `@${version}` : ''} (${report.identity.inspected}, ${report.filesScanned} files)`);
    lines.push(`verdict: ${verdict} - ${registry.reason}`);
    if (report.suggestedTier) lines.push(`suggested tier from static findings: ${report.suggestedTier}`);
    for (const f of report.findings) lines.push(`[${f.severity}] ${f.summary} (${f.location})`);
    if (report.remoteDomains.length > 0) lines.push(`remote domains referenced: ${report.remoteDomains.join(', ')}`);
    lines.push(report.note);
    process.stdout.write(lines.join('\n'));
  }
  process.exit(0);
}

main();
