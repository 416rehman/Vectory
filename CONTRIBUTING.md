# Contributing

Read AGENTS.md, docs/product-specification.md and contracts/CONTRACT.md before editing. Coordinate wire-format and ownership changes. Add meaningful regression tests for behavior/security changes, preserve unknown configuration semantics, and never substitute fabricated fleet data in ordinary product screens.

Use Rust 1.94.0 (`cargo test --locked` in server), Go 1.26.6 (`go test ./...` and `go vet ./...` in agent), Node 22 (`npm ci` and `npm run build` in dashboard), and Python 3.11+ (`python -m unittest discover -s tests/security`). Keep lockfiles reviewed. See docs/QUICKSTART.md for deployment and packaging/README.md for release gates. Native tests are separate from cross-compilation.

Contributions are submitted under Apache-2.0. Explain the concrete before/after behavior and validation in a pull request. Do not commit state databases, tokens, private keys, build caches, downloaded tool archives or customer data. Follow CODE_OF_CONDUCT.md and SECURITY.md for sensitive reports.
