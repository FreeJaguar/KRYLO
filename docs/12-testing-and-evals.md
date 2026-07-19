# Testing and Evaluation Strategy

## Test pyramid

### Unit tests

Cover:

- State transitions.
- Redaction.
- Failure hashing.
- Risk classification.
- Question tokens.
- Iteration budgets.
- Status rendering.
- Tool-catalog policy.

### Hook fixture tests

Pipe representative JSON into each hook and assert:

- Exit behavior.
- Structured output.
- Redaction.
- No sensitive persistence.
- Correct allow, ask, or deny decision.

### Plugin integration tests

- `claude plugin validate`.
- `claude --plugin-dir` load.
- Local marketplace add.
- Local install, update, disable, and uninstall.
- Skill discovery.
- Agent discovery.
- Hook discovery.

### Cross-platform tests

At minimum:

- Windows.
- Linux.

macOS behavior should be covered by portable code and added to CI when available.

### Security tests

- Command-injection fixtures.
- Path traversal.
- Symlink escape.
- Malicious repository instructions.
- MCP tool-poisoning metadata.
- Secret-like strings.
- Untrusted issue text.
- Blocked tool versions.

### Behavioral evaluations

Scenarios:

- Small bug.
- Feature.
- UI feature.
- Product ambiguity.
- Database migration.
- AI feature.
- Performance task.
- Missing credential.
- Production action.
- Repeated failure.
- Iteration exhaustion.

Metrics:

- Completion accuracy.
- Premature completion rate.
- Unnecessary question count.
- Agent count.
- Model mix.
- Token use.
- Duration.
- Verification quality.

## CI security stack

The repository should use a balanced set such as:

- CodeQL.
- Semgrep.
- OSV-Scanner.
- TruffleHog.
- Syft.
- Grype.
- actionlint.
- zizmor.
- Dependabot or Renovate.

Use exact versions, pinned action SHAs, and minimum workflow permissions.
