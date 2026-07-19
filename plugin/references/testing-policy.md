# Testing Policy

Select tests from changed behavior and risk.

- Bug: reproduction and regression.
- API: validation, auth, success, failure, contract, integration.
- Database: migration validation, rollback review, compatibility, data assumptions, index and query effects.
- UI: component, browser, responsive, RTL, keyboard, accessibility, screenshot, build.
- Security: negative authorization, injection, secret scan, dependency scan, data exposure.
- AI: golden cases, injection, tool abuse, fallback, latency, cost, deterministic fixtures.
- Performance: baseline, target, same-environment comparison, regression.
- Infrastructure: config validation, build, health check, scan, rollback.

Verifier and Reviewer must detect weakened assertions, skipped tests, broad ignores, disabled checks, unrealistic mocks, and swallowed errors.
