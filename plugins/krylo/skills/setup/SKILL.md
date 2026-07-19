---
name: setup
description: Inspect and configure the local KRYLO plugin environment, including user preferences, health checks, and optional installation of the personal /krylo convenience alias or main status-line wrapper.
argument-hint: "[--dry-run] [--install-alias] [--remove-alias] [--statusline]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# KRYLO Setup

Arguments: `$ARGUMENTS`

1. Always start with the read-only diagnostic and show its results:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/doctor.mjs" --json
   ```

2. Display effective user preferences (language, autonomy_level, max_orbit_cycles, status_detail, local_telemetry, telemetry_retention_days, security_profile) from the doctor report. Detect optional integrations without installing anything.
3. For alias work, the deterministic scripts default to DRY RUN and only `--apply` changes files:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/install-alias.mjs"            # dry run: plan only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/install-alias.mjs" --apply    # after explicit user approval
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/remove-alias.mjs"             # dry run
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/remove-alias.mjs" --apply [--restore-backup]
   ```

   Show the dry-run plan (target, ownership decision, backup path, rollback method) and run `--apply` only after the user explicitly approves. The scripts refuse to touch a personal skill named `krylo` that KRYLO does not own — never work around that refusal.
4. A main status-line wrapper (`scripts/status/statusline-wrapper.mjs`) may be offered only with explicit approval and a backup of the user's existing status-line configuration; record the original command in `wrapper-config.json` under the KRYLO data directory. Removal must restore the original.
5. Never enable Auto Mode, bypass permissions, or weaken deny rules.
6. Finish with a concise configuration and health report.
