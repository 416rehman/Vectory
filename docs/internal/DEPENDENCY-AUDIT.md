# Dependency audit evidence

Source scans began on 2026-09-26 and container-image scans were run on 2026-10-05. They identify known dependency advisories, not all application defects. Repeat them for the exact release commit and images before publication.

The dashboard's pinned lockfile passed `npm audit --json` with zero reported vulnerabilities (206 dependency entries). This does not establish application security or license clearance.

The Go agent passed `GOTOOLCHAIN=go1.26.8 go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...` with “No vulnerabilities found” for the Windows amd64 build graph on this host. This is the final toolchain pin, rather than the older system Go installation. Source changes after a scan require another release check; CI runs the same pinned scanner on its configured native OS jobs.

Rust `cargo-audit` 0.22.2 used RustSec database commit `e2111519ba6d14a5da59a7b2e5c8083ae8a37c01`, updated 2026-09-25. The initial scan found `time` 0.3.45 affected by [RUSTSEC-2026-0009](https://rustsec.org/advisories/RUSTSEC-2026-0009.html), plus unmaintained `rustls-pemfile` ([RUSTSEC-2025-0134](https://rustsec.org/advisories/RUSTSEC-2025-0134.html)). The backend updated `time` to 0.3.55 and migrated PEM parsing to `rustls-pki-types`; the repeated scan had no unresolved active finding or maintenance warning.

A later run of the gate (2026-10-02) failed on a yanked release: `yoke-derive` 0.8.3, reached through the `icu` crates behind `idna` and `url`, was withdrawn from crates.io. `cargo-audit` reports a yanked release as a warning with no advisory, which `packaging/audit-rust.py` did not handle and crashed on. It now names such a warning by package and version, and any warning still fails the gate until someone reviews it. The lockfile moved to `yoke-derive` 0.8.4, and the gate passes again.

The complete lockfile still contains `rsa` 0.9.10, an optional SQLx dependency affected by [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html). `cargo tree --locked --manifest-path server/Cargo.toml --target all --invert rsa --prefix none` returned no active dependency tree for the project's selected features. `packaging/audit-rust.py` records this exact version/advisory as inactive only when that all-target proof succeeds. It does not pass a blanket ignore flag to the scanner, delete the finding, or claim that the upstream package is safe. Enabling a feature that compiles RSA causes this gate to fail.

The [raw Rust audit and proof](../evidence/rust-dependency-audit.json) preserve the advisory text, dependency versions, database revision, unresolved findings and conditional result. Run the gate with a current database:

```sh
cargo install cargo-audit --version 0.22.2 --locked
python3 packaging/audit-rust.py --out artifacts/rust-dependency-audit.json
```

`packaging/audit-npm.py` is the same kind of gate for the npm packages that ship. It runs `npm audit --omit=dev --json` in `dashboard/` and in `help-center/`, and fails on any high or critical advisory that `packaging/npm-audit-exceptions.json` does not acknowledge. Packages that only build or test the code (`devDependencies`) are not audited.

The gate judges advisories, not packages. npm flags every package that depends on a vulnerable one, so a single advisory can flag five packages. The gate counts that advisory once, and an exception for it covers the packages that depend on it. A package with an advisory of its own is judged on that advisory.

An exception names a directory, a GHSA id and a package, with a reason and an expiry date (`YYYY-MM-DD`). It excuses exactly that advisory in that package of that directory. The same advisory in the other directory, another advisory in the same package and the same advisory in another package all stay active. An exception holds through its expiry date. After that the gate fails until someone reviews the entry and renews it with a new date and reason, or deletes it, even when the advisory has gone. An exception whose advisory no longer appears is reported as stale, which is a warning.

Nothing is hidden. `npm-dependency-audit.json` keeps each directory's raw audit whole, with the acknowledged findings and their reasons, the active findings, the expired and stale exceptions and `gate_passed`. A scanner or network failure is not a pass. The gate fails on an `npm` that exits with anything but 0 or 1, on output that is not an audit report (npm prints an error as JSON and exits 1), and on a package flagged high or critical with no such advisory behind it. Run it, and its unit tests, which use a stub `npm`:

```sh
python3 packaging/audit-npm.py --out artifacts/npm-dependency-audit.json
python3 packaging/test_audit_npm.py
```

The help center has one exception. A run on 2026-10-03 found five high findings in `help-center/`, all from one advisory. `astro` 7.3.5 and `@astrojs/starlight` 0.42.4 are `dependencies`, and `astro` depends on `http-cache-semantics` 4.2.0, which carries [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) (high: max-stale handling can disclose cross-user cached responses). The advisory affects every release of the package. On that date 4.2.0 and `astro` 7.3.5 were the latest, so there was nothing to update to. Astro uses the package only to decide how long it may keep a downloaded remote image (`astro/dist/assets/build/remote.js`), and the help center uses no remote image.

Nothing that ships contains it. `help-center/scripts/build.mjs` writes static files and copies them to `dashboard/dist/help`. In `deploy/Dockerfile`, the `dashboard` stage installs the help center's packages, and the Debian 13 `runtime` stage has no Node and copies only `dashboard/dist` from it. After a build, `grep -rIl http-cache-semantics dashboard/dist` prints nothing. The exception expires on 2026-12-31.

`astro` and `@astrojs/starlight` stay in `dependencies`. Their client scripts are bundled into the shipped pages, and the SBOM of what ships should list them. To review the exception, look for a patched `http-cache-semantics` or an `astro` that no longer needs it (`npm view http-cache-semantics version`, `npm view astro dependencies.http-cache-semantics`). Then update the lockfile and delete the entry, or renew it with a new date and a reason checked against the Dockerfile again.

The generated source SPDX inventory includes inactive lockfile and build/development packages. It is not a compiled-binary or container SBOM, a vulnerability clearance, a license clearance, a signature or provenance attestation. Unknown declared licenses remain `NOASSERTION` for maintainer review.

## Container images

On 2026-10-05, Trivy 0.75.0 scanned the `docker save` archives from the successful `e5fef0e` release-candidate image job, using its vulnerability database updated at 01:10 UTC and `image --input` with vulnerability scanning enabled. Both archives matched the complete candidate's copies by SHA-256. The server image (Debian 13.7) had 315 records: no critical, 72 high across 20 distinct CVE IDs, 116 medium, 121 low and six unknown. The validator image (Debian 13.7) had 178 records: no critical, 45 high across eight distinct CVE IDs, 61 medium, 70 low and two unknown. None of the high records had a Trivy `FixedVersion`. These are package records, not 72 or 45 distinct exploitable paths. The same scanner found critical records in the earlier Debian 12 server and unpatched validator images; moving the server runtime to pinned Debian 13 and upgrading installed packages in both final stages removed those critical records.

The remaining high records include issues in util-linux's `mount` and `nsenter` commands, systemd-homed, ncurses `infocmp`, Perl `Archive::Tar`, Python XML/tar/HTML/TLS APIs, libexpat, libacl and curl/libcurl. The containers run their main processes without root; the server's curl call is a fixed HTTP request to its own health endpoint, and its packaged Python backup script does not parse XML or tar archives. Those observations narrow exposure; they are not a claim that the packages are patched or that all scanner findings are unreachable. Debian still lists the relevant [util-linux](https://security-tracker.debian.org/tracker/source-package/util-linux), [curl](https://security-tracker.debian.org/tracker/source-package/curl), [expat](https://security-tracker.debian.org/tracker/source-package/expat) and [acl](https://security-tracker.debian.org/tracker/source-package/acl) issues in trixie. Security/release owns re-scanning the exact publication images with a current database, taking Debian security updates as they appear, and reviewing any newly fixed or newly critical record before publication.

The Compose proxy is a third image, pinned directly in `deploy/compose.yaml`; it is not in the two-image release-candidate archive. The earlier `caddy:2.10.2-alpine` pin had six critical and 77 high Trivy records across Alpine packages and the Caddy Go binary, many with fixes. On 2026-10-05, the official multi-platform `caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9` reference scanned with zero critical and zero high records using the same Trivy version and database. The scan is a point-in-time advisory check, not a guarantee of safety. Caddy [2.11.7 fixes two 2.11.6 regressions](https://github.com/caddyserver/caddy/releases/tag/v2.11.7), but its official Docker tag was unavailable on that date. Recheck for the updated official tag and scan all three exact image references with a current database before publication; the Compose TLS/health integration test must pass on the selected proxy.
