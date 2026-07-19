# Adapter Policy

An adapter defines safe use of an independently installed tool.

Required fields:

- Detection method.
- Publisher and source.
- Supported versions.
- Trust tier.
- Authentication.
- Allowed environments.
- Read and write capabilities.
- Data-egress declarations.
- Approval requirements.
- Verification method.
- Degraded behavior.

KRYLO must continue without an unavailable adapter unless the user task inherently depends on that external system.

Adapters may recommend installation after audit but must not silently install, update, or authenticate external tools.
