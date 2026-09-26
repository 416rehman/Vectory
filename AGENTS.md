# Vectory implementation ownership

This is the dedicated Vectory repository. Follow the implementation contract in docs/product-specification.md.

Use https://vector.dev/docs/ as the primary upstream technical reference. Topic links and version-checking guidance are in docs/VECTOR-REFERENCES.md; dashboard visual direction is in docs/DESIGN.md.

- Lead: dashboard/, contracts/, vector-catalog/, integration tests, overall integration.
- Backend agent: server/ (including migrations and server tests).
- Agent workstream: agent/ and native agent tests.
- Security/release: deploy/, packaging/, .github/, operational docs, independent review.

Do not change another workstream's owned files without coordination. Shared API decisions are in contracts/CONTRACT.md. Notify the lead before changing a route or wire format. Never use fabricated fleet data in the ordinary product. An explicitly labeled synthetic demo may be separate. Never report file write/download as verified activation.
