# Adapter: Supabase and Databases

- **Detection:** `supabase` CLI on PATH; project config (`supabase/config.toml`); other databases via repository-native migration tooling (Prisma, Drizzle, Rails, Flyway, etc.).
- **Publisher / source:** Supabase and the respective tool publishers. Catalog ID: `supabase-cli`.
- **Supported versions:** per reviewed catalog version.
- **Trust tier:** A- (CLI, development use).
- **Authentication:** project-scoped credentials only. Development and production credentials must be separate; KRYLO never retrieves secrets.
- **Allowed environments:** `private-approved`, `production-read-only` (read paths only).
- **Read capabilities:** schema inspection, migration history, local database status.
- **Write capabilities (gated):** local development migrations are normal work. `db reset`, destructive migrations, linked/production `db push`, and any production data write stop at `RISK_APPROVAL_REQUIRED` (see `policies/production-policy.json`).
- **Data egress:** production data never leaves approved boundaries; queries against production require the `production-read-only` profile.
- **Verification:** migration validation runs locally; expand-and-contract sequencing per `docs/15-database-and-infrastructure.md`.
- **Degraded behavior:** without the CLI, schema evidence comes from repository migration files only; report the limitation.
