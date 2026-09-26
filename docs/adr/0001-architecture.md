# ADR 0001: Standalone control plane and explicit trust boundaries

Accepted 2026-09-26. Use Rust/Axum/Tokio/SQLx SQLite, React/Vite/React Flow, and a pure-Go outbound agent. The API serves bundled dashboard assets. Browser sessions and enrollment live behind verified TLS; a dedicated TLS listener verifies optional client certificates and every authenticated agent endpoint requires an active enrolled certificate. Only the enrollment endpoint admits unauthenticated agent requests.

SQLite is single-instance, local disk, WAL, FULL synchronous. Target selectors resolve separately for whole configurations and whole policies. Desired state is materialized only after rollout admission. Immutable version bytes are distinct from canvas layout. Standard Ed25519 signs exact manifest bytes; ECDSA P-256 device CSRs prove possession. No mandatory external service or public-internet runtime dependency.

Self-hosting is a fixed requirement, so this is a conventional software repository rather than a hosted Sites project. Native platform support and production release status are evidence-based. Server-side execution of hostile configurations is unavailable unless an isolated validation worker is configured. Such results remain explicitly unverified.
