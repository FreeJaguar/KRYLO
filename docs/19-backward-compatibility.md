# Backward Compatibility

## Scope

KRYLO is initially a new public plugin. Compatibility policy covers:

- Plugin configuration.
- UserConfig keys.
- Run-state schemas.
- Agent result schema.
- Alias wrapper.
- Tool catalog.
- Public commands.

## Compatibility rules

- New optional fields are backward compatible.
- Removing or renaming a public command requires a major version.
- Run-state readers support at least the prior minor schema when practical.
- Unknown fields are ignored unless security-sensitive.
- Security-policy tightening may occur in a minor or patch release when necessary.
- Tool versions may be blocked immediately through a patch release.

## Migration

Every schema change includes:

- Version detection.
- Migration function.
- Backup.
- Validation after migration.
- Recovery behavior.

## Alias compatibility

The alias should invoke the installed plugin command rather than copy the full KRYLO workflow, keeping alias updates small and safe.
