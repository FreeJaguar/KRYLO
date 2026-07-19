# Adapter: Superpowers

- **Detection:** Superpowers plugin present in the session's plugin inventory.
- **Publisher / source:** community. Catalog ID: `superpowers`.
- **Supported versions:** per reviewed catalog version.
- **Trust tier:** B. Optional compatibility, never a dependency.
- **Authentication:** none.
- **Allowed environments:** all profiles (local skills, no network).
- **Read capabilities:** selected workflow skills (for example brainstorming or plan-writing) may be invoked when genuinely useful.
- **Write capabilities:** none beyond what the invoked skill's own policy allows.
- **Data egress:** none.
- **Verification:** KRYLO's own completion contract and gates always apply; a Superpowers skill result is input, not authority.
- **Degraded behavior:** KRYLO works fully without Superpowers.
- **Control rule:** KRYLO remains the orchestrator. Superpowers, Ralph, Archon, Ruflo, BMAD, OpenSpec, Spec Kit, and similar systems never control KRYLO (doctor reports conflicting hooks or routing).
