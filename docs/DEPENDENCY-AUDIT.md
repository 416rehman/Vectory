# Dependency audit evidence

Scans ran on 2026-09-26 against development source. They identify known dependency advisories, not all application defects. Repeat them for the exact release commit and image; container/base-image scanning is still an unexecuted gate on this host.

The dashboard's pinned lockfile passed `npm audit --json` with zero reported vulnerabilities (206 dependency entries). This does not establish application security or license clearance.

The Go agent passed `GOTOOLCHAIN=go1.26.8 go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...` with “No vulnerabilities found” for the Windows amd64 build graph on this host. This is the final toolchain pin, rather than the older system Go installation. Source changes after a scan require another release check; CI runs the same pinned scanner on its configured native OS jobs, which have not executed here.

Rust `cargo-audit` 0.22.2 used RustSec database commit `e2111519ba6d14a5da59a7b2e5c8083ae8a37c01`, updated 2026-09-25. The initial scan found `time` 0.3.45 affected by [RUSTSEC-2026-0009](https://rustsec.org/advisories/RUSTSEC-2026-0009.html), plus unmaintained `rustls-pemfile` ([RUSTSEC-2025-0134](https://rustsec.org/advisories/RUSTSEC-2025-0134.html)). The backend updated `time` to 0.3.55 and migrated PEM parsing to `rustls-pki-types`; the repeated scan had no unresolved active finding or maintenance warning.

The complete lockfile still contains `rsa` 0.9.10, an optional SQLx dependency affected by [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html). `cargo tree --locked --manifest-path server/Cargo.toml --target all --invert rsa --prefix none` returned no active dependency tree for the project's selected features. `packaging/audit-rust.py` records this exact version/advisory as inactive only when that all-target proof succeeds. It does not pass a blanket ignore flag to the scanner, delete the finding, or claim that the upstream package is safe. Enabling a feature that compiles RSA causes this gate to fail.

The [raw Rust audit and proof](evidence/rust-dependency-audit.json) preserve the advisory text, dependency versions, database revision, unresolved findings and conditional result. Run the gate with a current database:

```sh
cargo install cargo-audit --version 0.22.2 --locked
python3 packaging/audit-rust.py --out artifacts/rust-dependency-audit.json
```

The generated source SPDX inventory includes inactive lockfile and build/development packages. It is not a compiled-binary or container SBOM, a vulnerability clearance, a license clearance, a signature or provenance attestation. Unknown declared licenses remain `NOASSERTION` for maintainer review.
