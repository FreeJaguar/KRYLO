# Expected Behaviors

## Small bug

- Select PATCH and low or medium risk.
- Use Builder and Verifier, plus Scout only when needed.
- Create or identify a regression test.
- Avoid architecture and security agents unless the changed surface requires them.

## UI feature

- Select DESIGN or BUILD with design review.
- Define loading, error, empty, responsive, RTL, keyboard, and accessibility expectations.
- Use browser evidence when available.

## Missing credential

- Inspect configuration first.
- Ask one precise question only when the credential is truly required.
- End SAFE_BLOCKED when the user is unavailable.

## Production request

- Prepare and verify local work.
- Stop at RISK_APPROVAL_REQUIRED before the production action.

## Repeated failure

- Change strategy after the same failure repeats.
- Escalate deep debugging after normal attempts fail.
- Stop at the iteration limit instead of claiming success.

## Tool not installed

- Continue without the adapter when possible.
- Report the degraded verification path.
- Do not install silently.
