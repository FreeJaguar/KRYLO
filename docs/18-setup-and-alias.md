# Setup and Alias

## Plugin user configuration

Use `userConfig` for normal preferences such as:

- `language`: `auto`, `en`, or `he`.
- `autonomy_level`: `safe`, `standard`, or `high`.
- `max_orbit_cycles`: bounded numeric value.
- `status_detail`: `minimal`, `normal`, or `detailed`.
- `local_telemetry`: boolean.
- `security_profile`: selected profile name.

Do not use user configuration to store large secrets or source code.

## Setup responsibilities

- Validate the environment.
- Display configuration.
- Detect optional tools.
- Test plugin components.
- Offer alias and main-status integration.
- Back up user files before approved changes.

## Alias implementation

The personal alias is a small user skill that forwards `$ARGUMENTS` to the namespaced KRYLO run skill.

Requirements:

- Detect an existing `~/.claude/skills/krylo` directory.
- Refuse to overwrite unknown ownership.
- Support dry run.
- Create a backup when replacing a KRYLO-owned older alias.
- Record installed alias version.
- Remove only KRYLO-owned alias files.

## Auto Mode

KRYLO setup must not enable Auto Mode silently. It may diagnose the current mode and explain tradeoffs. User permission settings remain the source of truth.
