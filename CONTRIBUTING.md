# Contributing to Vectory

Thanks for helping. This page has what you need to build Vectory, run its tests and send a change.

## Prerequisites

This table is the one source of toolchain versions; other docs link here.

| Tool | Version | Used by |
| --- | --- | --- |
| Rust | 1.94 (CI uses 1.94.0; the minimum is 1.88) | `server/` |
| Go | 1.26.8 (an older Go fetches it automatically) | `agent/`, `packaging/dev-pki` |
| Node.js | 22.12 or newer | `dashboard/`, `help-center/` |
| Python | 3.11 or newer | `deploy/backup.py`, `packaging/`, some tests |
| Vector | 0.58.0, checksum-verified | Native tests and the local preview |

## Build and run

The quickest way to see everything working is the local demo, on Linux or macOS:

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)
node scripts/demo.mjs --agents 4
```

[docs/dev/DEVELOPMENT.md](docs/dev/DEVELOPMENT.md) explains the preview, the demo fleet, Windows and the browser tests.

## Run the tests

```sh
(cd dashboard && npx tsc -b && npm test)
(cd server && cargo fmt --check && cargo test --locked)
(cd agent && gofmt -l . && go vet ./... && go test ./...)
node --test help-center/scripts/*.test.mjs
```

- Native server tests need `VECTORY_TEST_VECTOR=/path/to/vector`; native agent tests need `VECTOR_TEST_BINARY=/path/to/vector`. Both expect Vector 0.58.0.
- Browser tests live in `dashboard/tests/`, `dashboard/e2e/` and `help-center/tests/`. Run them against the local preview, never against a real installation.
- `cd help-center && npm run build` builds the Help center and checks every link, including the dashboard's links into it.

## Make a change

- Keep changes focused, and add tests for new behavior: vitest for dashboard logic, `cargo test` for the server, `go test` for the agent.
- If you change an API route or the agent protocol, update `contracts/CONTRACT.md` and `contracts/generate.mjs`, then run `node contracts/generate.mjs` to regenerate `contracts/openapi.json`.
- If you change what users see, update the Help center in `docs/user/`. [docs/dev/WRITING.md](docs/dev/WRITING.md) is the style guide.
- Never commit databases, tokens, private keys, build caches, downloaded archives or real data. Screenshots and examples use synthetic data only.
- In the pull request, describe the behavior before and after, and how you tested it.

The product's design contract is [docs/product-specification.md](docs/product-specification.md); decisions are recorded in [docs/adr/](docs/adr/). `AGENTS.md` holds instructions for AI coding agents working in this repository; you don't need it.

## License and conduct

By contributing, you agree that your contributions are licensed under [Apache-2.0](LICENSE). Follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues as described in [SECURITY.md](SECURITY.md), never in a public issue.
