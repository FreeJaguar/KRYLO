#!/usr/bin/env node
// Remove expired run and telemetry data from under the plugin data root.
// Only ever touches paths resolved through runsRootDir()/telemetryRootDir(),
// and never follows a symlinked entry out of the root (Dirent type checks
// below do not resolve symlinks).

import fs from 'node:fs';
import path from 'node:path';

import { runsRootDir, telemetryRootDir } from '../lib/paths.mjs';
import { loadState } from '../lib/state.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { dryRun: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--retention-days': args.retentionDays = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--all': args.all = true; break;
      default: break;
    }
  }
  return args;
}

function defaultRetentionDays() {
  const env = process.env.CLAUDE_PLUGIN_OPTION_TELEMETRY_RETENTION_DAYS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 14;
}

function listDirSafely(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function runAgeMs(runDirPath, runId) {
  const loaded = loadState(runId);
  if (loaded.ok && typeof loaded.value.updatedAt === 'string') {
    const t = Date.parse(loaded.value.updatedAt);
    if (!Number.isNaN(t)) return Date.now() - t;
  }
  try {
    return Date.now() - fs.statSync(runDirPath).mtimeMs;
  } catch {
    return 0;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const retentionDays = Number.isFinite(args.retentionDays) ? args.retentionDays : defaultRetentionDays();
  const retentionMs = retentionDays * DAY_MS;

  const runsRoot = runsRootDir();
  const telemetryRoot = telemetryRootDir();

  const removed = { runs: [], telemetry: [] };
  const kept = { runs: [], telemetry: [] };

  const runEntries = listDirSafely(runsRoot).filter((e) => e.isDirectory());
  for (const entry of runEntries) {
    const runId = entry.name;
    const runDirPath = path.join(runsRoot, runId);
    const shouldRemove = args.all || runAgeMs(runDirPath, runId) >= retentionMs;
    if (shouldRemove) {
      removed.runs.push(runId);
      if (!args.dryRun) {
        try {
          fs.rmSync(runDirPath, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    } else {
      kept.runs.push(runId);
    }
  }

  const telemetryEntries = listDirSafely(telemetryRoot).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  for (const entry of telemetryEntries) {
    const runId = entry.name.replace(/\.jsonl$/, '');
    const filePath = path.join(telemetryRoot, entry.name);
    let ageMs = 0;
    try {
      ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
    } catch {
      // file may have raced away between listing and stat
    }
    const shouldRemove = args.all || ageMs >= retentionMs;
    if (shouldRemove) {
      removed.telemetry.push(runId);
      if (!args.dryRun) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }
    } else {
      kept.telemetry.push(runId);
    }
  }

  console.log(JSON.stringify({ ok: true, dryRun: args.dryRun, retentionDays, removed, kept }));
  process.exit(0);
}

main();
