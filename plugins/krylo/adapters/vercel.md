# Adapter: Vercel

- **Detection:** `vercel` CLI on PATH; `vercel.json` or `.vercel/` in the repository.
- **Publisher / source:** Vercel. Catalog ID: `vercel-cli`.
- **Supported versions:** per reviewed catalog version.
- **Trust tier:** B+.
- **Authentication:** the user's own Vercel login; KRYLO never creates tokens.
- **Allowed environments:** `private-approved`, `public-repository`.
- **Read capabilities:** preview inspection, build and runtime log reading.
- **Write capabilities (gated):** production deployment (`vercel --prod`), environment-variable and project-settings changes stop at `RISK_APPROVAL_REQUIRED` (see `policies/production-policy.json`).
- **Data egress:** deployments send source code to Vercel; allowed only when the task explicitly requests deployment work and the profile permits it.
- **Verification:** preview URLs and build logs as evidence.
- **Degraded behavior:** without the CLI, deployment verification is reported as unavailable.
