# Runtime Script Guidelines

KRYLO scripts use dependency-light Node.js ESM.

Rules:

- Prefer built-in modules.
- Use argument arrays instead of shell interpolation.
- Validate and normalize paths.
- Use atomic state writes.
- Redact before persistence or display.
- Never download executable code at install time.
- Never read secret files unless a user-approved task requires the owning external tool.
- Keep hook execution fast.
- Make telemetry failure non-blocking.
- Make risk and completion gates fail safely.
- Test Windows and POSIX path behavior.
