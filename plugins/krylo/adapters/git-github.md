# Adapter: Git and GitHub

- **Detection:** `git --version` on PATH; GitHub integration via `gh --version` and `gh auth status` (never store the token).
- **Publisher / source:** Git project (git-scm.com); GitHub (cli.github.com). Catalog IDs: `git-cli`, `github-cli`.
- **Supported versions:** Git ≥ 2.30. GitHub CLI per reviewed catalog version.
- **Trust tier:** Git A; GitHub CLI A-.
- **Authentication:** Git uses the repository's existing configuration. GitHub CLI uses the user's own `gh` login; KRYLO never creates or modifies credentials.
- **Allowed environments:** Git in all profiles; GitHub CLI in `private-approved` and `public-repository`.
- **Read capabilities:** status, log, diff, blame, branch listing; issues and PRs read-only.
- **Write capabilities (gated):** local commits only when the task explicitly requests them. Push, merge, release, workflow dispatch, settings, and secret changes always stop at `RISK_APPROVAL_REQUIRED` (see `policies/production-policy.json`).
- **Data egress:** repository metadata to GitHub only through the user's own authenticated CLI.
- **Verification:** `git status --porcelain` before and after; command exit codes.
- **Degraded behavior:** without Git, repository intelligence and diff evidence are unavailable and KRYLO reports the limitation; without `gh`, remote operations are simply not offered.
