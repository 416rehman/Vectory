# Work board

| Owner | Boundaries | Acceptance |
|---|---|---|
| Lead / UX | dashboard, contracts, catalog, integration | Real API workflows, graph/code preservation, responsive keyboard-accessible UI, browser checks |
| Rust backend | server | Auth, SQLite durability, enrolled device identity, signed manifests, conflict resolver, scheduler, rollout tests |
| Go agent | agent | TLS/CSR enrollment, manifests, pause/drift, safe journaled apply, negative tests, cross-compilation |
| Security / release | deploy, packaging, CI, docs | Independent actual-code review, reproducible Compose, support/evidence matrix, release prerequisites |

Milestones are the five ordered sections in the product specification. Tests and residual gaps must be recorded in docs/internal/REQUIREMENTS.md; a passing compile is not native deployment evidence.
