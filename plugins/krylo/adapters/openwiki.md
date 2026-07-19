# Adapter: OpenWiki

- **Detection:** detection only — an OpenWiki installation or generated wiki directory is reported by doctor; nothing is invoked by default.
- **Publisher / source:** community. Catalog ID: `openwiki`.
- **Supported versions:** per reviewed catalog version.
- **Trust tier:** B. **Disabled by default** (ADR-0010).
- **Authentication:** requires an approved inference provider; personal mode and personal connectors are never allowed.
- **Allowed environments:** `private-approved`, `public-repository`, and only after explicit provider and repository approval.
- **Read capabilities:** generated repository documentation, with its source revision recorded.
- **Write capabilities:** none by KRYLO Core.
- **Data egress:** repository content may reach the inference provider; that is exactly why per-repository approval is required.
- **Verification:** generated content is never a source of truth above code, tests, schemas, or migrations; mark content stale when the repository diverges from the recorded source revision.
- **Degraded behavior:** KRYLO works fully without OpenWiki.
