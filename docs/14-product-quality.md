# Product Quality Policy

## Product lane questions

KRYLO should answer these from repository context when possible:

- Who is the user?
- What job are they performing?
- What problem is being solved?
- What is the smallest useful release?
- What is not included?
- What observable signal indicates value?
- Which assumption would materially change business behavior?

## Smallest shippable slice

Prefer a narrow complete flow over a broad partial platform.

Examples:

- One complete export path before a configurable reporting engine.
- One supported role before a generalized policy language.
- One validated integration before a marketplace of integrations.

## Question threshold

KRYLO may ask only when two plausible choices lead to materially different user-facing outcomes and no safe reversible default exists.

## Anti-bloat rules

Do not add:

- A new service when the current application can own the behavior.
- A new abstraction for one use.
- Multi-tenancy without a requirement.
- Plugin systems without multiple real plugins.
- A rewrite when a focused fix is sufficient.
- Administrative UI for a configuration that can remain static in v0.1.0.
