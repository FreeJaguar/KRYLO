# Adapter: Figma

- **Detection:** Figma MCP present in the session's MCP inventory.
- **Publisher / source:** Figma. Catalog ID: `figma-mcp`.
- **Supported versions:** per reviewed catalog version.
- **Trust tier:** B+.
- **Authentication:** the user's own Figma authentication; scoped tokens preferred.
- **Allowed environments:** `private-approved`, `public-repository`.
- **Read capabilities:** design files explicitly referenced by the task (frames, tokens, components).
- **Write capabilities (gated):** any Figma write (comments, files) requires explicit task intent and approval (`external-write`).
- **Data egress:** design metadata is read from Figma; nothing is written back by default.
- **Verification:** compare implemented UI against the referenced design; screenshot evidence.
- **Degraded behavior:** without Figma access, use the design contract from the task text and existing design-system components; report the missing reference.
- **Use rule:** used only when the task provides an explicit design reference.
